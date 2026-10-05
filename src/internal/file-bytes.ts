import type { IncomingMessage, ServerResponse } from "node:http";
import type { GwsClient } from "../gws-client.js";
import { errorMessage } from "../google-api/errors.js";
import { base64urlFieldBytes } from "../google-api/direct-upload.js";

/** The private route the gateway calls to fetch the bytes of a file
 * reference (SCRUM-384).
 *
 * WHY IT EXISTS: moving a file from one connector to another through tool
 * results would put the whole file in the model's context. The gateway asks
 * the plugin that owns the file for its bytes here, holds them in memory, and
 * hands them to the plugin that stores them. This is not an MCP tool and no
 * model can call it.
 *
 * One reference type so far: a Gmail message as its original (.eml).
 *
 * NOTHING ABOUT THE MESSAGE IS LOGGED OR WRITTEN TO DISK. The one log line
 * per request carries the outcome code and a byte count. */

export const FILE_BYTES_PATH = "/internal/file-bytes";

/** The request is a small JSON object; anything larger is not one of ours. */
export const MAX_REQUEST_BYTES = 16 * 1024;

/** The longest file name handed back, in UTF-16 units. */
export const MAX_NAME_LENGTH = 200;

export type FileBytesCode =
  | "ok"
  | "no_token"
  | "bad_request"
  | "unsupported_ref"
  | "too_large"
  | "not_found"
  | "upstream"
  | "method_not_allowed";

export interface FileBytesRequest {
  method: string | undefined;
  /** The X-User-Token header: a Google access token. Never logged or echoed. */
  token: string | undefined;
  /** The request body as text. */
  body: string;
}

export interface FileBytesResponse {
  status: number;
  code: FileBytesCode;
  headers: Record<string, string>;
  body: Buffer;
}

function refuse(status: number, code: FileBytesCode, error: string, extra?: Record<string, string>): FileBytesResponse {
  const body = Buffer.from(JSON.stringify({ error, code }), "utf8");
  return {
    status,
    code,
    headers: { "Content-Type": "application/json", "Content-Length": String(body.length), ...extra },
    body,
  };
}

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const tooLarge = (size: number, cap: number) =>
  refuse(413, "too_large", `The message is ${mb(size)}, which is over the ${mb(cap)} limit for one file.`);

const MESSAGE_ID = /^[A-Za-z0-9_-]+$/;

/** A subject as a file name part: no control characters, none of the
 * characters a file system refuses, whitespace collapsed. Line breaks and
 * tabs (a folded header) count as whitespace, so they become one space
 * rather than joining two words. */
export function sanitiseSubject(subject: string | undefined): string {
  const cleaned = (subject ?? "")
    .replace(/\s+/g, " ")
    .replace(/\p{Cc}/gu, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "message";
}

/** `<subject> <YYYY-MM-DD> <message id>.eml`, at most MAX_NAME_LENGTH long.
 *
 * THE TAIL IS NEVER CUT. The id is what tells two messages with one subject
 * apart and the extension is what makes the file open, so a long name loses
 * subject text first, then the date, and the ` <id>.eml` end survives whole. */
export function fileNameFor(subject: string | undefined, internalDate: unknown, messageId: string): string {
  const ms = Number(internalDate);
  const hasDate = internalDate !== undefined && internalDate !== null && internalDate !== "" && Number.isFinite(ms);
  let date = "";
  if (hasDate) {
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) date = d.toISOString().slice(0, 10);
  }
  const tail = ` ${messageId}.eml`;
  let head = sanitiseSubject(subject) + (date ? ` ${date}` : "");
  const room = MAX_NAME_LENGTH - tail.length;
  if (head.length > room) {
    // Not through the middle of a surrogate pair, and no space left dangling.
    head = head.slice(0, Math.max(room, 0)).toWellFormed().replace(/�$/, "").trimEnd();
  }
  // toWellFormed: a lone surrogate would make encodeURIComponent throw.
  return (head ? head + tail : tail.trimStart()).toWellFormed();
}

/** What Google said, out of the transport's error text, without the wrapper.
 * The transport never puts the token in an error, so neither does this. */
function googleError(err: unknown): { status?: number; message: string } {
  const text = errorMessage(err).split("\n\n[transient")[0];
  const m = /^API error: (\{.*\})$/s.exec(text);
  if (m) {
    try {
      const e = (JSON.parse(m[1]) as { error?: { code?: number; message?: string } }).error;
      if (e?.message) return { status: e.code, message: e.message };
    } catch {
      // fall through to the text as it stands
    }
  }
  return { message: text };
}

function upstreamFailure(err: unknown): FileBytesResponse {
  const { status, message } = googleError(err);
  if (status === 404) return refuse(404, "not_found", "Gmail has no message with that id in this mailbox.");
  return refuse(502, "upstream", `Gmail could not return the message: ${message}`);
}

interface GmailMetadata {
  sizeEstimate?: number;
  internalDate?: string;
  payload?: { headers?: Array<{ name?: string; value?: string }> };
}

/** The whole route, with no socket: a request in, a response out. */
export async function handleFileBytes(
  req: FileBytesRequest,
  clientFor: (token: string) => GwsClient
): Promise<FileBytesResponse> {
  if (req.method !== "POST") {
    return refuse(405, "method_not_allowed", "This route answers POST only.", { Allow: "POST" });
  }
  if (!req.token) return refuse(401, "no_token", "The X-User-Token header is missing.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body);
  } catch {
    return refuse(400, "bad_request", "The request body is not JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return refuse(400, "bad_request", "The request body must be a JSON object.");
  }
  const { ref, max_bytes: maxBytes } = parsed as { ref?: unknown; max_bytes?: unknown };
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
    return refuse(400, "bad_request", "The request has no ref object.");
  }
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return refuse(400, "bad_request", "max_bytes must be a positive integer.");
  }
  const { type, message_id: messageId } = ref as { type?: unknown; message_id?: unknown };
  if (type !== "gmail_message") {
    return refuse(400, "unsupported_ref", "This reference type is not supported. Supported: gmail_message.");
  }
  if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) {
    return refuse(400, "bad_request", "ref.message_id must be a non-empty string of letters, digits, _ and -.");
  }

  const client = clientFor(req.token);

  // SIZE BEFORE BYTES: the metadata read says how large the message is, so
  // one over the cap is refused without its body ever being fetched.
  // metadataHeaders is an array: the direct transport sends a repeated key,
  // where a comma-joined string matches no header at all.
  let meta: GmailMetadata;
  try {
    const result = await client.api("gmail", "users.messages", "get", {
      params: { userId: "me", id: messageId, format: "metadata", metadataHeaders: ["Subject", "Date"] },
    });
    meta = (result.data ?? {}) as GmailMetadata;
  } catch (err) {
    return upstreamFailure(err);
  }
  if (typeof meta.sizeEstimate === "number" && meta.sizeEstimate > maxBytes) {
    return tooLarge(meta.sizeEstimate, maxBytes);
  }

  // The raw message arrives as one base64url field inside JSON. It is read
  // as a stream and decoded as it arrives (`fields: raw` leaves nothing else
  // in the answer), so the encoded text is never held whole and the read
  // stops at the first byte past the cap: sizeEstimate is an estimate.
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    const raw = await client.download("gmail", "users.messages", "get", {
      userId: "me",
      id: messageId,
      format: "raw",
      fields: "raw",
    });
    const source = raw.stream as unknown as AsyncIterable<Uint8Array>;
    for await (const chunk of base64urlFieldBytes(source, "raw", "Gmail returned no raw content for the message.")) {
      size += chunk.length;
      if (size > maxBytes) return tooLarge(size, maxBytes);
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
    }
  } catch (err) {
    return upstreamFailure(err);
  }
  if (size === 0) return refuse(502, "upstream", "Gmail could not return the message: it came back empty.");

  const subject = meta.payload?.headers?.find((h) => h.name?.toLowerCase() === "subject")?.value;
  const name = fileNameFor(subject, meta.internalDate, messageId);
  const body = Buffer.concat(chunks, size);
  return {
    status: 200,
    code: "ok",
    headers: {
      "Content-Type": "message/rfc822",
      "Content-Length": String(body.length),
      "X-File-Name": encodeURIComponent(name),
    },
    body,
  };
}

/** The request body as text, or null once it passes MAX_REQUEST_BYTES. */
async function readRequestBody(req: IncomingMessage): Promise<string | null> {
  const held: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) return null;
    held.push(chunk);
  }
  return Buffer.concat(held).toString("utf8");
}

/** The node:http side: read the request, answer, write the one log line. */
export async function serveFileBytes(
  req: IncomingMessage,
  res: ServerResponse,
  clientFor: (token: string) => GwsClient
): Promise<void> {
  let out: FileBytesResponse;
  try {
    const header = req.headers["x-user-token"];
    const token = Array.isArray(header) ? header[0] : header;
    const body = req.method === "POST" ? await readRequestBody(req) : "";
    out =
      body === null
        ? refuse(400, "bad_request", "The request body is too large.", { Connection: "close" })
        : await handleFileBytes({ method: req.method, token, body }, clientFor);
  } catch {
    // Nothing from the failure is echoed: it could describe the message.
    out = refuse(502, "upstream", "The message could not be read.");
  }
  console.error(`file-bytes: code=${out.code} status=${out.status} bytes=${out.code === "ok" ? out.body.length : 0}`);
  res.writeHead(out.status, out.headers).end(out.body);
}
