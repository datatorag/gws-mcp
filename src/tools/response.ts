import type { GwsResult } from "../gws-client.js";

export function jsonResponse(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function deleteResponse(result: GwsResult, entityName: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: result.success
          ? `${entityName} deleted successfully.`
          : JSON.stringify(result.data, null, 2),
      },
    ],
  };
}
