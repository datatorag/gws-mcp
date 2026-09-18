import { randomUUID } from "node:crypto";
import { buildRequest, requestUrl } from "./request.js";
import { MEDIA_TIMEOUT_MS, parseBody, readCapped, sendAuthorized, throwApiError, type ApiResult } from "./direct-transport.js";

/** Below this the media goes up in one multipart request; above it, as a
 * resumable session in fixed chunks. The chunk is the most this path ever
 * holds in memory, whatever the size of the file (SCRUM-289). Google requires
 * every chunk but the last to be a multiple of 256 KiB. */
export const RESUMABLE_THRESHOLD = 5 * 1024 * 1024;
export const RESUMABLE_CHUNK = 8 * 1024 * 1024;

export interface UploadOptions {
  params?: Record<string, unknown>;
  /** The JSON half of the request (Drive file metadata, Gmail threadId). */
  metadata?: Record<string, unknown>;
  contentType: string;
  source: AsyncIterable<Uint8Array>;
}

/** Collect from `source` until `limit` bytes are held or it ends. */
async function fill(
  it: AsyncIterator<Uint8Array>,
  carry: Buffer,
  limit: number
): Promise<{ chunk: Buffer; rest: Buffer; done: boolean }> {
  const held: Buffer[] = [carry];
  let size = carry.length;
  let done = false;
  while (size < limit) {
    const next = await it.next();
    if (next.done) {
      done = true;
      break;
    }
    held.push(Buffer.from(next.value));
    size += next.value.length;
  }
  const all = Buffer.concat(held);
  if (all.length <= limit) return { chunk: all, rest: Buffer.alloc(0), done };
  return { chunk: all.subarray(0, limit), rest: all.subarray(limit), done: false };
}

export async function directUpload(
  token: string,
  service: string,
  resource: string,
  method: string,
  options: UploadOptions
): Promise<ApiResult> {
  const request = buildRequest(service, resource, method, { params: options.params, upload: true });
  const label = `${service} ${resource} ${method}`;
  const metadata = JSON.stringify(options.metadata ?? {});
  const it = options.source[Symbol.asyncIterator]();

  const first = await fill(it, Buffer.alloc(0), RESUMABLE_THRESHOLD + 1);
  if (first.done && first.chunk.length <= RESUMABLE_THRESHOLD) {
    const boundary = `gws_${randomUUID()}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
          `--${boundary}\r\nContent-Type: ${options.contentType}\r\n\r\n`
      ),
      first.chunk,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await sendAuthorized(
      token,
      { method: request.method, url: requestUrl(request, [["uploadType", "multipart"]]) },
      label,
      { body, headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, timeout: MEDIA_TIMEOUT_MS }
    );
    const text = await readCapped(res, label);
    if (!res.ok) throwApiError(res.status, text);
    return { success: true, data: parseBody(text) };
  }

  const resumablePath = request.entry.mediaUpload?.resumable;
  if (!resumablePath) throw new Error(`${label} does not accept a resumable upload.`);
  const sessionUrl = requestUrl(
    { ...request, url: request.url.replace(request.entry.mediaUpload?.simple ?? "", resumablePath) },
    [["uploadType", "resumable"]]
  );
  const open = await sendAuthorized(token, { method: request.method, url: sessionUrl }, label, {
    body: metadata,
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": options.contentType },
    timeout: MEDIA_TIMEOUT_MS,
  });
  if (!open.ok) throwApiError(open.status, await readCapped(open, label));
  const session = open.headers.get("location");
  if (!session) throw new Error(`${label}: Google opened no upload session.`);

  let offset = 0;
  let carry: Buffer = Buffer.concat([first.chunk, first.rest]);
  for (;;) {
    const { chunk, rest, done } = await fill(it, carry, RESUMABLE_CHUNK);
    carry = rest;
    const last = done && rest.length === 0;
    const end = offset + chunk.length;
    const range = chunk.length === 0 ? `bytes */${end}` : `bytes ${offset}-${end - 1}/${last ? end : "*"}`;
    // sendAuthorized re-checks the session URL: it came from a response header.
    const res = await sendAuthorized(token, { method: "PUT", url: session }, label, {
      body: chunk,
      headers: { "Content-Range": range },
      timeout: MEDIA_TIMEOUT_MS,
    });
    offset = end;
    if (last) {
      const text = await readCapped(res, label);
      if (!res.ok) throwApiError(res.status, text);
      return { success: true, data: parseBody(text) };
    }
    if (res.status !== 308) throwApiError(res.status, await readCapped(res, label));
    // Nothing in an intermediate answer is needed; discard it unread.
    await res.body?.cancel().catch(() => {});
  }
}

/** The bytes of a Gmail attachment, decoded as they arrive.
 *
 * `users.messages.attachments.get` answers with JSON whose `data` field is
 * the whole attachment in base64url. Parsing that document means holding the
 * encoded text, the parsed string and the decoded bytes at once; this reads
 * the field out of the stream instead, so only one network chunk is in memory
 * at a time. base64url has no quotes or escapes, which is what makes reading
 * it without a JSON parser sound. */
export async function* gmailAttachmentBytes(body: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  let inData = false;
  let finished = false;
  for await (const bytes of body) {
    if (finished) continue;
    pending += decoder.decode(bytes, { stream: true });
    if (!inData) {
      const m = /"data"\s*:\s*"/.exec(pending);
      if (!m) {
        // Keep a tail long enough to hold a key split across two chunks.
        pending = pending.slice(-16);
        continue;
      }
      pending = pending.slice(m.index + m[0].length);
      inData = true;
    }
    const close = pending.indexOf('"');
    const text = close === -1 ? pending : pending.slice(0, close);
    const usable = close === -1 ? text.length - (text.length % 4) : text.length;
    if (usable > 0) yield Buffer.from(text.slice(0, usable), "base64url");
    if (close === -1) {
      pending = text.slice(usable);
    } else {
      finished = true;
    }
  }
  if (!inData) throw new Error("No attachment data returned from Gmail API");
}
