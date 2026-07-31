import type { GwsClient } from "../gws-client.js";
import { jsonResponse, deleteResponse, deleteDriveFile } from "./response.js";

export const sheetsTools = [
  {
    name: "sheets_read",
    description:
      "Read data from a Google Sheets spreadsheet. Returns cell values for the specified range.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheet_id: {
          type: "string",
          description: "The spreadsheet ID (from the URL)",
        },
        range: {
          type: "string",
          description:
            "Cell range in A1 notation (e.g., \"Sheet1!A1:D10\", \"A1:Z\")",
        },
      },
      required: ["spreadsheet_id", "range"],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "sheets_update",
    description:
      "Update specific cells in a Google Sheets spreadsheet. Overwrites existing values in the specified range.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheet_id: {
          type: "string",
          description: "The spreadsheet ID",
        },
        range: {
          type: "string",
          description: "Cell range in A1 notation (e.g., \"Sheet1!A1:B2\")",
        },
        values: {
          type: "array",
          items: {
            type: "array",
            items: { type: "string" },
          },
          description:
            "2D array of values to write (rows of columns), e.g., [[\"A1\",\"B1\"],[\"A2\",\"B2\"]]",
        },
      },
      required: ["spreadsheet_id", "range", "values"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "sheets_append",
    description:
      "Append rows to the end of a Google Sheets spreadsheet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheet_id: {
          type: "string",
          description: "The spreadsheet ID",
        },
        values: {
          type: "array",
          items: {
            type: "array",
            items: { type: "string" },
          },
          description:
            "2D array of rows to append, e.g., [[\"val1\",\"val2\"],[\"val3\",\"val4\"]]",
        },
        range: {
          type: "string",
          description:
            "Target range for appending (default: first sheet). e.g., \"Sheet1!A1\"",
        },
      },
      required: ["spreadsheet_id", "values"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "sheets_create",
    description: "Create a new Google Sheets spreadsheet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Title for the new spreadsheet",
        },
        headers: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional header row values, e.g., [\"Name\", \"Email\", \"Date\"]",
        },
      },
      required: ["title"],
    },
    // A write, but not destructive: it creates a new file and cannot
    // overwrite or remove existing data.
    annotations: { destructiveHint: false, readOnlyHint: false },
  },
  {
    name: "sheets_add_tab",
    description:
      "Add a new tab (sheet) to an existing Google Sheets spreadsheet. Use sheets_create to make a whole new spreadsheet file; use this to add a tab inside one. Returns the new tab's sheetId and title.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheet_id: {
          type: "string",
          description: "The spreadsheet ID",
        },
        title: {
          type: "string",
          description: "Title for the new tab",
        },
        headers: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional header row values written to row 1 of the new tab, e.g., [\"Name\", \"Email\", \"Date\"]",
        },
      },
      required: ["spreadsheet_id", "title"],
    },
    annotations: { destructiveHint: false, readOnlyHint: false },
  },
  {
    name: "sheets_delete",
    description:
      "Delete a Google Sheets spreadsheet. This permanently removes the file from Drive.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheet_id: {
          type: "string",
          description: "The spreadsheet ID to delete",
        },
      },
      required: ["spreadsheet_id"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
];

/* ----------------------- range / tab error helpers ------------------------ */

/** The sheet-name prefix of an A1 range ("'Q3 Data'!A1:B2" → "Q3 Data",
 * "Sheet1!A:A" → "Sheet1"), or undefined when the range has no tab prefix.
 * A doubled single quote inside a quoted name is the A1 escape for one. */
export function tabNameFromRange(range: string): string | undefined {
  const quoted = /^'((?:[^']|'')*)'!/.exec(range);
  if (quoted) return quoted[1].replace(/''/g, "'");
  // A leading quote that didn't match is an unterminated/garbled quoted
  // prefix — not a bare tab name for the fallback below to mangle.
  if (range.startsWith("'")) return undefined;
  const bang = range.indexOf("!");
  return bang > 0 ? range.slice(0, bang) : undefined;
}

/** A tab title as it must appear inside an A1 range: quoted, with internal
 * single quotes doubled. */
export function quoteTabForRange(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

const UNPARSEABLE_RANGE = /unable to parse range/i;

/** Google reports a range naming a missing tab as a SYNTAX error ("Unable to
 * parse range: …"), which sends users off to rewrite perfectly valid A1
 * notation. When the failed range names a tab, look up the spreadsheet's real
 * tab list and say what is actually wrong — and if the named tab does exist
 * (or the range has no tab prefix), the original error stands, because then
 * the syntax genuinely is the problem. */
async function rethrowWithTabContext(
  client: GwsClient,
  spreadsheetId: unknown,
  range: string,
  err: unknown
): Promise<never> {
  const message = err instanceof Error ? err.message : String(err);
  if (!UNPARSEABLE_RANGE.test(message)) throw err;
  const tab = tabNameFromRange(range);
  if (!tab) throw err;
  let titles: string[];
  try {
    const result = await client.api("sheets", "spreadsheets", "get", {
      params: { spreadsheetId, fields: "sheets.properties.title" },
    });
    const data = result.data as {
      sheets?: { properties?: { title?: string } }[];
    };
    titles = (data.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => typeof t === "string");
  } catch {
    throw err;
  }
  if (titles.includes(tab)) throw err;
  throw new Error(
    `No sheet named "${tab}" in this spreadsheet. Existing tabs: ` +
      `${titles.map((t) => `"${t}"`).join(", ") || "(none)"}. ` +
      `Create it first with sheets_add_tab.`
  );
}

const APPEND_DEFAULT_RANGE = "Sheet1!A1";

/** The A1 range a Sheets call addresses, so the seam in `handleSheets` can
 * explain missing-tab failures for every ranged call — including
 * sheets_add_tab's own header write — without each case wrapping itself. */
function rangeInvolvedIn(
  toolName: string,
  args: Record<string, unknown>
): string | undefined {
  if (typeof args.range === "string") return args.range;
  if (toolName === "sheets_append") return APPEND_DEFAULT_RANGE;
  if (toolName === "sheets_add_tab" && typeof args.title === "string") {
    return `${quoteTabForRange(args.title)}!A1`;
  }
  return undefined;
}

export async function handleSheets(
  client: GwsClient,
  toolName: string,
  args: Record<string, unknown>
) {
  try {
    return await dispatchSheets(client, toolName, args);
  } catch (err) {
    const range = rangeInvolvedIn(toolName, args);
    if (!range) throw err;
    await rethrowWithTabContext(client, args.spreadsheet_id, range, err);
    throw err;
  }
}

async function dispatchSheets(
  client: GwsClient,
  toolName: string,
  args: Record<string, unknown>
) {
  switch (toolName) {
    case "sheets_read": {
      const result = await client.api(
        "sheets",
        "spreadsheets.values",
        "get",
        {
          params: {
            spreadsheetId: args.spreadsheet_id,
            range: args.range,
          },
        }
      );
      const data = result.data as Record<string, unknown>;
      const values = (data.values as string[][] | undefined) || [];
      const columnCount = values.reduce((max, row) => Math.max(max, row.length), 0);
      const normalized = values.map((row) =>
        row.length < columnCount
          ? [...row, ...Array(columnCount - row.length).fill("")]
          : row
      );
      return jsonResponse({
        range: data.range,
        rowCount: normalized.length,
        columnCount,
        values: normalized,
      });
    }

    case "sheets_update": {
      const result = await client.api(
        "sheets",
        "spreadsheets.values",
        "update",
        {
          params: {
            spreadsheetId: args.spreadsheet_id,
            range: args.range,
            valueInputOption: "USER_ENTERED",
          },
          jsonBody: {
            values: args.values,
          },
        }
      );
      return jsonResponse(result.data);
    }

    case "sheets_append": {
      const range = (args.range as string) || APPEND_DEFAULT_RANGE;
      const result = await client.api(
        "sheets",
        "spreadsheets.values",
        "append",
        {
          params: {
            spreadsheetId: args.spreadsheet_id,
            range,
            valueInputOption: "USER_ENTERED",
            insertDataOption: "INSERT_ROWS",
          },
          jsonBody: {
            values: args.values,
          },
        }
      );
      return jsonResponse(result.data);
    }

    case "sheets_create": {
      const body: Record<string, unknown> = {
        properties: { title: args.title },
      };
      if (args.headers) {
        const headers = args.headers as string[];
        body.sheets = [{
          data: [{
            rowData: [{
              values: headers.map((h) => ({
                userEnteredValue: { stringValue: h },
              })),
            }],
          }],
        }];
      }
      const result = await client.api("sheets", "spreadsheets", "create", {
        jsonBody: body,
      });
      const d = result.data as Record<string, unknown>;
      return jsonResponse({
        spreadsheetId: d.spreadsheetId,
        title: (d.properties as Record<string, unknown>)?.title,
        spreadsheetUrl: d.spreadsheetUrl,
      });
    }

    case "sheets_add_tab": {
      const title = args.title as string;
      const result = await client.api("sheets", "spreadsheets", "batchUpdate", {
        params: { spreadsheetId: args.spreadsheet_id },
        jsonBody: {
          requests: [{ addSheet: { properties: { title } } }],
        },
      });
      const data = result.data as {
        replies?: {
          addSheet?: { properties?: { sheetId?: number; title?: string } };
        }[];
      };
      const props = data.replies?.[0]?.addSheet?.properties ?? {};
      if (args.headers) {
        const headers = args.headers as string[];
        // RAW, not USER_ENTERED: headers are labels and must never be
        // evaluated — "=Total" is a header, not a formula, and "1/2" is a
        // name, not a date. (sheets_create's embedded stringValue headers
        // have the same literal semantics.)
        await client.api("sheets", "spreadsheets.values", "update", {
          params: {
            spreadsheetId: args.spreadsheet_id,
            range: `${quoteTabForRange(title)}!A1`,
            valueInputOption: "RAW",
          },
          jsonBody: { values: [headers] },
        });
      }
      // sheetId is an arbitrary identifier, not a position: the default tab
      // of a fresh spreadsheet is not necessarily id 0, so anything that
      // addresses tabs by id must use the id returned here (or from
      // spreadsheets.get) rather than assuming 0 means "first sheet".
      return jsonResponse({
        sheetId: props.sheetId,
        title: props.title ?? title,
      });
    }

    case "sheets_delete": {
      await deleteDriveFile(client, args.spreadsheet_id);
      return deleteResponse("Spreadsheet");
    }

    default:
      throw new Error(`Unknown Sheets tool: ${toolName}`);
  }
}
