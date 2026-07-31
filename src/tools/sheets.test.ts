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

function payload(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe("tabNameFromRange", () => {
  it("parses a bare tab prefix", () => {
    expect(tabNameFromRange("Sheet1!A1:D10")).toBe("Sheet1");
  });

  it("parses a quoted tab with spaces", () => {
    expect(tabNameFromRange("'MCP Inventory'!A1:B1")).toBe("MCP Inventory");
  });

  it("unescapes doubled quotes inside a quoted tab", () => {
    expect(tabNameFromRange("'Bob''s Data'!A1")).toBe("Bob's Data");
  });

  it("returns undefined when the range has no tab prefix", () => {
    expect(tabNameFromRange("A1:Z")).toBeUndefined();
  });

  it("returns undefined for an unterminated quoted prefix", () => {
    expect(tabNameFromRange("'Broken!A1")).toBeUndefined();
  });
});

describe("quoteTabForRange", () => {
  it("quotes and escapes for A1 use", () => {
    expect(quoteTabForRange("Bob's Data")).toBe("'Bob''s Data'");
  });
});

describe("sheets_add_tab", () => {
  it("is registered as a non-destructive write with the expected inputs", () => {
    const tool = sheetsTools.find((t) => t.name === "sheets_add_tab");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema.required).toEqual(["spreadsheet_id", "title"]);
    expect(tool?.annotations).toEqual({
      destructiveHint: false,
      readOnlyHint: false,
    });
  });

  it("sheets_create is likewise a write that destroys nothing", () => {
    const tool = sheetsTools.find((t) => t.name === "sheets_create");
    expect(tool?.annotations).toEqual({
      destructiveHint: false,
      readOnlyHint: false,
    });
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
    // The API assigns an arbitrary id — nothing may assume 0 is "first".
    expect(payload(result)).toEqual({ sheetId: 852183133, title: "Inventory" });
  });

  it("writes headers to row 1 of the new tab, range-quoted", async () => {
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
    expect(calls[1]).toMatchObject({
      resource: "spreadsheets.values",
      method: "update",
      params: { range: "'Q3 Data'!A1", valueInputOption: "USER_ENTERED" },
      jsonBody: { values: [["Name", "Owner"]] },
    });
  });
});

describe("missing-tab error context", () => {
  const parseFailure =
    'API error: {"error":{"code":400,"message":"Unable to parse range: MCP Inventory!A1:B1","status":"INVALID_ARGUMENT"}}';

  it("names the missing tab and lists the ones that exist", async () => {
    const { client } = fakeClient([
      { throws: parseFailure },
      { data: { sheets: [{ properties: { title: "Sheet1" } }, { properties: { title: "Notes" } }] } },
    ]);

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

  it("covers sheets_read and sheets_append the same way", async () => {
    for (const [tool, args] of [
      ["sheets_read", { spreadsheet_id: "s", range: "Ghost!A1" }],
      ["sheets_append", { spreadsheet_id: "s", range: "Ghost!A1", values: [["x"]] }],
    ] as const) {
      const { client } = fakeClient([
        { throws: "Unable to parse range: Ghost!A1" },
        { data: { sheets: [{ properties: { title: "Sheet1" } }] } },
      ]);
      await expect(handleSheets(client, tool, { ...args })).rejects.toThrow(
        'No sheet named "Ghost"'
      );
    }
  });

  it("keeps the original error when the named tab actually exists", async () => {
    const { client } = fakeClient([
      { throws: parseFailure },
      { data: { sheets: [{ properties: { title: "MCP Inventory" } }] } },
    ]);

    await expect(
      handleSheets(client, "sheets_update", {
        spreadsheet_id: "s",
        range: "MCP Inventory!A1:B1",
        values: [["a"]],
      })
    ).rejects.toThrow("Unable to parse range");
  });

  it("keeps the original error when the range has no tab prefix", async () => {
    const { client, calls } = fakeClient([
      { throws: "Unable to parse range: A1:ZZZ99" },
    ]);

    await expect(
      handleSheets(client, "sheets_read", { spreadsheet_id: "s", range: "A1:ZZZ99" })
    ).rejects.toThrow("Unable to parse range");
    expect(calls).toHaveLength(1); // no tab lookup attempted
  });

  it("keeps the original error when the tab lookup itself fails", async () => {
    const { client } = fakeClient([
      { throws: parseFailure },
      { throws: "API error: permission denied" },
    ]);

    await expect(
      handleSheets(client, "sheets_update", {
        spreadsheet_id: "s",
        range: "MCP Inventory!A1",
        values: [["a"]],
      })
    ).rejects.toThrow("Unable to parse range");
  });

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
