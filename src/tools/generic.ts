import type { GwsClient } from "../gws-client.js";
import { jsonResponse } from "./response.js";

export const genericTools = [
  {
    name: "gws_run",
    description:
      "Run any Google Workspace API command. Use this for services not covered by dedicated tools (Calendar, Chat, Admin, etc.) or for advanced API operations. Commands follow the pattern: gws <service> <resource> <method>.",
    inputSchema: {
      type: "object" as const,
      properties: {
        service: {
          type: "string",
          description:
            "Google Workspace service (e.g., calendar, chat, admin, classroom, contacts, drive, gmail, sheets, docs, slides)",
        },
        resource: {
          type: "string",
          description:
            "API resource (e.g., events, spaces, users, files, messages)",
        },
        method: {
          type: "string",
          description: "API method (e.g., list, get, create, update, delete)",
        },
        params: {
          type: "object",
          description:
            "Query parameters as key-value pairs (e.g., { pageSize: 10, q: \"search query\" })",
        },
        json_body: {
          type: "object",
          description: "Request body for create/update operations",
        },
        page_all: {
          type: "boolean",
          description:
            "Fetch all pages of results (default: false, max 10 pages)",
        },
        dry_run: {
          type: "boolean",
          description: "Preview the request without executing it",
        },
      },
      required: ["service", "resource", "method"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
];

export async function handleGeneric(
  client: GwsClient,
  args: Record<string, unknown>
) {
  const result = await client.api(
    args.service as string,
    args.resource as string,
    args.method as string,
    {
      params: args.params as Record<string, unknown> | undefined,
      jsonBody: args.json_body,
      pageAll: args.page_all as boolean | undefined,
      dryRun: args.dry_run as boolean | undefined,
    }
  );

  return jsonResponse(result.data);
}
