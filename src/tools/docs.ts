import type { GwsClient } from "../gws-client.js";
import { jsonResponse, deleteResponse } from "./response.js";

export const docsTools = [
  {
    name: "docs_get",
    description:
      'Get the content of a Google Doc. Three modes: "text" (default) returns plain text — use for reading/summarizing. "index" returns text with startIndex/endIndex — use before positional edits (insertText at index, deleteContentRange). "full" returns the raw API response — use only for debugging or style operations.',
    inputSchema: {
      type: "object" as const,
      properties: {
        document_id: {
          type: "string",
          description: "The Google Docs document ID (from the URL)",
        },
        mode: {
          type: "string",
          enum: ["text", "index", "full"],
          description:
            '"text" (default): plain text. "index": text with character positions for edits. "full": raw API response.',
        },
      },
      required: ["document_id"],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "docs_write",
    description: "Write/append text content to a Google Doc.",
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
            'Array of update request objects. Each can be: insertText ({ insertText: { location: { index: 1 }, text: "Hello" } }), replaceAllText ({ replaceAllText: { containsText: { text: "old", matchCase: true }, replaceText: "new" } }), deleteContentRange ({ deleteContentRange: { range: { startIndex: 1, endIndex: 10 } } })',
          items: { type: "object" },
        },
      },
      required: ["document_id", "requests"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "docs_create",
    description: "Create a new Google Doc.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Title for the new document",
        },
      },
      required: ["title"],
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

interface DocElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: {
    elements?: Array<{
      startIndex?: number;
      endIndex?: number;
      textRun?: { content?: string };
    }>;
  };
}

function extractText(data: Record<string, unknown>): {
  documentId: unknown;
  title: unknown;
  text: string;
} {
  const body = data.body as { content?: DocElement[] } | undefined;
  const elements = body?.content || [];
  const parts: string[] = [];
  for (const el of elements) {
    if (el.paragraph?.elements) {
      for (const run of el.paragraph.elements) {
        if (run.textRun?.content) parts.push(run.textRun.content);
      }
    }
  }
  return {
    documentId: data.documentId,
    title: data.title,
    text: parts.join(""),
  };
}

function extractIndexed(data: Record<string, unknown>): {
  documentId: unknown;
  title: unknown;
  content: Array<{ startIndex: number; endIndex: number; text: string }>;
} {
  const body = data.body as { content?: DocElement[] } | undefined;
  const elements = body?.content || [];
  const content: Array<{ startIndex: number; endIndex: number; text: string }> =
    [];
  for (const el of elements) {
    if (el.paragraph?.elements) {
      for (const run of el.paragraph.elements) {
        if (run.textRun?.content) {
          content.push({
            startIndex: run.startIndex ?? 0,
            endIndex: run.endIndex ?? 0,
            text: run.textRun.content,
          });
        }
      }
    }
  }
  return { documentId: data.documentId, title: data.title, content };
}

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
      const mode = (args.mode as string) || "text";
      const data = result.data as Record<string, unknown>;
      if (mode === "text") return jsonResponse(extractText(data));
      if (mode === "index") return jsonResponse(extractIndexed(data));
      return jsonResponse(data);
    }

    case "docs_write": {
      const result = await client.api("docs", "documents", "batchUpdate", {
        params: { documentId: args.document_id },
        jsonBody: {
          requests: [
            { insertText: { location: { index: 1 }, text: args.text } },
          ],
        },
      });
      return jsonResponse(result.data);
    }

    case "docs_create": {
      const result = await client.api("docs", "documents", "create", {
        jsonBody: { title: args.title },
      });
      const d = result.data as Record<string, unknown>;
      return jsonResponse({ documentId: d.documentId, title: d.title });
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
        params: { fileId: args.document_id, supportsAllDrives: true },
      });
      return deleteResponse(result, "Document");
    }

    default:
      throw new Error(`Unknown Docs tool: ${toolName}`);
  }
}
