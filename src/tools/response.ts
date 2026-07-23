import type { GwsClient } from "../gws-client.js";

const MAX_RESPONSE_SIZE = 900_000; // ~900KB, under MCP's 1MB limit

export function textResponse(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

export function jsonResponse(data: unknown) {
  let text = JSON.stringify(data, null, 2);
  if (text.length > MAX_RESPONSE_SIZE) {
    text = text.slice(0, MAX_RESPONSE_SIZE) + "\n\n... [truncated — response exceeded 900KB]";
  }
  return textResponse(text);
}

/** Slice text to maxChars, appending a marker that reports how much was cut.
 * Shared marker convention for per-field truncation (gmail_read max_body_chars,
 * calendar_list_events max_description_chars). */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${
    text.length - maxChars
  } of ${text.length} chars]`;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&shy;/g, "")
    // Collapse spacing/invisible chars common in marketing-email preheaders
    // (en/em/figure spaces, zero-width space, soft hyphen, grapheme joiner)
    .replace(/[ \t\u2000-\u200B\u00AD\u034F]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export function deleteResponse(entityName: string) {
  return textResponse(`${entityName} deleted successfully.`);
}

/** Sheets, Docs, and Slides are Drive files — deleting them is a Drive operation. */
export function deleteDriveFile(client: GwsClient, fileId: unknown) {
  return client.api("drive", "files", "delete", {
    params: { fileId, supportsAllDrives: true },
  });
}
