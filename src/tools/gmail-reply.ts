import { singleLine } from "./mime-headers.js";
import { stripHtml } from "./response.js";

/** Building a reply as multipart/alternative.
 *
 * The `gws` CLI's `+reply` helper takes ONE body and a boolean `--html`, so it
 * can emit `text/plain` OR a single `text/html` part and never both. A signed
 * reply needs the signature in an HTML part (SCRUM-278 note 2) while keeping
 * the plain alternative, so once a signature applies we compose the reply here
 * instead and send it on the raw path, exactly as `gmail_send` already does.
 *
 * The quote markup below is the CLI's own, taken verbatim from
 * `gws gmail +reply --dry-run` in both its plain and `--html` forms, so a
 * signed reply quotes identically to an unsigned one. An unsigned reply still
 * goes through the CLI untouched. */

/** How much markup is flattened when a plain alternative has to be DERIVED.
 *
 * Deriving one means running the shared flattener over caller- or
 * sender-supplied markup, so the input is bounded before it gets there rather
 * than after. THE single bound for that concern — it used to be stated twice,
 * with the larger of the two unable to ever bind. */
const PLAIN_DERIVE_MAX = 128 * 1024;

export function derivePlain(html: string): string {
  if (html.length <= PLAIN_DERIVE_MAX) return stripHtml(html);
  return `${stripHtml(html.slice(0, PLAIN_DERIVE_MAX))}\n…[truncated]`;
}

const QUOTE_STYLE =
  "margin:0 0 0 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex";

export interface OriginalMessage {
  /** Raw `From` header value, e.g. `Manuel Yang <m@x.com>`. */
  from: string;
  /** Raw `Date` header value, used VERBATIM in the plain attribution because
   * that is what the CLI does. */
  date: string;
  subject: string;
  messageId: string;
  references?: string;
  plain?: string;
  html?: string;
}

/** The bare address out of a `From` header. Returns the input unchanged when
 * there is no angle-addr, which is a legal `From`. */
export function addressOnly(from: string): string {
  const safe = singleLine(from);
  const open = safe.lastIndexOf("<");
  if (open === -1) return safe;
  const close = safe.indexOf(">", open);
  if (close === -1) return safe;
  return safe.slice(open + 1, close).trim();
}

export function replySubject(subject: string): string {
  const safe = singleLine(subject);
  return /^re:/i.test(safe) ? safe : `Re: ${safe}`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `On <raw Date header>, <address> wrote:` — the CLI's plain form. */
export function plainAttribution(date: string, from: string): string {
  return `On ${date}, ${addressOnly(from)} wrote:`;
}

/** `On Thu, Jan 1, 2026 at 12:00 AM` — the CLI's HTML form, which is Gmail's.
 * Formatted in UTC so the same message quotes the same way wherever this runs;
 * an unparseable Date falls back to the raw header rather than to `Invalid
 * Date`. */
export function htmlAttributionDate(date: string): string {
  const at = new Date(date);
  if (Number.isNaN(at.getTime())) return date;
  const formatted = at.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  // Intl writes `Thu, Jan 1, 2026, 12:00 AM`; the CLI (and Gmail) write `at`
  // in place of that LAST comma. Anchored to the time so the date's own commas
  // are untouched.
  return formatted
    .replace(/,(\s\d{1,2}:\d{2})/, " at$1")
    // The CLI and Gmail both use a NARROW NO-BREAK SPACE before AM/PM. Node's
    // ICU emits a plain space on some versions and U+202F on others, so
    // normalise rather than inherit whichever the host happens to have —
    // otherwise the same reply quotes differently on two machines.
    .replace(/[\s\u202f]+(AM|PM)\b/, "\u202f$1");
}

export function quotePlain(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

export function htmlQuoteBlock(original: OriginalMessage, originalHtml: string): string {
  const addr = addressOnly(original.from);
  const when = htmlAttributionDate(original.date);
  return (
    '<div class="gmail_quote gmail_quote_container">' +
    `<div dir="ltr" class="gmail_attr">On ${when}, ` +
    `<a href="mailto:${escapeHtml(addr)}">${escapeHtml(addr)}</a> wrote:<br></div>` +
    `<blockquote class="gmail_quote" style="${QUOTE_STYLE}">` +
    `<div dir="ltr">${originalHtml}</div>` +
    "</blockquote></div>"
  );
}

/** The plain text quoted, preferring the original's own text/plain part and
 * flattening its HTML only when there is none.
 *
 * `derivePlain` owns the bound. This used to take the flattener as a parameter
 * and pre-slice at its own larger constant first, which could never bind and
 * read as live protection. One cap, one owner. */
export function originalPlainText(original: OriginalMessage): string {
  if (original.plain !== undefined) return original.plain;
  if (original.html === undefined) return "";
  return derivePlain(original.html);
}

/** The original rendered as HTML for quoting: its own markup when it has any,
 * otherwise its plain text escaped. Shared by the reply and forward paths so
 * the two cannot drift. */
export function originalHtmlBody(original: OriginalMessage): string {
  return (
    original.html ??
    `<div dir="ltr">${escapeHtml(original.plain ?? "").replace(/\r\n|\r|\n/g, "<br>")}</div>`
  );
}

/** The two alternative bodies of a signed reply.
 *
 * `signedHtml` already carries the signature, so appending the quote after it
 * is what puts the signature ABOVE the quote. The plain body is the caller's
 * text and never the signature. */
export function buildReplyBodies(
  original: OriginalMessage,
  plainBody: string,
  signedHtml: string
): { plain: string; html: string } {
  const quotedSource = originalHtmlBody(original);
  return {
    plain: [
      plainBody,
      "",
      plainAttribution(original.date, original.from),
      quotePlain(originalPlainText(original)),
    ].join("\n"),
    html: `${signedHtml}<br>\n${htmlQuoteBlock(original, quotedSource)}`,
  };
}

/** The forwarded-message header block, the CLI's own text form. */
export function forwardPlainBlock(o: OriginalMessage, to: string, text: string): string {
  return [
    "---------- Forwarded message ---------",
    `From: ${o.from}`,
    `Date: ${o.date}`,
    `Subject: ${o.subject}`,
    `To: ${to}`,
    "",
    text,
  ].join("\n");
}

export function forwardHtmlBlock(o: OriginalMessage, to: string, html: string): string {
  const rows = [
    ["From", escapeHtml(o.from)],
    ["Date", escapeHtml(o.date)],
    ["Subject", escapeHtml(o.subject)],
    ["To", escapeHtml(to)],
  ]
    .map(([k, v]) => `<b>${k}:</b> ${v}<br>`)
    .join("");
  return (
    '<div class="gmail_quote gmail_quote_container">' +
    '<div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>' +
    `${rows}</div><br><div dir="ltr">${html}</div></div>`
  );
}

export function forwardSubject(subject: string): string {
  const safe = singleLine(subject);
  return /^fwd:/i.test(safe) ? safe : `Fwd: ${safe}`;
}

/** `References` accumulates the thread; `In-Reply-To` is the immediate parent.
 * Both are dropped when the original carried no `Message-ID`, which is legal
 * and must not produce an empty header. */
export function threadHeaders(o: OriginalMessage): string[] {
  const id = singleLine(o.messageId);
  if (!id) return [];
  const prior = o.references ? singleLine(o.references) : "";
  const refs = prior ? `${prior} ${id}` : id;
  return [`In-Reply-To: ${id}`, `References: ${refs}`];
}
