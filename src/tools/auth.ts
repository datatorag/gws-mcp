import type { GwsClient } from "../gws-client.js";

export const authTools = [
  {
    name: "gws_auth_setup",
    description:
      "Check or manage Google Workspace authentication. In HTTP mode, auth is handled via the MCP OAuth flow. In extension/stdio mode (Claude Desktop), use action 'login' to authenticate or re-authenticate with updated scopes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["status", "login"],
          description:
            "Action to perform: 'status' (default) checks auth state, 'login' triggers browser-based OAuth login (extension/stdio mode only).",
        },
        services: {
          type: "string" as const,
          description:
            "Comma-separated services to request scopes for (e.g. 'drive,gmail,tasks'). Only used with action 'login'. Defaults to all supported services.",
        },
      },
      required: [] as string[],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
];

const DEFAULT_SERVICES = "drive,gmail,sheets,calendar,docs,slides,people,tasks";

export async function handleAuth(
  client: GwsClient,
  args: Record<string, unknown>
) {
  const action = (args.action as string) || "status";

  if (action === "login") {
    const services = (args.services as string) || DEFAULT_SERVICES;
    const child = client.spawnAuth(services);

    // Collect stderr to find the auth URL
    let authUrl = "";
    await new Promise<void>((resolve) => {
      let buf = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const match = buf.match(
          /(https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s]+)/
        );
        if (match) {
          authUrl = match[1];
        }
      });
      child.on("close", () => resolve());
      // Timeout after 10s if the process hangs
      setTimeout(() => resolve(), 10_000);
    });

    if (authUrl) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Open this URL in your browser to authenticate:\n\n  ${authUrl}\n\nAfter authenticating, try your request again.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: "Authentication login triggered. If a browser window didn't open, check the server logs.",
        },
      ],
    };
  }

  // Default: status
  const result = await client.authStatus();
  return {
    content: [
      {
        type: "text" as const,
        text: result.success
          ? `Authenticated.\n${JSON.stringify(result.data, null, 2)}`
          : "Not authenticated. Use action 'login' to authenticate (extension/stdio mode) or reconnect via MCP OAuth (HTTP mode).",
      },
    ],
  };
}
