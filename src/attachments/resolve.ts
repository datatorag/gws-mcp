import type { GwsClient } from "../gws-client.js";
import type { ByteAttachment } from "../mime/build.js";
import { safeFilename, safeMimeType } from "../mime/build.js";
import { ByteBudget, mb, opener, type Opener } from "./fetch.js";

/**
 * What each attachment entry becomes, decided before a single byte is
 * fetched (SCRUM-279).
 *
 * An entry is a Drive file id (a string, or `{file_id, as}` to export a Google
 * Doc, Sheet or Slides deck), or bytes carried in the call
 * (`{filename, mime_type, data}`). A forward adds the original message's own
 * attachments. Every refusal here happens before any download: shapes and
 * inline sizes synchronously, Drive metadata and the 25 MB total once the
 * metadata is in. A refused call sends nothing and fetches nothing.
 */

export const MAX_ENTRIES = 10;
/** Raw bytes, as the user counts them; base64 growth is the transport's. */
export const TOTAL_CAP = 25 * 1024 * 1024;
export const DATA_FILE_CAP = 2 * 1024 * 1024;
export const DATA_CALL_CAP = 5 * 1024 * 1024;

export type ParsedEntry =
  | { kind: "drive"; fileId: string; as?: "pdf" | "docx" }
  | { kind: "data"; filename: string; mimeType: string; bytes: Buffer };

/** A part of a message being forwarded that carries a filename. */
export interface OriginalPart {
  messageId: string;
  filename: string;
  mimeType?: string;
  size?: number;
  attachmentId?: string;
  /** Small parts arrive inline in the message resource instead. */
  data?: string;
  contentId?: string;
}

export type Mode = "attached" | "inline" | "linked" | "exported";

export interface ReportEntry {
  name: string;
  mode: Mode;
  source: "drive" | "data" | "original";
  file_id?: string;
  size?: number;
  link?: string;
  cid?: string;
}

export interface PlannedFile {
  filename: string;
  mimeType: string;
  contentId: string;
  open: Opener;
  report: ReportEntry;
}

export interface Resolved {
  links: Array<{ name: string; link: string }>;
  files: PlannedFile[];
  report: ReportEntry[];
}

const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;
const NATIVE = "application/vnd.google-apps.";
const FOLDER = "application/vnd.google-apps.folder";

/** What `as` may turn each native type into. Docs alone has a docx form. */
const EXPORTS: Record<string, Partial<Record<"pdf" | "docx", { mimeType: string; ext: string }>>> = {
  "application/vnd.google-apps.document": {
    pdf: { mimeType: "application/pdf", ext: ".pdf" },
    docx: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx" },
  },
  "application/vnd.google-apps.spreadsheet": { pdf: { mimeType: "application/pdf", ext: ".pdf" } },
  "application/vnd.google-apps.presentation": { pdf: { mimeType: "application/pdf", ext: ".pdf" } },
};

function refuse(message: string): never {
  throw new Error(`${message} Nothing was sent.`);
}

/** Decoded size of a base64 string, computed from its length so an
 * oversized one is refused without decoding it. */
function decodedLength(clean: string): number {
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - pad;
}

/** Every shape rule, synchronously, so a malformed call costs no request. */
export function parseAttachments(value: unknown): ParsedEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) refuse("attachments must be an array.");
  if (value.length > MAX_ENTRIES) refuse(`attachments holds ${value.length} entries; one message takes at most ${MAX_ENTRIES}.`);
  let dataTotal = 0;
  return value.map((entry, i): ParsedEntry => {
    if (typeof entry === "string") {
      if (!DRIVE_ID.test(entry)) refuse(`attachments[${i}] is not a Drive file id: ${JSON.stringify(entry.slice(0, 80))}.`);
      return { kind: "drive", fileId: entry };
    }
    if (!entry || typeof entry !== "object") refuse(`attachments[${i}] must be a Drive file id or an object.`);
    const e = entry as Record<string, unknown>;
    if (e.file_id !== undefined) {
      if (typeof e.file_id !== "string" || !DRIVE_ID.test(e.file_id)) {
        refuse(`attachments[${i}].file_id is not a Drive file id.`);
      }
      if (e.as !== undefined && e.as !== "pdf" && e.as !== "docx") {
        refuse(`attachments[${i}].as must be "pdf" or "docx".`);
      }
      if (e.data !== undefined || e.filename !== undefined) {
        refuse(`attachments[${i}] gives both a Drive file_id and inline data; pick one.`);
      }
      return { kind: "drive", fileId: e.file_id, ...(e.as ? { as: e.as as "pdf" | "docx" } : {}) };
    }
    if (typeof e.filename !== "string" || e.filename.trim() === "") refuse(`attachments[${i}] needs a filename.`);
    const name = e.filename as string;
    if (typeof e.mime_type !== "string" || e.mime_type === "") refuse(`"${name}" needs a mime_type.`);
    if (typeof e.data !== "string") refuse(`"${name}" needs data, the file's bytes in base64.`);
    const clean = (e.data as string).replace(/\s+/g, "");
    if (clean === "" || !BASE64.test(clean)) refuse(`"${name}" data is not base64.`);
    const size = decodedLength(clean);
    if (size > DATA_FILE_CAP) {
      refuse(`"${name}" is ${mb(size)}; a file passed as data is limited to ${mb(DATA_FILE_CAP)}. Put larger files in Drive and pass the id.`);
    }
    dataTotal += size;
    if (dataTotal > DATA_CALL_CAP) {
      refuse(`"${name}" takes the files passed as data to ${mb(dataTotal)}; one call carries at most ${mb(DATA_CALL_CAP)} that way. Put larger files in Drive and pass the ids.`);
    }
    return { kind: "data", filename: name, mimeType: e.mime_type as string, bytes: Buffer.from(clean, "base64") };
  });
}

/** The Content-ID a file gets from its name: the characters a `cid:` URL can
 * carry unescaped, anything else as `_`. `chart.png` is `cid:chart.png`. */
export function contentIdFor(filename: string): string {
  return safeFilename(filename).replace(/[^A-Za-z0-9._-]/g, "_");
}

/** A Content-ID copied from an inbound message, kept only as printable
 * characters that cannot close or break the header it goes into. */
function inboundContentId(raw: string | undefined): string | undefined {
  const inner = (raw ?? "").trim().replace(/^<|>$/g, "");
  return /^[\x21-\x7e]{1,250}$/.test(inner) && !/[<>"\\]/.test(inner) ? inner : undefined;
}

function driveLink(fileId: string, webViewLink: unknown): string {
  if (typeof webViewLink === "string") {
    try {
      const url = new URL(webViewLink);
      if (url.protocol === "https:" && /(^|\.)google\.com$/.test(url.hostname)) return url.toString();
    } catch {
      // fall through to the canonical form
    }
  }
  return `https://drive.google.com/open?id=${fileId}`;
}

interface DriveMeta {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  webViewLink?: string;
}

async function driveMetadata(client: GwsClient, fileId: string): Promise<DriveMeta> {
  try {
    const res = await client.api("drive", "files", "get", {
      params: { fileId, fields: "id,name,mimeType,size,webViewLink", supportsAllDrives: true },
    });
    return (res.data ?? {}) as DriveMeta;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    refuse(`Drive file ${fileId} could not be read (missing, or not shared with this account): ${why}.`);
  }
}

/** Metadata in, the per-file decision and the size check out. Nothing is
 * downloaded here; the openers it returns fetch when the message is streamed. */
export async function resolveAttachments(
  client: GwsClient,
  entries: ParsedEntry[],
  originalsIn: OriginalPart[] | Promise<OriginalPart[]> = []
): Promise<Resolved> {
  // A forward passes its originals as the pending fetch, so the Drive
  // metadata and the original message are read together.
  const [metas, originals] = await Promise.all([
    Promise.all(entries.map((e) => (e.kind === "drive" ? driveMetadata(client, e.fileId) : Promise.resolve(undefined)))),
    originalsIn,
  ]);

  const links: Resolved["links"] = [];
  // In the order the caller gave them, originals last.
  const report: ReportEntry[] = [];
  const pending: Array<Omit<PlannedFile, "open"> & { source: Parameters<typeof opener>[1] | Buffer; known?: number }> = [];
  const plan = (p: (typeof pending)[number]) => {
    pending.push(p);
    report.push(p.report);
  };

  entries.forEach((entry, i) => {
    if (entry.kind === "data") {
      const name = safeFilename(entry.filename);
      plan({
        filename: name,
        mimeType: safeMimeType(entry.mimeType),
        contentId: contentIdFor(name),
        source: entry.bytes,
        known: entry.bytes.length,
        report: { name, mode: "attached", source: "data", size: entry.bytes.length },
      });
      return;
    }
    const meta = metas[i] as DriveMeta;
    const name = safeFilename(meta.name ?? entry.fileId);
    const type = meta.mimeType ?? "";
    if (type === FOLDER) refuse(`"${name}" (${entry.fileId}) is a folder; only files can be attached.`);
    if (type.startsWith(NATIVE)) {
      if (!entry.as) {
        const link = driveLink(entry.fileId, meta.webViewLink);
        links.push({ name, link });
        report.push({ name, mode: "linked", source: "drive", file_id: entry.fileId, link });
        return;
      }
      const target = EXPORTS[type]?.[entry.as];
      if (!target) {
        refuse(`"${name}" cannot be exported as ${entry.as}: Docs export as pdf or docx, Sheets and Slides as pdf.`);
      }
      const filename = name.toLowerCase().endsWith(target.ext) ? name : `${name}${target.ext}`;
      plan({
        filename,
        mimeType: target.mimeType,
        contentId: contentIdFor(filename),
        source: { kind: "export", fileId: entry.fileId, mimeType: target.mimeType },
        report: { name: filename, mode: "exported", source: "drive", file_id: entry.fileId },
      });
      return;
    }
    if (entry.as) {
      refuse(`"${name}" is not a Google Doc, Sheet or Slides deck, so it cannot take "as"; pass the id alone to attach it as it is.`);
    }
    const size = Number(meta.size);
    if (meta.size === undefined || !Number.isFinite(size)) refuse(`"${name}" (${entry.fileId}) has no size Drive will report, so it cannot be checked against the limit.`);
    plan({
      filename: name,
      mimeType: safeMimeType(type),
      contentId: contentIdFor(name),
      source: { kind: "drive", fileId: entry.fileId },
      known: size,
      report: { name, mode: "attached", source: "drive", file_id: entry.fileId, size },
    });
  });

  for (const part of originals) {
    const name = safeFilename(part.filename);
    const source = part.attachmentId
      ? { kind: "gmail" as const, messageId: part.messageId, attachmentId: part.attachmentId }
      : Buffer.from(part.data ?? "", "base64url");
    const known = Buffer.isBuffer(source) ? source.length : (part.size ?? 0);
    plan({
      filename: name,
      mimeType: safeMimeType(part.mimeType),
      contentId: inboundContentId(part.contentId) ?? contentIdFor(name),
      source,
      known,
      report: { name, mode: "attached", source: "original", size: known },
    });
  }

  // The limit, from what is known, before anything is fetched. Exports have
  // no size until Google renders them; the budget below counts those as they
  // stream.
  let total = 0;
  for (const p of pending) {
    total += p.known ?? 0;
    if (total > TOTAL_CAP) {
      refuse(`"${p.filename}" takes the attachments to ${mb(total)}, over the ${mb(TOTAL_CAP)} limit.`);
    }
  }

  const budget = new ByteBudget(TOTAL_CAP);
  const files: PlannedFile[] = pending.map((p) => {
    const raw: Opener = Buffer.isBuffer(p.source)
      ? async function* () {
          yield p.source as Buffer;
        }
      : opener(client, p.source);
    const report = p.report;
    const open = budget.meter(p.filename, raw, (bytes) => {
      report.size = bytes;
    });
    return { filename: p.filename, mimeType: p.mimeType, contentId: p.contentId, report, open };
  });

  return { links, files, report };
}

/** Whether the HTML references this Content-ID, so the file belongs in place
 * rather than at the bottom. */
export function referencesCid(html: string | undefined, cid: string): boolean {
  if (!html) return false;
  const escaped = cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`cid:${escaped}(?![A-Za-z0-9._@-])`, "i").test(html);
}

/** The files as the builder takes them, each placed by whether the final
 * HTML references it. A file referenced inline is not listed again as an
 * attachment. */
export function placeFiles(files: PlannedFile[], html: string | undefined): ByteAttachment[] {
  return files.map((f) => {
    const inline = referencesCid(html, f.contentId);
    if (inline) {
      // An export keeps saying it was exported; where it sits is in `cid`.
      if (f.report.mode === "attached") f.report.mode = "inline";
      f.report.cid = f.contentId;
    }
    return {
      filename: f.filename,
      mimeType: f.mimeType,
      contentId: f.contentId,
      disposition: inline ? "inline" : "attachment",
      open: f.open,
    };
  });
}
