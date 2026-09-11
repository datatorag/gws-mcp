import { describe, expect, it } from "vitest";
import { fakeClient, payload } from "./fake-client.test-helper.js";
import { buildQueryUrl, handleSheetsQuery, parseGvizBody, sheetsQueryTools } from "./sheets-query.js";
import { READ } from "./annotations.js";
import { allTools, toolHandlers } from "./index.js";

/* SCRUM-261: a filtered read is one call. The Visualization query endpoint
 * answers a QUERY()-language query with a JSONP-wrapped table; the tool
 * turns that into header, rows and a count, and turns its errors into
 * ones that name the column. */

const wrap = (json: unknown) => `/*O_o*/\ngoogle.visualization.Query.setResponse(${JSON.stringify(json)});`;

const TABLE = {
  version: "0.6",
  status: "ok",
  sig: "1",
  table: {
    cols: [
      { id: "A", label: "Task", type: "string" },
      { id: "C", label: "Priority", type: "number" },
      { id: "F", label: "Due", type: "date", pattern: "yyyy-MM-dd" },
    ],
    rows: [
      { c: [{ v: "Renew cert" }, { v: 3, f: "3" }, { v: "Date(2026,8,12)", f: "2026-09-12" }] },
      { c: [{ v: "Ship 261" }, { v: 2, f: "2" }, null] },
      { c: [{ v: "Write notes" }, { v: 1, f: "1" }, { v: null }] },
    ],
  },
};

describe("sheets_query (SCRUM-261)", () => {
  it("is a read tool, registered and dispatched like the rest", () => {
    const tool = sheetsQueryTools.find((t) => t.name === "sheets_query");
    expect(tool?.annotations).toEqual(READ("Query a spreadsheet"));
    expect(tool?.inputSchema.required).toEqual(["spreadsheet_id", "query"]);
    expect(allTools.some((t) => t.name === "sheets_query")).toBe(true);
    expect(toolHandlers.get("sheets_query")).toBe(handleSheetsQuery);
  });

  it("select with where and order by returns the subset in the order the endpoint gave, header first", async () => {
    const { client, calls } = fakeClient([{ text: wrap(TABLE) }]);
    const result = payload(
      await handleSheetsQuery(client, "sheets_query", {
        spreadsheet_id: "s",
        range: "Tasks",
        query: "select A, C, F where C > 0 order by C desc",
      })
    );
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url as string);
    expect(url.origin + url.pathname).toBe("https://docs.google.com/spreadsheets/d/s/gviz/tq");
    expect(url.searchParams.get("tq")).toBe("select A, C, F where C > 0 order by C desc");
    expect(url.searchParams.get("tqx")).toBe("out:json");
    expect(url.searchParams.get("headers")).toBe("1");
    expect(url.searchParams.get("sheet")).toBe("Tasks");
    expect(url.searchParams.has("range")).toBe(false);
    expect(result).toEqual({
      query: "select A, C, F where C > 0 order by C desc",
      header: ["Task", "Priority", "Due"],
      rowCount: 3,
      // Dates come back as the formatted text, not the Date(...) form; an
      // empty cell is an empty string so every row has every column.
      rows: [
        ["Renew cert", 3, "2026-09-12"],
        ["Ship 261", 2, ""],
        ["Write notes", 1, ""],
      ],
    });
  });

  it("group by with count returns the aggregate columns, labelled as the endpoint labels them", async () => {
    const { client } = fakeClient([
      {
        text: wrap({
          status: "ok",
          table: {
            cols: [
              { id: "B", label: "Status", type: "string" },
              { id: "count-A", label: "count Task", type: "number" },
            ],
            rows: [
              { c: [{ v: "open" }, { v: 12, f: "12" }] },
              { c: [{ v: "done" }, { v: 30, f: "30" }] },
            ],
          },
        }),
      },
    ]);
    const result = payload(
      await handleSheetsQuery(client, "sheets_query", { spreadsheet_id: "s", query: "select B, count(A) group by B" })
    );
    expect(result.header).toEqual(["Status", "count Task"]);
    expect(result.rows).toEqual([["open", 12], ["done", 30]]);
    expect(result.rowCount).toBe(2);
  });

  it("a query naming a column outside the range is a structured error naming the column", async () => {
    const { client } = fakeClient([
      {
        text: wrap({
          status: "error",
          errors: [
            {
              reason: "invalid_query",
              message: "INVALID_QUERY",
              detailed_message: "Invalid query: NO_COLUMN: Z",
            },
          ],
        }),
      },
    ]);
    await expect(
      handleSheetsQuery(client, "sheets_query", { spreadsheet_id: "s", range: "Tasks!A1:F500", query: "select Z" })
    ).rejects.toThrow(/column Z, which is outside the range Tasks!A1:F500/);
  });

  it("an empty result is an empty rows array with the header, never a bare string", async () => {
    const { client } = fakeClient([
      { text: wrap({ status: "ok", table: { cols: [{ id: "A", label: "Task", type: "string" }], rows: [] } }) },
    ]);
    const result = payload(await handleSheetsQuery(client, "sheets_query", { spreadsheet_id: "s", query: "select A where A = 'nothing'" }));
    expect(result).toEqual({ query: "select A where A = 'nothing'", header: ["Task"], rowCount: 0, rows: [] });
  });

  it("puts a tab and a block on the URL separately, and turns headers off when told", () => {
    const url = new URL(buildQueryUrl("s", "select A", "Tasks!A1:F500", false));
    expect(url.searchParams.get("sheet")).toBe("Tasks");
    expect(url.searchParams.get("range")).toBe("A1:F500");
    expect(url.searchParams.get("headers")).toBe("0");
    const bare = new URL(buildQueryUrl("s", "select A", "A1:B9", true));
    expect(bare.searchParams.has("sheet")).toBe(false);
    expect(bare.searchParams.get("range")).toBe("A1:B9");
    const quoted = new URL(buildQueryUrl("s", "select A", "'Q3 Plan'!A:D", true));
    expect(quoted.searchParams.get("sheet")).toBe("Q3 Plan");
  });

  it("explains a refusal and a missing spreadsheet, and rejects an answer that is not a table", async () => {
    const forbidden = fakeClient([{ status: 403, text: "<html>login</html>" }]);
    await expect(handleSheetsQuery(forbidden.client, "sheets_query", { spreadsheet_id: "s", query: "select A" })).rejects.toThrow(
      /refused the request \(403\)/
    );
    const missing = fakeClient([{ status: 404, text: "" }]);
    await expect(handleSheetsQuery(missing.client, "sheets_query", { spreadsheet_id: "s", query: "select A" })).rejects.toThrow(
      /no spreadsheet with that ID/
    );
    expect(() => parseGvizBody("<html>not a table</html>")).toThrow(/did not answer with a table/);
    const blank = fakeClient([]);
    await expect(handleSheetsQuery(blank.client, "sheets_query", { spreadsheet_id: "s", query: "   " })).rejects.toThrow(
      /query must not be blank/
    );
  });
});
