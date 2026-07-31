import { describe, expect, it, vi } from "vitest";
import type { GwsClient } from "../gws-client.js";
import {
  handleSheets,
  quoteTabForRange,
  sheetsTools,
  tabNameFromRange,
} from "./sheets.js";

/** A GwsClient stand-in: `calls` records every api() invocation, `plan`
 * decides each call's fate in order. */
function fakeClient(
  plan: Array<{ data?: unknown; throws?: string }>
): { client: GwsClient; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const api = vi.fn(async (service, resource, method, opts) => {
    calls.push({ service, resource, method, ...opts });
    const step = plan.shift();
    if (!step) throw new Error("fake client: no planned response left");
    if (step.throws) throw new Error(step.throws);
    return { success: true, data: step.data };
  });
  return { client: { api } as unknown as GwsClient, calls };
}

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

  it.each(["sheets_add_tab", "sheets_create"])(
    "%s is a write that destroys nothing",
    (name) => {
      const tool = sheetsTools.find((t) => t.name === name);
      expect(tool?.annotations).toMatchObject({
        destructiveHint: false,
        readOnlyHint: false,
      });
    }
  );

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
    expect(JSON.parse(result.content[0].text)).toEqual({
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
