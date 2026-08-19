import type { GwsClient } from "../gws-client.js";
import { deleteResponse } from "./response.js";

/** Sheets, Docs, and Slides are Drive files — deleting them is a Drive
 * operation. Lives here rather than in response.ts so the response module
 * stays pure formatting and anyone auditing what can delete files finds
 * every path in one place. */
export function deleteDriveFile(client: GwsClient, fileId: unknown) {
  return client.api("drive", "files", "delete", {
    params: { fileId, supportsAllDrives: true },
  });
}

/** The delete-and-confirm shape shared by docs_delete, sheets_delete, and
 * slides_delete. */
export async function deleteDriveFileResponse(
  client: GwsClient,
  fileId: unknown,
  entityName: string
) {
  await deleteDriveFile(client, fileId);
  return deleteResponse(entityName);
}
