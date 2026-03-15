import type { GwsClient } from "../gws-client.js";
import { jsonResponse } from "./response.js";

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
    name: "drive_upload",
    description: "Upload a file to Google Drive.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: {
          type: "string",
          description: "Local file path to upload",
        },
        name: {
          type: "string",
          description: "Name for the file in Drive (defaults to local filename)",
        },
      },
      required: ["file_path"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "drive_download",
    description: "Download a file from Google Drive by its file ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_id: {
          type: "string",
          description: "The Google Drive file ID to download",
        },
        output_path: {
          type: "string",
          description: "Local path to save the downloaded file",
        },
      },
      required: ["file_id"],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "drive_share",
    description:
      "Share a Google Drive file or folder with a user or group. Sets permissions for viewing, commenting, or editing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_id: {
          type: "string",
          description: "The Google Drive file or folder ID to share",
        },
        email: {
          type: "string",
          description: "Email address of the user or group to share with",
        },
        role: {
          type: "string",
          enum: ["reader", "commenter", "writer"],
          description:
            "Permission level: \"reader\" (view only), \"commenter\" (can comment), \"writer\" (can edit). Defaults to \"reader\".",
        },
        type: {
          type: "string",
          enum: ["user", "group", "domain", "anyone"],
          description:
            "Type of grantee. Defaults to \"user\". Use \"anyone\" for link sharing.",
        },
        send_notification: {
          type: "boolean",
          description:
            "Whether to send an email notification to the recipient (default: true)",
        },
        message: {
          type: "string",
          description: "Optional message to include in the sharing notification email",
        },
      },
      required: ["file_id", "email", "role"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
];

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
        },
      });
      return jsonResponse(result.data);
    }

    case "drive_upload": {
      const flags: Record<string, string> = {
        file: args.file_path as string,
      };
      if (args.name) flags.name = args.name as string;
      const result = await client.helper("drive", "upload", flags);
      return jsonResponse(result.data);
    }

    case "drive_download": {
      const flags: Record<string, string> = {
        "file-id": args.file_id as string,
      };
      if (args.output_path) flags.output = args.output_path as string;
      const result = await client.helper("drive", "download", flags);
      return jsonResponse(result.data);
    }

    case "drive_share": {
      const params: Record<string, unknown> = {
        fileId: args.file_id,
        sendNotificationEmail: args.send_notification !== false,
      };
      if (args.message) {
        params.emailMessage = args.message;
      }
      const result = await client.api("drive", "permissions", "create", {
        params,
        jsonBody: {
          role: args.role || "reader",
          type: (args.type as string) || "user",
          emailAddress: args.email,
        },
      });
      return jsonResponse(result.data);
    }

    default:
      throw new Error(`Unknown Drive tool: ${toolName}`);
  }
}
