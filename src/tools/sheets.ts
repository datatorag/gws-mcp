import type { GwsClient } from "../gws-client.js";
import { jsonResponse, deleteResponse } from "./response.js";

export const sheetsTools = [
  {
    name: "sheets_read",
    description:
      "Read data from a Google Sheets spreadsheet. Returns cell values for the specified range.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheet_id: {
          type: "string",
          description: "The spreadsheet ID (from the URL)",
        },
        range: {
          type: "string",
          description:
            "Cell range in A1 notation (e.g., \"Sheet1!A1:D10\", \"A1:Z\")",
        },
      },
      required: ["spreadsheet_id", "range"],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "sheets_update",
    description:
      "Update specific cells in a Google Sheets spreadsheet. Overwrites existing values in the specified range.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheet_id: {
          type: "string",
          description: "The spreadsheet ID",
        },
        range: {
          type: "string",
          description: "Cell range in A1 notation (e.g., \"Sheet1!A1:B2\")",
        },
        values: {
          type: "array",
          items: {
            type: "array",
            items: { type: "string" },
          },
          description:
            "2D array of values to write (rows of columns), e.g., [[\"A1\",\"B1\"],[\"A2\",\"B2\"]]",
        },
      },
      required: ["spreadsheet_id", "range", "values"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "sheets_append",
    description:
      "Append rows to the end of a Google Sheets spreadsheet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheet_id: {
          type: "string",
          description: "The spreadsheet ID",
        },
        values: {
          type: "array",
          items: {
            type: "array",
            items: { type: "string" },
          },
          description:
            "2D array of rows to append, e.g., [[\"val1\",\"val2\"],[\"val3\",\"val4\"]]",
        },
        range: {
          type: "string",
          description:
            "Target range for appending (default: first sheet). e.g., \"Sheet1!A1\"",
        },
      },
      required: ["spreadsheet_id", "values"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "sheets_create",
    description: "Create a new Google Sheets spreadsheet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Title for the new spreadsheet",
        },
        headers: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional header row values, e.g., [\"Name\", \"Email\", \"Date\"]",
        },
      },
      required: ["title"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "sheets_delete",
    description:
      "Delete a Google Sheets spreadsheet. This permanently removes the file from Drive.",
    inputSchema: {
      type: "object" as const,
      properties: {
        spreadsheet_id: {
          type: "string",
          description: "The spreadsheet ID to delete",
        },
      },
      required: ["spreadsheet_id"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
];

export async function handleSheets(
  client: GwsClient,
  toolName: string,
  args: Record<string, unknown>
) {
  switch (toolName) {
    case "sheets_read": {
      const flags: Record<string, string> = {
        "spreadsheet-id": args.spreadsheet_id as string,
        range: args.range as string,
      };
      const result = await client.helper("sheets", "read", flags);
      return jsonResponse(result.data);
    }

    case "sheets_update": {
      const result = await client.api(
        "sheets",
        "spreadsheets.values",
        "update",
        {
          params: {
            spreadsheetId: args.spreadsheet_id,
            range: args.range,
            valueInputOption: "USER_ENTERED",
          },
          jsonBody: {
            values: args.values,
          },
        }
      );
      return jsonResponse(result.data);
    }

    case "sheets_append": {
      const flags: Record<string, string> = {
        "spreadsheet-id": args.spreadsheet_id as string,
        values: JSON.stringify(args.values),
      };
      if (args.range) flags.range = args.range as string;
      const result = await client.helper("sheets", "append", flags);
      return jsonResponse(result.data);
    }

    case "sheets_create": {
      const flags: Record<string, string> = {
        title: args.title as string,
      };
      if (args.headers) {
        flags.headers = JSON.stringify(args.headers);
      }
      const result = await client.helper("sheets", "create", flags);
      return jsonResponse(result.data);
    }

    case "sheets_delete": {
      const result = await client.api("drive", "files", "delete", {
        params: { fileId: args.spreadsheet_id },
      });
      return deleteResponse(result, "Spreadsheet");
    }

    default:
      throw new Error(`Unknown Sheets tool: ${toolName}`);
  }
}
