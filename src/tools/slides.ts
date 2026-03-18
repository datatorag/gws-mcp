import type { GwsClient } from "../gws-client.js";
import { jsonResponse, deleteResponse } from "./response.js";

export const slidesTools = [
  {
    name: "slides_get",
    description:
      "Get the content of a Google Slides presentation. Returns slide objectIds, placeholder types (TITLE/BODY/SUBTITLE), and text content — stripped of layout/styling data to fit context windows. Use the returned objectIds with slides_batch_update for edits.",
    inputSchema: {
      type: "object" as const,
      properties: {
        presentation_id: {
          type: "string",
          description: "The Google Slides presentation ID (from the URL)",
        },
      },
      required: ["presentation_id"],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "slides_create",
    description:
      "Create a new Google Slides presentation. Returns the presentationId and a placeholder_map for each slide mapping placeholder types (TITLE, BODY, SUBTITLE) to their objectIds — use these with slides_batch_update insertText.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Title for the new presentation",
        },
      },
      required: ["title"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "slides_batch_update",
    description:
      "Apply batch updates to a Google Slides presentation. Supports inserting text, replacing text, creating slides, deleting objects, and other modifications. Uses the Google Slides API batchUpdate format.",
    inputSchema: {
      type: "object" as const,
      properties: {
        presentation_id: {
          type: "string",
          description: "The presentation ID",
        },
        requests: {
          type: "array",
          description:
            "Array of update request objects. Examples: createSlide ({ createSlide: { slideLayoutReference: { predefinedLayout: \"TITLE_AND_BODY\" } } }), insertText ({ insertText: { objectId: \"slideId\", text: \"Hello\", insertionIndex: 0 } }), replaceAllText ({ replaceAllText: { containsText: { text: \"old\" }, replaceText: \"new\" } }), deleteObject ({ deleteObject: { objectId: \"elementId\" } })",
          items: { type: "object" },
        },
      },
      required: ["presentation_id", "requests"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "slides_delete",
    description:
      "Delete a Google Slides presentation. This permanently removes the file from Drive.",
    inputSchema: {
      type: "object" as const,
      properties: {
        presentation_id: {
          type: "string",
          description: "The presentation ID to delete",
        },
      },
      required: ["presentation_id"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
];

interface SlideElement {
  objectId?: string;
  shape?: {
    placeholder?: { type?: string };
    text?: {
      textElements?: Array<{
        textRun?: { content?: string };
      }>;
    };
  };
}

interface SlideData {
  objectId?: string;
  pageElements?: SlideElement[];
}

function trimPresentation(data: Record<string, unknown>) {
  const slides = (data.slides as SlideData[]) || [];
  return {
    presentationId: data.presentationId,
    title: data.title,
    slides: slides.map((slide) => {
      const elements = (slide.pageElements || [])
        .filter((el) => el.shape?.placeholder || el.shape?.text?.textElements?.length)
        .map((el) => {
          const textElements = el.shape?.text?.textElements || [];
          const text = textElements
            .map((te) => te.textRun?.content || "")
            .join("");
          const result: { objectId?: string; placeholderType?: string; text?: string } = {
            objectId: el.objectId,
          };
          if (el.shape?.placeholder?.type) {
            result.placeholderType = el.shape.placeholder.type;
          }
          result.text = text || undefined;
          return result;
        });

      const placeholderMap: Record<string, string> = {};
      for (const el of elements) {
        if (el.placeholderType && el.objectId) {
          placeholderMap[el.placeholderType] = el.objectId;
        }
      }

      return {
        objectId: slide.objectId,
        placeholder_map: placeholderMap,
        elements,
      };
    }),
  };
}

export async function handleSlides(
  client: GwsClient,
  toolName: string,
  args: Record<string, unknown>
) {
  switch (toolName) {
    case "slides_get": {
      const result = await client.api("slides", "presentations", "get", {
        params: { presentationId: args.presentation_id },
      });
      return jsonResponse(trimPresentation(result.data as Record<string, unknown>));
    }

    case "slides_create": {
      const result = await client.api("slides", "presentations", "create", {
        jsonBody: { title: args.title },
      });
      return jsonResponse(trimPresentation(result.data as Record<string, unknown>));
    }

    case "slides_batch_update": {
      const result = await client.api(
        "slides",
        "presentations",
        "batchUpdate",
        {
          params: { presentationId: args.presentation_id },
          jsonBody: { requests: args.requests },
        }
      );
      return jsonResponse(result.data);
    }

    case "slides_delete": {
      const result = await client.api("drive", "files", "delete", {
        params: { fileId: args.presentation_id, supportsAllDrives: true },
      });
      return deleteResponse(result, "Presentation");
    }

    default:
      throw new Error(`Unknown Slides tool: ${toolName}`);
  }
}
