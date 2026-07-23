import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { GwsClient } from "../gws-client.js";
import { jsonResponse, stripHtml, truncate } from "./response.js";

// Shared to/subject/body/cc/bcc schema for gmail_send and the draft tools
const emailFields = {
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
};

export const gmailTools = [
  {
    name: "gmail_send",
    description:
      "Send a new email via Gmail. Composes and sends an email message to the specified recipients.",
    inputSchema: {
      type: "object" as const,
      properties: { ...emailFields },
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
    name: "gmail_read",
    description:
      "Read a specific email message by its ID. By default returns the full message including headers, body, and metadata. Use text_only for a compact view (flattened headers, decoded text body, attachment metadata) that avoids large MIME/base64 payloads.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID to read",
        },
        text_only: {
          type: "boolean",
          description:
            "Return a compact view instead of the raw MIME payload: flattened from/to/cc/subject/date headers, the decoded text/plain body (falls back to tag-stripped text/html), and attachment metadata (filename, mimeType, attachmentId). Recommended for triage — avoids base64 attachment data overflowing the response.",
        },
        max_body_chars: {
          type: "number",
          description:
            "Truncate the returned body text to this many characters (adds a truncation marker). Implies text_only.",
        },
      },
      required: ["message_id"],
    },
    annotations: { destructiveHint: false, readOnlyHint: true },
  },
  {
    name: "gmail_search",
    description:
      "Search Gmail messages using Gmail search syntax. Returns matching messages with flattened from/to/subject/date fields plus snippet and labels. Supports queries like \"from:client@acme.com\", \"subject:proposal\", \"after:2024/01/01\", \"has:attachment\", \"label:important\".",
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
      "List recent emails from the inbox. Optionally filter by label. Returns message IDs with flattened from/to/subject/date fields plus snippet and labels.",
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
      properties: { ...emailFields },
      required: ["to", "subject", "body"],
    },
    annotations: { destructiveHint: false, readOnlyHint: false },
  },
  {
    name: "gmail_update_draft",
    description:
      "Update an existing draft email in Gmail. This fully replaces the draft's message content (Gmail API does not support partial edits). If thread_id is omitted, the tool preserves the existing thread automatically.",
    inputSchema: {
      type: "object" as const,
      properties: {
        draft_id: {
          type: "string",
          description: "The Gmail draft ID to update",
        },
        ...emailFields,
        thread_id: {
          type: "string",
          description:
            "Thread ID to preserve threading. If omitted, the existing draft's thread is preserved automatically.",
        },
      },
      required: ["draft_id", "to", "subject", "body"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "gmail_send_draft",
    description:
      "Send an existing Gmail draft by its draft ID. Use this to send a draft that was previously created with gmail_create_draft and reviewed — it sends the draft as-is and removes it from the Drafts folder (no orphaned draft). Returns the sent message metadata.",
    inputSchema: {
      type: "object" as const,
      properties: {
        draft_id: {
          type: "string",
          description: "The Gmail draft ID to send",
        },
      },
      required: ["draft_id"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "gmail_delete_draft",
    description:
      "Permanently delete a Gmail draft by its draft ID. This does not move the draft to Trash — it is removed immediately. Use gmail_send_draft to send a draft instead of deleting it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        draft_id: {
          type: "string",
          description: "The Gmail draft ID to delete",
        },
      },
      required: ["draft_id"],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "gmail_mark_read",
    description:
      "Mark one or more Gmail messages as read by removing the UNREAD label. Can also add or remove other labels. Pass message_id for a single message (returns the modified message) or message_ids for a batch (up to 1000, single API call via users.messages.batchModify).",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "string",
          description:
            "A single Gmail message ID to modify. Provide either this or message_ids.",
        },
        message_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Multiple Gmail message IDs to modify in one batch call (max 1000). Provide either this or message_id.",
        },
        add_labels: {
          type: "array",
          items: { type: "string" },
          description:
            'Label IDs to add (e.g., ["STARRED", "IMPORTANT"]). Optional.',
        },
        remove_labels: {
          type: "array",
          items: { type: "string" },
          description:
            'Label IDs to remove (e.g., ["UNREAD", "INBOX"]). Defaults to ["UNREAD"] if neither add_labels nor remove_labels is provided.',
        },
      },
      required: [] as string[],
    },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "gmail_save_attachment_to_drive",
    description:
      "Save a Gmail attachment directly to Google Drive. Use gmail_read first to get attachment metadata (filename, mimeType, attachmentId) from the message parts. The file is fetched from Gmail and uploaded to Drive server-side — no base64 data flows through the conversation. Returns the Drive file metadata including a web link.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID that contains the attachment",
        },
        attachment_id: {
          type: "string",
          description:
            "The attachment ID from the message part's body.attachmentId field",
        },
        filename: {
          type: "string",
          description: "Filename to save as in Drive (e.g., 'report.xlsx')",
        },
        parent_folder_id: {
          type: "string",
          description:
            "Optional Drive folder ID to save into. If omitted, saves to the root of My Drive.",
        },
      },
      required: ["message_id", "attachment_id", "filename"],
    },
    annotations: { destructiveHint: false, readOnlyHint: false },
  },
];

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart & { headers?: { name: string; value: string }[] };
}

function getHeader(msg: GmailMessage, name: string): string | undefined {
  const lower = name.toLowerCase();
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === lower)
    ?.value;
}

function flattenMessage(msg: GmailMessage) {
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: getHeader(msg, "From"),
    to: getHeader(msg, "To"),
    subject: getHeader(msg, "Subject"),
    date: getHeader(msg, "Date"),
    snippet: msg.snippet,
    labelIds: msg.labelIds,
  };
}

function findPart(
  part: GmailPart | undefined,
  mimeType: string
): GmailPart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const p of part.parts ?? []) {
    const found = findPart(p, mimeType);
    if (found) return found;
  }
  return undefined;
}

function extractTextBody(payload: GmailPart | undefined): string {
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) {
    return Buffer.from(plain.body.data, "base64url").toString("utf-8");
  }
  const html = findPart(payload, "text/html");
  if (html?.body?.data) {
    return stripHtml(
      Buffer.from(html.body.data, "base64url").toString("utf-8")
    );
  }
  return "";
}

function listAttachments(
  part: GmailPart | undefined,
  out: {
    filename?: string;
    mimeType?: string;
    attachmentId: string;
    size?: number;
  }[] = []
) {
  if (part?.body?.attachmentId) {
    out.push({
      filename: part.filename,
      mimeType: part.mimeType,
      attachmentId: part.body.attachmentId,
      size: part.body.size,
    });
  }
  for (const p of part?.parts ?? []) listAttachments(p, out);
  return out;
}

function buildRawMessage(args: Record<string, unknown>): string {
  const headers = [
    `To: ${args.to as string}`,
    `Subject: ${args.subject as string}`,
  ];
  if (args.cc) headers.push(`Cc: ${args.cc as string}`);
  if (args.bcc) headers.push(`Bcc: ${args.bcc as string}`);
  headers.push("Content-Type: text/plain; charset=utf-8");
  return Buffer.from(
    `${headers.join("\r\n")}\r\n\r\n${args.body as string}`
  ).toString("base64url");
}

function draftResponse(data: unknown) {
  const draft = data as { id?: string; message?: { id?: string; threadId?: string } };
  const messageId = draft?.message?.id || "";
  return jsonResponse({
    ...draft,
    gmail_url: `https://mail.google.com/mail/u/0/#drafts?compose=${messageId}`,
  });
}

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
        // NOTE: no metadataHeaders filter — the gws CLI can only serialize
        // scalar query params, and a comma-joined value matches no header
        // name, silently returning zero headers. Plain metadata format
        // returns all headers; we flatten to the few we need below.
        params: {
          userId: "me",
          id: m.id,
          format: "metadata",
        },
      })
    )
  );
  return jsonResponse(
    details.map((d) => flattenMessage(d.data as GmailMessage))
  );
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

    case "gmail_read": {
      const result = await client.api("gmail", "users.messages", "get", {
        params: {
          userId: "me",
          id: args.message_id,
          format: "full",
        },
      });
      const maxBodyChars = args.max_body_chars as number | undefined;
      if (!args.text_only && maxBodyChars === undefined) {
        return jsonResponse(result.data);
      }

      const msg = result.data as GmailMessage;
      let body = extractTextBody(msg.payload);
      if (maxBodyChars !== undefined) {
        body = truncate(body, maxBodyChars);
      }
      return jsonResponse({
        ...flattenMessage(msg),
        cc: getHeader(msg, "Cc"),
        body,
        attachments: listAttachments(msg.payload),
      });
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

    case "gmail_save_attachment_to_drive": {
      // 1. Fetch attachment data from Gmail (stays in Node.js memory)
      const attachResult = await client.api(
        "gmail",
        "users.messages.attachments",
        "get",
        {
          params: {
            userId: "me",
            messageId: args.message_id,
            id: args.attachment_id,
          },
        }
      );
      const attachData = attachResult.data as { data?: string; size?: number };
      if (!attachData?.data) {
        throw new Error("No attachment data returned from Gmail API");
      }

      // 2. Decode base64url to temp file
      const tmpFile = join(tmpdir(), `gws-attach-${randomUUID()}`);
      try {
        const buf = Buffer.from(attachData.data, "base64url");
        await writeFile(tmpFile, buf);

        // 3. Upload to Drive via gws CLI helper
        const uploadArgs = [
          "drive",
          "+upload",
          tmpFile,
          "--name",
          args.filename as string,
        ];
        if (args.parent_folder_id) {
          uploadArgs.push("--parent", args.parent_folder_id as string);
        }
        const uploadResult = await client.exec(uploadArgs, {
          timeout: 120_000,
        });
        return jsonResponse(uploadResult.data);
      } finally {
        // 4. Clean up temp file
        try {
          await unlink(tmpFile);
        } catch {
          // ignore cleanup errors
        }
      }
    }

    case "gmail_create_draft": {
      const raw = buildRawMessage(args);
      const result = await client.api("gmail", "users.drafts", "create", {
        params: { userId: "me" },
        jsonBody: { message: { raw } },
      });
      return draftResponse(result.data);
    }

    case "gmail_update_draft": {
      let threadId = args.thread_id as string | undefined;
      if (!threadId) {
        const existing = await client.api("gmail", "users.drafts", "get", {
          params: { userId: "me", id: args.draft_id, format: "metadata" },
        });
        const existingData = existing.data as {
          message?: { threadId?: string };
        };
        threadId = existingData?.message?.threadId;
      }

      const raw = buildRawMessage(args);
      const message: Record<string, unknown> = { raw };
      if (threadId) message.threadId = threadId;

      const result = await client.api("gmail", "users.drafts", "update", {
        params: { userId: "me", id: args.draft_id },
        jsonBody: { message },
      });
      return draftResponse(result.data);
    }

    case "gmail_send_draft": {
      const result = await client.api("gmail", "users.drafts", "send", {
        params: { userId: "me" },
        jsonBody: { id: args.draft_id },
      });
      return jsonResponse(result.data);
    }

    case "gmail_delete_draft": {
      await client.api("gmail", "users.drafts", "delete", {
        params: { userId: "me", id: args.draft_id },
      });
      return jsonResponse({ deleted: true, draft_id: args.draft_id });
    }

    case "gmail_mark_read": {
      const addLabels = args.add_labels as string[] | undefined;
      const removeLabels = args.remove_labels as string[] | undefined;
      const body: Record<string, unknown> = {};
      if (addLabels?.length) body.addLabelIds = addLabels;
      body.removeLabelIds = removeLabels?.length ? removeLabels : ["UNREAD"];

      const ids = args.message_ids as string[] | undefined;
      if (ids?.length) {
        // batchModify returns an empty body on success
        await client.api("gmail", "users.messages", "batchModify", {
          params: { userId: "me" },
          jsonBody: { ids, ...body },
        });
        return jsonResponse({ modified: ids.length, ids, ...body });
      }

      if (!args.message_id) {
        throw new Error("Provide either message_id or message_ids");
      }
      const result = await client.api("gmail", "users.messages", "modify", {
        params: { userId: "me", id: args.message_id },
        jsonBody: body,
      });
      return jsonResponse(result.data);
    }

    default:
      throw new Error(`Unknown Gmail tool: ${toolName}`);
  }
}
