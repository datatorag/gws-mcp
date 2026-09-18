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

const QUOTE_STYLE =
  "margin:0 0 0 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex";

/** How much of an original HTML body is flattened for the plain quote.
 *
 * Only reached when the original has no text/plain part. The flattener is
 * shared text-extraction and the input is inbound mail, i.e. attacker-supplied,
 * so it is bounded here rather than trusted. */
const QUOTE_FLATTEN_MAX = 512 * 1024;

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

/** Fold any line break out of a value destined for a header.
 *
 * EVERY value a reply or forward derives comes out of a message someone else
 * sent us, so a CRLF in the original's Message-ID, References, Subject or From
 * would inject a header into the mail WE send — `Bcc:` being the worst case,
 * silently copying the user's reply to the attacker. `encodeHeaderValue`
 * cannot be relied on here: it returns an all-ASCII value unchanged, and
 * `assertHeadersSingleLine` only ever saw the CALLER's arguments.
 *
 * Folded to a space rather than rejected: a reply must not fail because the
 * message being replied to was malformed, and a space keeps the value usable.
 * A bare LF counts — most parsers start a new header on it. */
export function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
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
 * flattening its HTML only when there is none. */
export function originalPlainText(
  original: OriginalMessage,
  flatten: (html: string) => string
): string {
  if (original.plain !== undefined) return original.plain;
  if (original.html === undefined) return "";
  const html = original.html;
  return flatten(html.length > QUOTE_FLATTEN_MAX ? html.slice(0, QUOTE_FLATTEN_MAX) : html);
}

/** The two alternative bodies of a signed reply.
 *
 * `signedHtml` already carries the signature, so appending the quote after it
 * is what puts the signature ABOVE the quote. The plain body is the caller's
 * text and never the signature. */
export function buildReplyBodies(
  original: OriginalMessage,
  plainBody: string,
  signedHtml: string,
  flatten: (html: string) => string
): { plain: string; html: string } {
  const quotedSource =
    original.html !== undefined
      ? original.html
      : `<div dir="ltr">${escapeHtml(original.plain ?? "").replace(/\r\n|\r|\n/g, "<br>")}</div>`;
  return {
    plain: [
      plainBody,
      "",
      plainAttribution(original.date, original.from),
      quotePlain(originalPlainText(original, flatten)),
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
