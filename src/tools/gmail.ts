import { writeFile, unlink } from "node:fs/promises";
import { CREATE, MUTATE, READ, ToolDef } from "./annotations.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { GwsClient } from "../gws-client.js";
import { deleteResponse, jsonResponse, stripHtml, truncate } from "./response.js";

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

export const gmailTools: ToolDef[] = [
  {
    name: "gmail_send",
    description:
      "Send a new email via Gmail. Composes and sends an email message to the specified recipients.",
    inputSchema: {
      type: "object" as const,
      properties: { ...emailFields },
      required: ["to", "subject", "body"],
    },
    annotations: MUTATE("Send email"),
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
    annotations: MUTATE("Reply to email"),
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
    annotations: MUTATE("Forward email"),
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
    annotations: READ("Read email"),
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
    annotations: READ("Search email"),
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
    annotations: READ("List emails"),
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
    annotations: CREATE("Create email draft"),
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
    annotations: MUTATE("Update email draft"),
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
    annotations: MUTATE("Send email draft"),
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
    annotations: MUTATE("Delete email draft"),
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
    annotations: MUTATE("Change email read state and labels"),
  },
  {
    name: "gmail_list_filters",
    description:
      "List all Gmail filters (settings > filters) with their criteria and actions. Use this to find a filter's ID before deleting it, or to check what automation already exists before creating a new filter.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [] as string[],
    },
    annotations: READ("List email filters"),
  },
  {
    name: "gmail_create_filter",
    description:
      "Create a Gmail filter that automatically applies actions to matching incoming mail (e.g. label, archive, mark as read). Requires at least one criteria field and one action field. Note: Gmail filters are immutable — to change an existing filter, create the new one and delete the old with gmail_delete_filter. Requires the gmail.settings.basic scope; if this returns an insufficient-scopes error, re-authenticate with gws_auth_setup action 'login'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        from: {
          type: "string",
          description: "Match messages from this sender (email or domain)",
        },
        to: {
          type: "string",
          description: "Match messages sent to this recipient",
        },
        subject: {
          type: "string",
          description: "Match messages with this subject text",
        },
        query: {
          type: "string",
          description:
            'Gmail search query to match (e.g. "list:newsletter@example.com has:attachment")',
        },
        negated_query: {
          type: "string",
          description: "Gmail search query that matching messages must NOT match",
        },
        add_labels: {
          type: "array",
          items: { type: "string" },
          description:
            'Label IDs to apply to matching messages (e.g. a label ID from gmail_create_label, or "STARRED", "IMPORTANT")',
        },
        remove_labels: {
          type: "array",
          items: { type: "string" },
          description:
            'Label IDs to remove from matching messages (e.g. ["UNREAD"] to auto-mark-read, ["INBOX"] to archive)',
        },
        forward_to: {
          type: "string",
          description:
            "Forward matching messages to this address (must be a verified forwarding address)",
        },
      },
      required: [] as string[],
    },
    annotations: CREATE("Create email filter"),
  },
  {
    name: "gmail_delete_filter",
    description:
      "Delete a Gmail filter by its ID (find IDs with gmail_list_filters). Deleting a filter does not undo actions it already applied to messages.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filter_id: {
          type: "string",
          description: "The filter ID to delete",
        },
      },
      required: ["filter_id"],
    },
    annotations: MUTATE("Delete email filter"),
  },
  {
    name: "gmail_create_label",
    description:
      "Create a Gmail label. Nested labels use '/' in the name (e.g. 'Alerts/Invoices'). Returns the created label including its ID, which can be used with gmail_create_filter or gmail_label_message. Use gmail_list_labels to see existing labels.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "The label name to create",
        },
      },
      required: ["name"],
    },
    annotations: CREATE("Create email label"),
  },
  {
    name: "gmail_list_labels",
    description:
      "List every label in the mailbox, system and user-created, with each label's ID, name and type. Use this to find the label ID that gmail_label_message, gmail_create_filter, gmail_update_label and gmail_delete_label need.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    annotations: READ("List email labels"),
  },
  {
    name: "gmail_update_label",
    description:
      "Rename an existing Gmail label, or change its visibility. Takes the label ID (from gmail_list_labels), not the label name. Renaming a label keeps it on every message already labelled with it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        label_id: {
          type: "string",
          description: "The label ID to update (from gmail_list_labels)",
        },
        name: {
          type: "string",
          description: "New label name. Nested labels use '/' (e.g. 'Alerts/Invoices')",
        },
        label_list_visibility: {
          type: "string",
          description:
            "Whether the label shows in the label list: labelShow, labelShowIfUnread, or labelHide",
        },
        message_list_visibility: {
          type: "string",
          description:
            "Whether the label shows on messages in the message list: show or hide",
        },
      },
      required: ["label_id"],
    },
    // Non-destructive by the same rule as sheets_rename_tab: it changes a
    // label, not data. Messages keep the label; only its name or visibility
    // moves.
    annotations: CREATE("Rename an email label or change its visibility"),
  },
  {
    name: "gmail_delete_label",
    description:
      "Delete a Gmail label. Takes the label ID (from gmail_list_labels), not the label name. This removes the label from every message that carries it; the messages themselves are not deleted. System labels (INBOX, UNREAD, SENT) cannot be deleted.",
    inputSchema: {
      type: "object" as const,
      properties: {
        label_id: {
          type: "string",
          description: "The label ID to delete (from gmail_list_labels)",
        },
      },
      required: ["label_id"],
    },
    annotations: MUTATE("Delete email label and remove it from all mail"),
  },
  {
    name: "gmail_label_message",
    description:
      "Add or remove labels on one or more messages. Removing the INBOX label archives a message; removing UNREAD marks it read. Label IDs come from gmail_list_labels. To only flip read state, gmail_mark_read is the narrower tool.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message_id: {
          type: "string",
          description: "A single message ID to modify",
        },
        message_ids: {
          type: "array",
          items: { type: "string" },
          description: "Several message IDs to modify in one call",
        },
        add_labels: {
          type: "array",
          items: { type: "string" },
          description: "Label IDs to add, e.g. [\"Label_12\"]",
        },
        remove_labels: {
          type: "array",
          items: { type: "string" },
          description:
            "Label IDs to remove, e.g. [\"INBOX\"] to archive or [\"UNREAD\"] to mark read",
        },
      },
      required: [],
    },
    annotations: MUTATE("Add or remove labels on email"),
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
    annotations: CREATE("Save email attachment to Drive"),
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

/** A Gmail label as the API returns it. */
export interface GmailLabel {
  id: string;
  name: string;
  type?: string;
}

/** Find a label by its display name. Used to recover the label a create call
 * made when the API answers with an empty body. */
async function findLabelByName(
  client: GwsClient,
  name: string
): Promise<GmailLabel | undefined> {
  const result = await client.api("gmail", "users.labels", "list", {
    params: { userId: "me" },
  });
  const data = result.data as { labels?: GmailLabel[] } | undefined;
  return (data?.labels ?? []).find((label) => label.name === name);
}

/** Apply a label modification to one message or a batch of them. Shared by
 * gmail_mark_read and gmail_label_message, which build different bodies (see
 * their cases) but issue the same call. */
async function modifyMessageLabels(
  client: GwsClient,
  args: Record<string, unknown>,
  body: Record<string, unknown>
) {
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
  const data = result.data as { id?: string } | undefined;
  // modify can also answer with an empty body; say what was applied rather
  // than returning nothing.
  return jsonResponse(data?.id ? data : { id: args.message_id, ...body });
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
      // The read-state tool's default: with nothing specified, mark read.
      body.removeLabelIds = removeLabels?.length ? removeLabels : ["UNREAD"];
      return modifyMessageLabels(client, args, body);
    }

    case "gmail_label_message": {
      const addLabels = args.add_labels as string[] | undefined;
      const removeLabels = args.remove_labels as string[] | undefined;
      // No default here on purpose: this tool exists to change labels, and
      // silently marking mail read because the caller named no labels would
      // be a side effect nobody asked for.
      if (!addLabels?.length && !removeLabels?.length) {
        throw new Error("Provide add_labels, remove_labels, or both");
      }
      const body: Record<string, unknown> = {};
      if (addLabels?.length) body.addLabelIds = addLabels;
      if (removeLabels?.length) body.removeLabelIds = removeLabels;
      return modifyMessageLabels(client, args, body);
    }

    case "gmail_list_filters": {
      const result = await client.api("gmail", "users.settings.filters", "list", {
        params: { userId: "me" },
      });
      return jsonResponse(result.data);
    }

    case "gmail_create_filter": {
      const criteria: Record<string, unknown> = {};
      if (args.from) criteria.from = args.from;
      if (args.to) criteria.to = args.to;
      if (args.subject) criteria.subject = args.subject;
      if (args.query) criteria.query = args.query;
      if (args.negated_query) criteria.negatedQuery = args.negated_query;

      const action: Record<string, unknown> = {};
      const addLabels = args.add_labels as string[] | undefined;
      const removeLabels = args.remove_labels as string[] | undefined;
      if (addLabels?.length) action.addLabelIds = addLabels;
      if (removeLabels?.length) action.removeLabelIds = removeLabels;
      if (args.forward_to) action.forward = args.forward_to;

      if (Object.keys(criteria).length === 0) {
        throw new Error(
          "Provide at least one criteria field (from, to, subject, query, negated_query)"
        );
      }
      if (Object.keys(action).length === 0) {
        throw new Error(
          "Provide at least one action field (add_labels, remove_labels, forward_to)"
        );
      }

      const result = await client.api("gmail", "users.settings.filters", "create", {
        params: { userId: "me" },
        jsonBody: { criteria, action },
      });
      return jsonResponse(result.data);
    }

    case "gmail_delete_filter": {
      await client.api("gmail", "users.settings.filters", "delete", {
        params: { userId: "me", id: args.filter_id },
      });
      return jsonResponse({ deleted: true, filter_id: args.filter_id });
    }

    case "gmail_create_label": {
      const result = await client.api("gmail", "users.labels", "create", {
        params: { userId: "me" },
        jsonBody: { name: args.name },
      });
      // The label is created, but this call can come back with an empty
      // body, which used to be returned verbatim: the tool promised "the
      // created label including its ID" and handed back nothing, breaking
      // the documented create -> filter chain with no way to recover the id
      // short of listing labels by hand. When the id is missing, look it up.
      const created = result.data as { id?: string } | undefined;
      if (created?.id) return jsonResponse(created);
      const label = await findLabelByName(client, args.name as string);
      if (!label) {
        throw new Error(
          `Label "${args.name}" was created but could not be read back. ` +
            `Use gmail_list_labels to find its ID.`
        );
      }
      return jsonResponse(label);
    }

    case "gmail_list_labels": {
      const result = await client.api("gmail", "users.labels", "list", {
        params: { userId: "me" },
      });
      const data = result.data as { labels?: GmailLabel[] } | undefined;
      const labels = data?.labels ?? [];
      return jsonResponse({ count: labels.length, labels });
    }

    case "gmail_update_label": {
      const body: Record<string, unknown> = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.label_list_visibility !== undefined) {
        body.labelListVisibility = args.label_list_visibility;
      }
      if (args.message_list_visibility !== undefined) {
        body.messageListVisibility = args.message_list_visibility;
      }
      if (Object.keys(body).length === 0) {
        throw new Error(
          "Provide at least one of name, label_list_visibility or message_list_visibility"
        );
      }
      const result = await client.api("gmail", "users.labels", "patch", {
        params: { userId: "me", id: args.label_id },
        jsonBody: body,
      });
      const updated = result.data as { id?: string } | undefined;
      if (updated?.id) return jsonResponse(updated);
      // Same empty-body shape as create: report what was asked for rather
      // than an empty success.
      return jsonResponse({ id: args.label_id, ...body });
    }

    case "gmail_delete_label": {
      await client.api("gmail", "users.labels", "delete", {
        params: { userId: "me", id: args.label_id },
      });
      return deleteResponse(`Label ${args.label_id}`);
    }

    default:
      throw new Error(`Unknown Gmail tool: ${toolName}`);
  }
}
