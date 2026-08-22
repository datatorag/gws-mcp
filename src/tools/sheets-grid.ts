import type { GwsClient } from "../gws-client.js";

/**
 * Shared grid geometry for the Sheets tools.
 *
 * Everything that formats or restructures a spreadsheet goes through the
 * `spreadsheets.batchUpdate` endpoint, and that endpoint addresses cells with a
 * `GridRange`: a `sheetId` plus four integer bounds. Callers address cells with
 * A1 notation, because that is what they just used to write the values.
 *
 * THE TWO CONVENTIONS ARE NOT THE SAME AND THE MISMATCH IS SILENT:
 *
 *   A1        1-based, end-INCLUSIVE.   "A2:D10" is rows 2 to 10.
 *   GridRange 0-based, end-EXCLUSIVE.   the same rows are 1 to 10.
 *
 * An off-by-one does not raise an error. It styles the row next to the one you
 * meant, and the result looks deliberate to anyone who did not write it. That
 * is why the conversion lives in one tested function instead of being
 * recomputed per request at each call site.
 */

/** The four bounds of a `GridRange`, without the sheet it belongs to. An
 * omitted side means "to the edge of the sheet" — that is the API's own
 * reading, and it is why unbounded ranges must omit rather than guess. */
export interface GridBounds {
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
}

export interface GridRange extends GridBounds {
  sheetId: number;
}

/* ------------------------------ A1 parsing ------------------------------- */

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

/** One A1 endpoint: up to three letters (the sheet maximum is column ZZZ) and
 * up to seven digits. The letter cap is what lets a bare string be told apart
 * from a tab name below, so it is load-bearing rather than tidiness. */
const A1_TOKEN = /^([A-Za-z]{1,3})?([0-9]{1,7})?$/;

/** A whole cell part, used to decide whether a prefix-less string is a range
 * or a tab title. */
const A1_CELLS = new RegExp(
  `^(?:[A-Za-z]{1,3}[0-9]{0,7}|[0-9]{1,7})(?::(?:[A-Za-z]{1,3}[0-9]{0,7}|[0-9]{1,7}))?$`
);

function badRange(range: string): Error {
  return new Error(
    `The range "${range}" could not be read as A1 notation. ` +
      `Expected something like "Sheet1!A1:D10", "A:A", "2:2" or a bare tab name.`
  );
}

/** Column letters to a 0-based index: A is 0, Z is 25, AA is 26. */
export function columnLetterToIndex(letters: string): number {
  let acc = 0;
  for (const ch of letters.toUpperCase()) {
    acc = acc * 26 + (ch.charCodeAt(0) - 64);
  }
  return acc - 1;
}

/** The inverse, for building an A1 range to hand back to a caller. */
export function columnIndexToLetter(index: number): string {
  let out = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

interface A1Token {
  col?: number;
  /** 1-based, as written. Converted at the end, once. */
  row?: number;
}

function parseToken(token: string, range: string): A1Token {
  const m = A1_TOKEN.exec(token);
  if (!m || (!m[1] && !m[2])) throw badRange(range);
  return {
    ...(m[1] ? { col: columnLetterToIndex(m[1]) } : {}),
    ...(m[2] ? { row: Number(m[2]) } : {}),
  };
}

/**
 * Parse the cell part of an A1 range into 0-based, end-exclusive bounds.
 *
 * An empty string returns no bounds at all, which the API reads as the whole
 * sheet. That is intended for a bare tab name and is the reason unparseable
 * input THROWS rather than falling back to `{}`: a typo that quietly became
 * "the whole sheet" would turn a one-column format into a spreadsheet-wide one.
 */
export function a1ToGridBounds(cells: string): GridBounds {
  const trimmed = cells.trim();
  if (trimmed === "") return {};

  const parts = trimmed.split(":");
  if (parts.length > 2) throw badRange(cells);
  const start = parseToken(parts[0], cells);
  const end = parts.length === 2 ? parseToken(parts[1], cells) : start;

  // Sheets accepts a reversed range in A1, so normalise rather than reject:
  // failing on input that works everywhere else would be a new failure mode
  // rather than a caught error.
  let [firstRow, lastRow] = [start.row, end.row];
  if (firstRow !== undefined && lastRow !== undefined && firstRow > lastRow) {
    [firstRow, lastRow] = [lastRow, firstRow];
  }
  let [firstCol, lastCol] = [start.col, end.col];
  if (firstCol !== undefined && lastCol !== undefined && firstCol > lastCol) {
    [firstCol, lastCol] = [lastCol, firstCol];
  }

  return {
    ...(firstRow !== undefined ? { startRowIndex: firstRow - 1 } : {}),
    ...(lastRow !== undefined ? { endRowIndex: lastRow } : {}),
    ...(firstCol !== undefined ? { startColumnIndex: firstCol } : {}),
    ...(lastCol !== undefined ? { endColumnIndex: lastCol + 1 } : {}),
  };
}

/** Split a range into its tab title and its cell part.
 *
 * A string with no "!" is ambiguous: "A1:D10" is a range and "Inventory" is a
 * tab. It is resolved the way Sheets itself resolves it, by whether the string
 * is a syntactically valid A1 range — and the three-letter column cap is what
 * makes "Inventory" fail that test. A tab whose name genuinely looks like a
 * cell reference ("Q3") must be written with an explicit "!" to be addressed
 * as a tab; there is no way to tell the two apart otherwise, and guessing
 * silently is worse than a rule that can be stated. */
export function splitRange(range: string): { tab?: string; cells: string } {
  const tab = tabNameFromRange(range);
  if (tab !== undefined) {
    const bang = range.indexOf("!");
    return { tab, cells: range.slice(bang + 1) };
  }
  const bare = range.trim();
  if (bare.startsWith("'") && bare.endsWith("'") && bare.length > 1) {
    return { tab: bare.slice(1, -1).replace(/''/g, "'"), cells: "" };
  }
  if (bare === "" || A1_CELLS.test(bare)) return { cells: bare };
  return { tab: bare, cells: "" };
}

/* --------------------------- tabs and sheetIds ---------------------------- */

/** The one tab-list fetch behind both the missing-tab diagnosis and
 * title→sheetId resolution — the two used to carry their own copies and had
 * already drifted apart. */
export async function listTabs(
  client: GwsClient,
  spreadsheetId: unknown
): Promise<{ sheetId?: number; title?: string }[]> {
  const result = await client.api("sheets", "spreadsheets", "get", {
    params: { spreadsheetId, fields: "sheets.properties(sheetId,title)" },
  });
  const data = result.data as {
    sheets?: { properties?: { sheetId?: number; title?: string } }[];
  };
  return (data.sheets ?? []).map((sheet) => sheet.properties ?? {});
}

export function tabTitles(props: { title?: string }[]): string[] {
  return props
    .map((p) => p.title)
    .filter((t): t is string => typeof t === "string");
}

export function noSuchTabError(tab: string, titles: string[], hint = ""): Error {
  return new Error(
    `No sheet named "${tab}" in this spreadsheet. Existing tabs: ` +
      `${titles.map((t) => `"${t}"`).join(", ") || "(none)"}.${hint}`
  );
}

/** Resolve a tab title to the sheetId the batchUpdate API needs.
 *
 * Callers address tabs the way people do — by title — because a sheetId is
 * an arbitrary identifier nobody has to hand. A title that does not exist
 * fails with the same list-the-real-tabs message the range path gives,
 * rather than an API error about a sheetId the caller never supplied. */
export async function resolveSheetId(
  client: GwsClient,
  spreadsheetId: unknown,
  title: string
): Promise<number> {
  const props = await listTabs(client, spreadsheetId);
  const match = props.find((p) => p.title === title);
  if (match?.sheetId === undefined) {
    throw noSuchTabError(title, tabTitles(props));
  }
  return match.sheetId;
}

/**
 * Fetch the tab list once, then resolve any number of A1 ranges against it
 * synchronously.
 *
 * A tool that formats eight ranges must not make nine API calls to do it, and
 * the resolution is pure once the tab list is in hand. This is the same
 * one-call-does-the-whole-job property the tools themselves are built for,
 * applied to our own use of the API.
 *
 * A range with no tab prefix resolves to the FIRST TAB'S REAL sheetId, read
 * from the spreadsheet. Never to a literal 0: `sheetId` is an arbitrary
 * identifier and the first tab of a spreadsheet is not necessarily id 0, so
 * defaulting to 0 addresses whichever tab happens to hold that id, or fails in
 * a way indistinguishable from a bad range.
 */
export async function gridRangeResolver(
  client: GwsClient,
  spreadsheetId: unknown
): Promise<(range: string) => GridRange> {
  const props = await listTabs(client, spreadsheetId);
  const titles = tabTitles(props);
  const firstSheetId = props[0]?.sheetId;

  return (range: string): GridRange => {
    const { tab, cells } = splitRange(range);
    let sheetId: number | undefined;
    if (tab === undefined) {
      sheetId = firstSheetId;
      if (sheetId === undefined) {
        throw new Error(
          `The range "${range}" names no tab and this spreadsheet reports no ` +
            `sheets, so there is no first tab to apply it to.`
        );
      }
    } else {
      sheetId = props.find((p) => p.title === tab)?.sheetId;
      if (sheetId === undefined) throw noSuchTabError(tab, titles);
    }
    return { sheetId, ...a1ToGridBounds(cells) };
  };
}

/* ------------------------------ formatting -------------------------------- */

/** Hex to the API's `rgbColor`, whose channels are floats from 0 to 1 rather
 * than bytes. Every caller who has hand-built one has divided by 255 by hand,
 * and a channel left as 0-255 is accepted, clamped, and only visible in the
 * render. Rejecting a malformed colour at the boundary is cheaper than finding
 * it in a screenshot. */
export function hexToRgbColor(hex: string): {
  red: number;
  green: number;
  blue: number;
} {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) {
    throw new Error(
      `"${hex}" is not a colour. Use six hex digits in the form #RRGGBB.`
    );
  }
  const n = parseInt(m[1], 16);
  return {
    red: ((n >> 16) & 255) / 255,
    green: ((n >> 8) & 255) / 255,
    blue: (n & 255) / 255,
  };
}

/**
 * The API `fields` mask naming every leaf of `obj`, and nothing else.
 *
 * A mask is a licence to overwrite: anything it names and the request body
 * does not carry is CLEARED. So "userEnteredFormat(textFormat)" sent for a
 * caller who only asked for bold destroys the font family and size already on
 * the cell. The mask therefore has to be derived from the object actually
 * built, never written as a constant, and it has to descend into nested
 * objects rather than stopping at the top level.
 */
export function fieldsMask(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .map(([key, value]) => {
      const isPlainObject =
        typeof value === "object" && value !== null && !Array.isArray(value);
      if (!isPlainObject) return key;
      const inner = fieldsMask(value as Record<string, unknown>);
      return inner ? `${key}(${inner})` : key;
    })
    .join(",");
}
