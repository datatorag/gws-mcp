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

export function deleteResponse(entityName: string) {
  return textResponse(`${entityName} deleted successfully.`);
}

/** Sheets, Docs, and Slides are Drive files — deleting them is a Drive operation. */
export function deleteDriveFile(client: GwsClient, fileId: unknown) {
  return client.api("drive", "files", "delete", {
    params: { fileId, supportsAllDrives: true },
  });
}
