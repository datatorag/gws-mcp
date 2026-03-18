import type { GwsClient } from "../gws-client.js";
import { jsonResponse } from "./response.js";
import { handleDocs } from "./docs.js";
import { handleSheets } from "./sheets.js";
import { handleSlides } from "./slides.js";

export const driveTools = [
  {
    name: "drive_search",
    description:
      "Search for files in Google Drive. Returns file names, IDs, types, and modification dates.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Search query (Drive query syntax, e.g., \"name contains 'report'\" or \"mimeType='application/vnd.google-apps.spreadsheet'\")",
        },
        page_size: {
          type: "number",
          description: "Maximum number of results to return (default: 20)",
        },
      },
      required: ["query"],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "drive_read_file",
    description:
      "Read the text content of any file in Google Drive by file ID. Supports Google Docs, Sheets, Slides, Office formats (.docx/.xlsx/.pptx — auto-converted), and plain text files. Returns extracted text directly — no local filesystem needed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_id: {
          type: "string",
          description: "The Google Drive file ID to read",
        },
      },
      required: ["file_id"],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
];

const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";
const OFFICE_PREFIX = "application/vnd.openxmlformats-officedocument";

export async function handleDrive(
  client: GwsClient,
  toolName: string,
  args: Record<string, unknown>
) {
  switch (toolName) {
    case "drive_search": {
      const result = await client.api("drive", "files", "list", {
        params: {
          q: args.query as string,
          pageSize: (args.page_size as number) || 20,
          fields: "files(id,name,mimeType,modifiedTime,size,webViewLink)",
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        },
      });
      return jsonResponse(result.data);
    }

    case "drive_read_file": {
      const fileId = args.file_id as string;

      // Step 1: Get file metadata
      const meta = await client.api("drive", "files", "get", {
        params: { fileId, fields: "id,name,mimeType", supportsAllDrives: true },
      });
      const file = meta.data as { id: string; name: string; mimeType: string };
      const { name, mimeType } = file;

      // Step 2: Route by mimeType
      const content = await readFileContent(client, fileId, name, mimeType);
      return jsonResponse({ fileId, name, mimeType, content });
    }

    default:
      throw new Error(`Unknown Drive tool: ${toolName}`);
  }
}

async function readFileContent(
  client: GwsClient,
  fileId: string,
  name: string,
  mimeType: string
): Promise<unknown> {
  // Native Google Doc
  if (mimeType === GOOGLE_DOC) {
    const result = await handleDocs(client, "docs_get", {
      document_id: fileId,
      mode: "text",
    });
    const parsed = JSON.parse(result.content[0].text);
    return parsed.text;
  }

  // Native Google Sheet
  if (mimeType === GOOGLE_SHEET) {
    const result = await handleSheets(client, "sheets_read", {
      spreadsheet_id: fileId,
      range: "A1:Z1000",
    });
    const parsed = JSON.parse(result.content[0].text);
    return parsed.values;
  }

  // Native Google Slides
  if (mimeType === GOOGLE_SLIDES) {
    const result = await handleSlides(client, "slides_get", {
      presentation_id: fileId,
    });
    const parsed = JSON.parse(result.content[0].text);
    return parsed.slides;
  }

  // Office formats → copy-convert to native, read, delete copy
  if (mimeType.startsWith(OFFICE_PREFIX)) {
    let copy: { id: string; mimeType: string } | undefined;
    try {
      const copyResult = await client.api("drive", "files", "copy", {
        params: { fileId, supportsAllDrives: true },
        jsonBody: { name: `${name} [MCP temp]`, mimeType: mimeType.includes("wordprocessing") ? GOOGLE_DOC : mimeType.includes("spreadsheet") ? GOOGLE_SHEET : GOOGLE_SLIDES },
      });
      copy = copyResult.data as { id: string; mimeType: string };
      return await readFileContent(client, copy.id, name, copy.mimeType);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to read Office file: ${msg}` };
    } finally {
      if (copy?.id) {
        await client.api("drive", "files", "delete", {
          params: { fileId: copy.id, supportsAllDrives: true },
        }).catch(() => {});
      }
    }
  }

  // Plain text / CSV (explicit types only)
  if (mimeType === "text/plain" || mimeType === "text/csv") {
    const result = await client.api("drive", "files", "get", {
      params: { fileId, alt: "media", supportsAllDrives: true },
    });
    return result.data;
  }

  // Everything else is unsupported
  return { error: `Unsupported file type: ${mimeType}` };
}
