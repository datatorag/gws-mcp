import type { GwsClient } from "../gws-client.js";
import { CREATE, MUTATE, READ, ToolDef } from "./annotations.js";
import { jsonResponse, deleteResponse, deleteDriveFile } from "./response.js";

/** Values whose first character makes Sheets treat the cell as a formula.
 *
 * Measured against the live API rather than taken from the CSV-injection
 * folklore: `=1+1` and `+1+1` both evaluate; `-1-1`, `@SUM(1,2)` and a leading
 * space did not. Widening to `-` would mangle every negative number, so the
 * guard is these two.
 *
 * TWO LIMITS ON THAT MEASUREMENT, both worth knowing before trusting it:
 *
 * 1. `-` and `@` were probed with arithmetic, not with a network-reaching
 *    function. If a future probe shows `-IMPORTXML(...)` evaluating, this list
 *    is wrong and should widen.
 * 2. It is about SHEETS. A sheet exported to CSV or XLSX and opened in Excel
 *    or LibreOffice does execute `-` and `@` prefixes, so this guard does not
 *    make an exported file safe.
 */
const FORMULA_PREFIXES = ["=", "+"];

/** Sheets' own escape: a leading apostrophe forces the literal, and the
 * apostrophe is not part of the stored value — a read gives back the original
 * string. That is what makes this safe to apply by default rather than an
 * edit the caller has to undo.
 *
 * Tested on the first VISIBLE character, not the raw first character, and the
 * class is deliberately wider than the measurement.
 *
 * What was measured: a plain leading space is inert, and U+FEFF is NOT, a
 * BOM-prefixed formula executes. U+FEFF is a format character (Cf), not
 * Unicode whitespace, so that one result is evidence that Sheets skips
 * leading zero-width characters before it parses. Matching only \s would
 * catch U+FEFF by an ECMAScript accident (it folds the BOM into \s for
 * historical reasons) while letting ZWSP, ZWNJ, ZWJ, WORD JOINER, SOFT
 * HYPHEN and the bidi marks walk straight through.
 *
 * ZWSP and the rest were NOT re-measured against the live API. The class is
 * wide on purpose: the escape is lossless, so a false positive costs one
 * apostrophe that Sheets strips on read, and a false negative is an
 * injection. When the cost is that asymmetric, guess wide. Cc is in for the
 * same reason and on the same (absent) evidence — no real cell value starts
 * with a control character, so including it costs nothing and excluding it
 * would only be consistent with a narrower rule than the one above. */
function escapeFormula(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const firstVisible = value.replace(/^[\s\p{Cf}\p{Zs}\p{Cc}]+/u, "");
  return FORMULA_PREFIXES.some((p) => firstVisible.startsWith(p))
    ? `'${value}`
    : value;
}

/**
 * Neutralise formula injection on the way in.
 *
 * An agent writing to a sheet is usually writing text it picked up somewhere
 * else — an email, a shared doc, a web page — none of which the sheet's owner
 * controls. Sheets formulas reach the network (`IMPORTXML`, `IMPORTDATA`,
 * `IMAGE`), so a value that begins with `=` turns "log this message in my
 * tracker" into an exfiltration primitive aimed at whatever that sheet can
 * see. The caller never asked for a formula and, before this, had no way to
 * decline one.
 *
 * Escaping rather than switching the whole write to RAW is deliberate. RAW
 * stores every value as text, and its failure mode is silent: `=SUM()` over
 * RAW-written numbers returns 0, not an error and not the total. Escaping
 * blocks the same attack while numbers, dates and arithmetic keep working.
 *
 * SCOPE OF THE CLAIM, so nobody overstates it downstream: this escapes
 * formula-prefixed values BY DEFAULT. It does not "prevent formula injection".
 * `parse_formulas` is payload-wide rather than cell-scoped, so one legitimate
 * formula in a call reopens every other cell in that same call — and the flag
 * is set by an agent whose context may contain the attacker's text. The
 * default path is safe; a caller that opts out is on its own.
 */
function guardValues(
  values: unknown,
  parseFormulas: unknown
): unknown {
  if (parseFormulas === true) return values;
  if (!Array.isArray(values)) return values;
  return values.map((row) =>
    Array.isArray(row) ? row.map(escapeFormula) : escapeFormula(row)
  );
}

/** Shared across the two tools that write caller-supplied cell values. */
const parseFormulasParam = {
  parse_formulas: {
    type: "boolean",
    description:
      "Allow values to be stored as live formulas. Default false, which writes a leading = or + literally. Only set true when the caller explicitly asked for a formula — never for text taken from email, documents, or the web.",
  },
} as const;

const valueInputOptionParam = {
  value_input_option: {
    type: "string",
    enum: ["USER_ENTERED", "RAW"],
    description:
      "How Sheets interprets the values. USER_ENTERED (default) parses numbers, dates and booleans as typing them would, with formula-prefixed text kept inert unless parse_formulas is set. RAW stores every value verbatim as text: formulas never evaluate, but numbers arrive as text and break SUM/charts — use it only when literal-text semantics are the point.",
  },
} as const;

/**
 * The write mode and the formula guard resolve together because they are not
 * independent: escaping is part of what "USER_ENTERED" means here (SCRUM-46),
 * and RAW must NOT be escaped — RAW stores exactly what it is sent, so the
 * apostrophe would become a permanent literal character instead of a prefix
 * Sheets strips on read.
 *
 * Naming USER_ENTERED explicitly is not an opt-out of the guard. The default
 * is ESCAPED USER_ENTERED whether the caller writes the word or not;
 * `parse_formulas` is the only path to unescaped evaluation (SCRUM-121).
 */
function resolveValueInput(args: Record<string, unknown>): {
  valueInputOption: "USER_ENTERED" | "RAW";
  values: unknown;
} {
  if (args.value_input_option === "RAW") {
    if (args.parse_formulas === true) {
      throw new Error(
        'parse_formulas cannot be combined with value_input_option "RAW": ' +
          "RAW never evaluates anything, so the formulas would land as inert " +
          "text while the call reports success. Drop one of the two."
      );
    }
    return { valueInputOption: "RAW", values: args.values };
  }
  return {
    valueInputOption: "USER_ENTERED",
    values: guardValues(args.values, args.parse_formulas),
  };
}

export const sheetsTools: ToolDef[] = [
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
        value_render_option: {
          type: "string",
          enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"],
          description:
            "How values are rendered. FORMATTED_VALUE (default) returns what the cell displays. UNFORMATTED_VALUE returns the underlying typed value, which is how you tell a stored number from stored text. FORMULA returns the cell's formula where it has one — the only way to tell a live formula from text that merely looks like one, so use it to verify a write.",
        },
      },
      required: ["spreadsheet_id", "range"],
    },
    annotations: READ("Read spreadsheet range"),
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
        ...parseFormulasParam,
        ...valueInputOptionParam,
      },
      required: ["spreadsheet_id", "range", "values"],
    },
    annotations: MUTATE("Update spreadsheet cells"),
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
        ...parseFormulasParam,
        ...valueInputOptionParam,
      },
      required: ["spreadsheet_id", "values"],
    },
    annotations: CREATE("Append spreadsheet rows"),
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
    annotations: CREATE("Create spreadsheet"),
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
    annotations: CREATE("Add spreadsheet tab"),
  },
  {
    name: "sheets_rename_tab",
    description:
      "Rename a tab (sheet) inside a Google Sheets spreadsheet. Takes the tab's current title, not its sheetId. Renaming changes only the label: every row, formula and value in the tab is untouched. Ranges that name the old title will stop resolving, so update any saved ranges afterwards.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheet_id: {
          type: "string",
          description: "The spreadsheet ID",
        },
        title: {
          type: "string",
          description: "Current title of the tab to rename",
        },
        new_title: {
          type: "string",
          description: "New title for the tab",
        },
      },
      required: ["spreadsheet_id", "title", "new_title"],
    },
    // Changes a label, destroys no data.
    annotations: CREATE("Rename a spreadsheet tab"),
  },
  {
    name: "sheets_clear",
    description:
      "Clear the values in a range, leaving the tab and its formatting in place. This is the non-destructive way to empty a tab or a block of cells — use it instead of deleting and recreating a tab, which throws away the tab's structure along with its data.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheet_id: {
          type: "string",
          description: "The spreadsheet ID",
        },
        range: {
          type: "string",
          description:
            "Range to clear in A1 notation. A bare tab name clears the whole tab (e.g. \"Inventory\"), or clear a block with \"Inventory!A2:D\"",
        },
      },
      required: ["spreadsheet_id", "range"],
    },
    // Removes values that already exist, so it prompts — but it is the
    // gentler neighbour of sheets_delete_tab and should be preferred.
    annotations: MUTATE("Erase the values in a spreadsheet range"),
  },
  {
    name: "sheets_delete_tab",
    description:
      "Delete a tab (sheet) and everything in it from a spreadsheet. Takes the tab's current title. THIS DESTROYS EVERY ROW IN THE TAB and cannot be undone through the API. To empty a tab without losing it, use sheets_clear instead. To delete the whole spreadsheet file, use sheets_delete.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheet_id: {
          type: "string",
          description: "The spreadsheet ID",
        },
        title: {
          type: "string",
          description: "Title of the tab to delete, with all of its rows",
        },
      },
      required: ["spreadsheet_id", "title"],
    },
    // The title has to survive being read alone in a confirmation dialog by
    // someone who thinks they are closing a view.
    annotations: MUTATE("Delete a spreadsheet tab and all its rows"),
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
    annotations: MUTATE("Delete spreadsheet"),
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

/** Resolve a tab title to the sheetId the batchUpdate API needs.
 *
 * Callers address tabs the way people do — by title — because a sheetId is
 * an arbitrary identifier nobody has to hand (and, as sheets_add_tab's
 * comment notes, the first tab is not id 0). A title that does not exist
 * fails with the same list-the-real-tabs message the range path gives,
 * rather than an API error about a sheetId the caller never supplied. */
async function resolveSheetId(
  client: GwsClient,
  spreadsheetId: unknown,
  title: string
): Promise<number> {
  const result = await client.api("sheets", "spreadsheets", "get", {
    params: { spreadsheetId, fields: "sheets.properties(sheetId,title)" },
  });
  const data = result.data as {
    sheets?: { properties?: { sheetId?: number; title?: string } }[];
  };
  const props = (data.sheets ?? []).map((sheet) => sheet.properties ?? {});
  const match = props.find((p) => p.title === title);
  if (match?.sheetId === undefined) {
    const titles = props
      .map((p) => p.title)
      .filter((t): t is string => typeof t === "string");
    throw new Error(
      `No sheet named "${title}" in this spreadsheet. Existing tabs: ` +
        `${titles.map((t) => `"${t}"`).join(", ") || "(none)"}.`
    );
  }
  return match.sheetId;
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
            // Omitted entirely when unset: the API's own default is
            // FORMATTED_VALUE, and sending it explicitly would be a second
            // place for that default to drift from Google's.
            ...(args.value_render_option
              ? { valueRenderOption: args.value_render_option }
              : {}),
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
      const { valueInputOption, values } = resolveValueInput(args);
      const result = await client.api(
        "sheets",
        "spreadsheets.values",
        "update",
        {
          params: {
            spreadsheetId: args.spreadsheet_id,
            range: args.range,
            valueInputOption,
          },
          jsonBody: { values },
        }
      );
      return jsonResponse(result.data);
    }

    case "sheets_append": {
      const range = (args.range as string) || APPEND_DEFAULT_RANGE;
      const { valueInputOption, values } = resolveValueInput(args);
      const result = await client.api(
        "sheets",
        "spreadsheets.values",
        "append",
        {
          params: {
            spreadsheetId: args.spreadsheet_id,
            range,
            valueInputOption,
            insertDataOption: "INSERT_ROWS",
          },
          jsonBody: { values },
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

    case "sheets_rename_tab": {
      const sheetId = await resolveSheetId(
        client,
        args.spreadsheet_id,
        args.title as string
      );
      await client.api("sheets", "spreadsheets", "batchUpdate", {
        params: { spreadsheetId: args.spreadsheet_id },
        jsonBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: { sheetId, title: args.new_title },
                fields: "title",
              },
            },
          ],
        },
      });
      return jsonResponse({
        sheetId,
        title: args.new_title,
        previousTitle: args.title,
      });
    }

    case "sheets_clear": {
      const result = await client.api("sheets", "spreadsheets.values", "clear", {
        params: {
          spreadsheetId: args.spreadsheet_id,
          range: args.range,
        },
      });
      const data = result.data as { clearedRange?: string } | undefined;
      return jsonResponse({
        clearedRange: data?.clearedRange ?? args.range,
      });
    }

    case "sheets_delete_tab": {
      const sheetId = await resolveSheetId(
        client,
        args.spreadsheet_id,
        args.title as string
      );
      await client.api("sheets", "spreadsheets", "batchUpdate", {
        params: { spreadsheetId: args.spreadsheet_id },
        jsonBody: { requests: [{ deleteSheet: { sheetId } }] },
      });
      return deleteResponse(`Tab "${args.title}"`);
    }

    case "sheets_delete": {
      await deleteDriveFile(client, args.spreadsheet_id);
      return deleteResponse("Spreadsheet");
    }

    default:
      throw new Error(`Unknown Sheets tool: ${toolName}`);
  }
}
