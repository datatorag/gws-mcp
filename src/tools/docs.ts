import type { GwsClient } from "../gws-client.js";
import { jsonResponse, deleteResponse } from "./response.js";

export const docsTools = [
  {
    name: "docs_get",
    description:
      "Get the content of a Google Doc by its document ID. Returns the document structure and text content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        document_id: {
          type: "string",
          description: "The Google Docs document ID (from the URL)",
        },
      },
      required: ["document_id"],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "docs_write",
    description:
      "Write/append text content to a Google Doc.",
    inputSchema: {
      type: "object" as const,
      properties: {
        document_id: {
          type: "string",
          description: "The Google Docs document ID",
        },
        text: {
          type: "string",
          description: "Text content to write to the document",
        },
      },
      required: ["document_id", "text"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "docs_batch_update",
    description:
      "Apply batch updates to a Google Doc. Supports inserting text, replacing text, deleting content ranges, and other document modifications. Uses the Google Docs API batchUpdate format.",
    inputSchema: {
      type: "object" as const,
      properties: {
        document_id: {
          type: "string",
          description: "The Google Docs document ID",
        },
        requests: {
          type: "array",
          description:
            "Array of update request objects. Each can be: insertText ({ insertText: { location: { index: 1 }, text: \"Hello\" } }), replaceAllText ({ replaceAllText: { containsText: { text: \"old\", matchCase: true }, replaceText: \"new\" } }), deleteContentRange ({ deleteContentRange: { range: { startIndex: 1, endIndex: 10 } } })",
          items: { type: "object" },
        },
      },
      required: ["document_id", "requests"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "docs_delete",
    description:
      "Delete a Google Doc. This permanently removes the document from Drive.",
    inputSchema: {
      type: "object" as const,
      properties: {
        document_id: {
          type: "string",
          description: "The document ID to delete",
        },
      },
      required: ["document_id"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
];

export async function handleDocs(
  client: GwsClient,
  toolName: string,
  args: Record<string, unknown>
) {
  switch (toolName) {
    case "docs_get": {
      const result = await client.api("docs", "documents", "get", {
        params: { documentId: args.document_id },
      });
      return jsonResponse(result.data);
    }

    case "docs_write": {
      const flags: Record<string, string> = {
        "document-id": args.document_id as string,
        text: args.text as string,
      };
      const result = await client.helper("docs", "write", flags);
      return jsonResponse(result.data);
    }

    case "docs_batch_update": {
      const result = await client.api("docs", "documents", "batchUpdate", {
        params: { documentId: args.document_id },
        jsonBody: { requests: args.requests },
      });
      return jsonResponse(result.data);
    }

    case "docs_delete": {
      const result = await client.api("drive", "files", "delete", {
        params: { fileId: args.document_id },
      });
      return deleteResponse(result, "Document");
    }

    default:
      throw new Error(`Unknown Docs tool: ${toolName}`);
  }
}
