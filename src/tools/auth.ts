import type { GwsClient } from "../gws-client.js";

export const authTools = [
  {
    name: "gws_auth_setup",
    description:
      "Authenticate with Google Workspace. Opens a browser for OAuth login. Call this before using any other Google Workspace tools.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["setup", "status"],
          description:
            'Action to perform: "setup" to start OAuth login (opens browser), "status" to check current authentication state.',
        },
      },
      required: [] as string[],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
];

export async function handleAuth(
  client: GwsClient,
  args: Record<string, unknown>
) {
  const action = (args.action as string) || "setup";

  if (action === "status") {
    const result = await client.authStatus();
    return {
      content: [
        {
          type: "text" as const,
          text: result.success
            ? `Authenticated.\n${JSON.stringify(result.data, null, 2)}`
            : "Not authenticated. Use gws_auth_setup with action 'setup' to log in.",
        },
      ],
    };
  }

  const result = await client.authSetup();
  return {
    content: [
      {
        type: "text" as const,
        text: result.success
          ? "Authentication successful! You can now use Google Workspace tools."
          : `Authentication setup initiated. Follow the instructions in your browser.\n${result.stderr}`,
      },
    ],
  };
}
