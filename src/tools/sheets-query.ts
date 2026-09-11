import type { GwsClient } from "../gws-client.js";
import { READ, ToolDef } from "./annotations.js";
import { jsonResponse } from "./response.js";

/**
 * sheets_query (SCRUM-261): the Google Visualization query language over a
 * range, so a filtered read is one call.
 *
 * Sheets has a SQL-like language, the same one a QUERY() cell runs: select,
 * where, group by, pivot, order by, limit, offset, label, format, and the
 * aggregates count, sum, avg, min, max. The Sheets REST API has no query
 * endpoint, so this goes to the Visualization API's tq endpoint with the
 * caller's own access token, which is read-only and touches nothing in the
 * file. The other route, a QUERY() formula written into a scratch cell and
 * read back, was rejected: it edits the user's file to answer a read.
 *
 * Columns are addressed by letter, as in a QUERY() cell, and the letter is
 * the sheet's column, not the range's: "select A, D where I = 'open'"
 * means the sheet's A, D and I even when the range starts at C.
 */

const GVIZ_HOST = "https://docs.google.com";

export const sheetsQueryTools: ToolDef[] = [
  {
    name: "sheets_query",
    description:
      "Run a query in the Google Sheets QUERY() language over a spreadsheet range and get back only the matching rows, in ONE call. Use this instead of reading a whole tab and filtering the values yourself: select A, D where I = 'open' order by A desc limit 20 returns the twenty rows you wanted and nothing else. The language supports select, where, group by, pivot, order by, limit, offset, label and format, with count, sum, avg, min and max. Columns are addressed by their SHEET letter (A, B, C), the same letter the column has in the tab, not its position inside the range. Text values are compared with quotes: where B = 'high' or where B contains 'urgent'. Read-only: nothing in the spreadsheet changes. The result carries the header the query produced, the rows, the row count and the echoed query; an empty match is an empty rows array.",
    inputSchema: {
      type: "object",
      properties: {
        spreadsheet_id: {
          type: "string",
          description: "The spreadsheet ID",
        },
        query: {
          type: "string",
          description:
            "The query, in the QUERY() language, e.g. \"select A, C, F where F = 'open' and C > 3 order by C desc\" or \"select B, count(A) group by B\". Columns by sheet letter; strings in single quotes.",
        },
        range: {
          type: "string",
          description:
            'What the query runs over: a tab name on its own queries that whole tab (the simplest correct call), or A1 notation naming a real tab, e.g. "TabName!A1:F500". Omitted, the first tab is queried.',
        },
        has_header_row: {
          type: "boolean",
          description:
            "Default true: the first row of the range is headers, so the result names its columns by those headers and the header row is never returned as data. Set false when the range is pure data; columns are then named by letter.",
        },
      },
      required: ["spreadsheet_id", "query"],
    },
    annotations: READ("Query a spreadsheet"),
  },
];

type GvizCol = { id?: string; label?: string; type?: string };
type GvizCell = { v?: unknown; f?: string } | null;
type GvizTable = { cols?: GvizCol[]; rows?: Array<{ c?: GvizCell[] }> };
type GvizResponse = {
  status?: string;
  errors?: Array<{ reason?: string; message?: string; detailed_message?: string }>;
  table?: GvizTable;
};

/** Splits "Tab!A1:D9" into the tab and the cell block; a bare name is a tab
 * with no block, and a bare block is the first tab. */
function splitRange(range: string | undefined): { sheet?: string; block?: string } {
  if (!range || range.trim() === "") return {};
  const s = range.trim();
  const bang = s.lastIndexOf("!");
  if (bang === -1) {
    // A bare A1 block has a digit or a colon; anything else is a tab name.
    return /^[A-Za-z]{1,3}[0-9]*(:[A-Za-z]{1,3}[0-9]*)?$/.test(s) ? { block: s } : { sheet: s };
  }
  const sheet = s.slice(0, bang).replace(/^'(.*)'$/, "$1");
  const block = s.slice(bang + 1);
  return { sheet, ...(block ? { block } : {}) };
}

/** The tq endpoint URL for one query. Exported for the tests, which pin
 * the parameters because a wrong one fails silently as an empty table. */
export function buildQueryUrl(spreadsheetId: string, query: string, range: string | undefined, hasHeader: boolean): string {
  const url = new URL(`${GVIZ_HOST}/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/gviz/tq`);
  url.searchParams.set("tqx", "out:json");
  url.searchParams.set("tq", query);
  url.searchParams.set("headers", hasHeader ? "1" : "0");
  const { sheet, block } = splitRange(range);
  if (sheet) url.searchParams.set("sheet", sheet);
  if (block) url.searchParams.set("range", block);
  return url.toString();
}

/** The endpoint answers with a JSONP wrapper around the JSON; this is the
 * JSON. Anything that does not fit the wrapper is an error the caller reads
 * whole, capped so a login page cannot flood the context. */
export function parseGvizBody(text: string): GvizResponse {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`sheets_query: the query endpoint did not answer with a table: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text.slice(start, end + 1)) as GvizResponse;
}

/** One cell as a plain value: the formatted text for dates and times (the
 * raw form is a constructor call, not a value), the typed value otherwise,
 * and an empty string for an empty cell so every row has every column. */
function cellValue(cell: GvizCell, type: string | undefined): unknown {
  if (cell === null || cell === undefined || cell.v === null || cell.v === undefined) return "";
  if ((type === "date" || type === "datetime" || type === "timeofday") && typeof cell.f === "string") return cell.f;
  return cell.v;
}

const NO_COLUMN = /NO_COLUMN:\s*([A-Za-z]+)/;

export async function runSheetsQuery(client: GwsClient, args: Record<string, unknown>) {
  const spreadsheetId = args.spreadsheet_id as string;
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query === "") throw new Error("sheets_query: query must not be blank.");
  const range = typeof args.range === "string" ? args.range : undefined;
  const hasHeader = args.has_header_row !== false;

  const url = buildQueryUrl(spreadsheetId, query, range, hasHeader);
  const { status, text } = await client.fetchText(url);
  if (status === 401 || status === 403) {
    throw new Error(
      `sheets_query: the query endpoint refused the request (${status}). The account needs read access to the spreadsheet.`
    );
  }
  if (status === 404) {
    throw new Error("sheets_query: no spreadsheet with that ID is readable by this account.");
  }
  const body = parseGvizBody(text);

  if (body.status === "error" || !body.table) {
    const first = body.errors?.[0];
    const detail = first?.detailed_message ?? first?.message ?? "the query was rejected";
    const missing = NO_COLUMN.exec(detail)?.[1];
    if (missing) {
      throw new Error(
        `sheets_query: the query names column ${missing}, which is outside the range${range ? ` ${range}` : ""}. Columns are sheet letters; check the range covers ${missing}.`
      );
    }
    throw new Error(`sheets_query: ${first?.reason ?? "error"}: ${detail}`);
  }

  const cols = body.table.cols ?? [];
  const header = cols.map((c, i) => (c.label && c.label.trim() !== "" ? c.label : c.id ?? String.fromCharCode(65 + i)));
  const rows = (body.table.rows ?? []).map((r) => cols.map((c, i) => cellValue(r.c?.[i] ?? null, c.type)));
  return jsonResponse({ query, header, rowCount: rows.length, rows });
}

export async function handleSheetsQuery(client: GwsClient, toolName: string, args: Record<string, unknown>) {
  switch (toolName) {
    case "sheets_query":
      return await runSheetsQuery(client, args);
    default:
      throw new Error(`Unknown Sheets query tool: ${toolName}`);
  }
}
