import type { GwsClient } from "../gws-client.js";
import { jsonResponse } from "./response.js";

export const gmailTools = [
  {
    name: "gmail_send",
    description:
      "Send a new email via Gmail. Composes and sends an email message to the specified recipients.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: {
          type: "string",
          description: "Recipient email address(es), comma-separated",
        },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body text" },
        cc: {
          type: "string",
          description: "CC recipients, comma-separated",
        },
        bcc: {
          type: "string",
          description: "BCC recipients, comma-separated",
        },
      },
      required: ["to", "subject", "body"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "gmail_reply",
    description: "Reply to an existing email thread in Gmail.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID to reply to",
        },
        body: { type: "string", description: "Reply body text" },
      },
      required: ["message_id", "body"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "gmail_forward",
    description: "Forward an existing email to another recipient.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID to forward",
        },
        to: {
          type: "string",
          description: "Recipient email address to forward to",
        },
      },
      required: ["message_id", "to"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "gmail_triage",
    description:
      "Get an overview of recent unread emails in the Gmail inbox for triage.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [] as string[],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "gmail_read",
    description:
      "Read a specific email message by its ID. Returns the full message including headers, body, and metadata.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID to read",
        },
      },
      required: ["message_id"],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "gmail_search",
    description:
      "Search Gmail messages using Gmail search syntax. Returns matching messages with snippets. Supports queries like \"from:client@acme.com\", \"subject:proposal\", \"after:2024/01/01\", \"has:attachment\", \"label:important\".",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description:
            "Gmail search query (e.g., \"from:john@example.com subject:Q4 proposal\", \"is:unread after:2024/06/01\")",
        },
        max_results: {
          type: "number",
          description: "Maximum number of messages to return (default: 10)",
        },
      },
      required: ["query"],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "gmail_list",
    description:
      "List recent emails from the inbox. Optionally filter by label. Returns message IDs, subjects, senders, dates, and snippets.",
    inputSchema: {
      type: "object" as const,
      properties: {
        label: {
          type: "string",
          description:
            "Label to filter by (e.g., \"INBOX\", \"SENT\", \"STARRED\", \"IMPORTANT\", or custom label). Defaults to INBOX.",
        },
        max_results: {
          type: "number",
          description: "Maximum number of messages to return (default: 10)",
        },
      },
      required: [] as string[],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "gmail_create_draft",
    description:
      "Create a draft email in Gmail without sending it. The draft can be reviewed and sent later from Gmail. Returns the draft ID and a link to open it in Gmail.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: {
          type: "string",
          description: "Recipient email address(es), comma-separated",
        },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body text" },
        cc: {
          type: "string",
          description: "CC recipients, comma-separated",
        },
        bcc: {
          type: "string",
          description: "BCC recipients, comma-separated",
        },
      },
      required: ["to", "subject", "body"],
    },
    annotations: { destructiveHint: false, readOnlyHint: false },
  },
];

const METADATA_HEADERS = "From,To,Subject,Date";

async function fetchMessageList(
  client: GwsClient,
  listParams: Record<string, unknown>
) {
  const result = await client.api("gmail", "users.messages", "list", {
    params: { userId: "me", ...listParams },
  });
  const messages = (result.data as { messages?: { id: string }[] })?.messages;
  if (!messages || messages.length === 0) {
    return jsonResponse("No messages found.");
  }
  const details = await Promise.all(
    messages.map((m) =>
      client.api("gmail", "users.messages", "get", {
        params: {
          userId: "me",
          id: m.id,
          format: "metadata",
          metadataHeaders: METADATA_HEADERS,
        },
      })
    )
  );
  return jsonResponse(details.map((d) => d.data));
}

export async function handleGmail(
  client: GwsClient,
  toolName: string,
  args: Record<string, unknown>
) {
  switch (toolName) {
    case "gmail_send": {
      const flags: Record<string, string> = {
        to: args.to as string,
        subject: args.subject as string,
        body: args.body as string,
      };
      if (args.cc) flags.cc = args.cc as string;
      if (args.bcc) flags.bcc = args.bcc as string;
      const result = await client.helper("gmail", "send", flags);
      return jsonResponse(result.data);
    }

    case "gmail_reply": {
      const result = await client.helper("gmail", "reply", {
        "message-id": args.message_id as string,
        body: args.body as string,
      });
      return jsonResponse(result.data);
    }

    case "gmail_forward": {
      const result = await client.helper("gmail", "forward", {
        "message-id": args.message_id as string,
        to: args.to as string,
      });
      return jsonResponse(result.data);
    }

    case "gmail_triage": {
      const result = await client.helper("gmail", "triage", {});
      return jsonResponse(result.data);
    }

    case "gmail_read": {
      const result = await client.api("gmail", "users.messages", "get", {
        params: {
          userId: "me",
          id: args.message_id,
          format: "full",
        },
      });
      return jsonResponse(result.data);
    }

    case "gmail_search":
      return fetchMessageList(client, {
        q: args.query,
        maxResults: (args.max_results as number) || 10,
      });

    case "gmail_list":
      return fetchMessageList(client, {
        labelIds: (args.label as string) || "INBOX",
        maxResults: (args.max_results as number) || 10,
      });

    case "gmail_create_draft": {
      const headers = [
        `To: ${args.to as string}`,
        `Subject: ${args.subject as string}`,
      ];
      if (args.cc) headers.push(`Cc: ${args.cc as string}`);
      if (args.bcc) headers.push(`Bcc: ${args.bcc as string}`);
      headers.push("Content-Type: text/plain; charset=utf-8");
      const raw = Buffer.from(
        `${headers.join("\r\n")}\r\n\r\n${args.body as string}`
      )
        .toString("base64url");
      const result = await client.api("gmail", "users.drafts", "create", {
        params: { userId: "me" },
        jsonBody: { message: { raw } },
      });
      const draft = result.data as {
        id?: string;
        message?: { id?: string };
      };
      const messageId = draft?.message?.id || "";
      return jsonResponse({
        ...draft,
        gmail_url: `https://mail.google.com/mail/u/0/#drafts?compose=${messageId}`,
      });
    }

    default:
      throw new Error(`Unknown Gmail tool: ${toolName}`);
  }
}
