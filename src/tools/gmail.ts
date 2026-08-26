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
  body: {
    type: "string",
    description:
      "Plain-text email body. When html_body is also given, this becomes the text/plain alternative part shown by plain-text clients.",
  },
  html_body: {
    type: "string",
    description:
      "HTML email body. The message is sent as multipart/alternative with a text/plain fallback part (body if provided, otherwise text derived from the HTML), so plain-text clients still render something readable.",
  },
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
      "Send a new email via Gmail. Composes and sends an email message to the specified recipients. Accepts a plain-text body, an HTML html_body, or both — HTML is sent as multipart/alternative with a plain-text fallback.",
    inputSchema: {
      type: "object",
      properties: emailFields,
      required: ["to", "subject"],
    },
    annotations: MUTATE("Send email"),
  },
  {
    name: "gmail_reply",
    description: "Reply to an existing email thread in Gmail.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID to reply to",
        },
        body: { type: "string", description: "Reply body text (plain)" },
        html_body: {
          type: "string",
          description:
            "HTML reply body. Sent as text/html with no plain-text alternative part (this path hands quoting and threading to a single-part composer); the original message is quoted with Gmail styling. Provide body or html_body, not both.",
        },
      },
      required: ["message_id"],
    },
    annotations: MUTATE("Reply to email"),
  },
  {
    name: "gmail_forward",
    description: "Forward an existing email to another recipient.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID to forward",
        },
        to: {
          type: "string",
          description: "Recipient email address to forward to",
        },
        body: {
          type: "string",
          description:
            "Optional plain-text note included above the forwarded message",
        },
        html_body: {
          type: "string",
          description:
            "Optional HTML note included above the forwarded message. Sent as text/html with no plain-text alternative part; the forwarded block is formatted with Gmail styling. Provide body or html_body, not both.",
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
      type: "object",
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
      type: "object",
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
      type: "object",
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
      required: [],
    },
    annotations: READ("List emails"),
  },
  {
    name: "gmail_create_draft",
    description:
      "Create a draft email in Gmail without sending it. The draft can be reviewed and sent later from Gmail. Returns the draft ID and a link to open it in Gmail. Accepts a plain-text body, an HTML html_body, or both — HTML is stored as multipart/alternative with a plain-text fallback.",
    inputSchema: {
      type: "object",
      properties: emailFields,
      required: ["to", "subject"],
    },
    annotations: CREATE("Create email draft"),
  },
  {
    name: "gmail_update_draft",
    description:
      "Update an existing draft email in Gmail. This fully replaces the draft's message content (Gmail API does not support partial edits). If thread_id is omitted, the tool preserves the existing thread automatically.",
    inputSchema: {
      type: "object",
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
      required: ["draft_id", "to", "subject"],
    },
    annotations: MUTATE("Update email draft"),
  },
  {
    name: "gmail_send_draft",
    description:
      "Send an existing Gmail draft by its draft ID. Use this to send a draft that was previously created with gmail_create_draft and reviewed — it sends the draft as-is and removes it from the Drafts folder (no orphaned draft). Returns the sent message metadata.",
    inputSchema: {
      type: "object",
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
      type: "object",
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
      type: "object",
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
      required: [],
    },
    annotations: MUTATE("Change email read state and labels"),
  },
  {
    name: "gmail_list_filters",
    description:
      "List all Gmail filters (settings > filters) with their criteria and actions. Read-only: use it to see what automation a mailbox already applies to incoming mail, for example when triaging why a message was archived or labelled before it was seen. This connector cannot create or delete filters, and neither can a raw API call through gws_run — Google accepts only the gmail.settings.basic scope on those, which is not granted. Filters must be changed in Gmail's own settings.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    annotations: READ("List email filters"),
  },
  /* gmail_create_filter and gmail_delete_filter are withheld on purpose.
   *
   * Writing a filter goes through users.settings.filters.create/delete, and
   * Google accepts ONLY gmail.settings.basic there — gmail.modify does not
   * carry it, so both calls fail with insufficient scopes no matter what the
   * caller does. A tool that can only fail is worse than a missing one: it
   * advertises a capability, and the error arrives after someone has already
   * decided to rely on it.
   *
   * Reading filters is unaffected and stays: users.settings.filters.list
   * accepts gmail.modify, which is why gmail_list_filters works today.
   *
   * Restore both when gmail.settings.basic is granted. The implementations
   * are in this file's history; nothing else needs to change.
   */
  {
    name: "gmail_create_label",
    description:
      "Create a Gmail label. Nested labels use '/' in the name (e.g. 'Alerts/Invoices'). Returns the created label including its ID, which can be used with gmail_label_message. Use gmail_list_labels to see existing labels.",
    inputSchema: {
      type: "object",
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
      "List every label in the mailbox, system and user-created, with each label's ID, name and type. Use this to find the label ID that gmail_label_message, gmail_update_label and gmail_delete_label need.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: READ("List email labels"),
  },
  {
    name: "gmail_update_label",
    description:
      "Rename an existing Gmail label, or change its visibility. Takes the label ID (from gmail_list_labels), not the label name. Renaming a label keeps it on every message already labelled with it.",
    inputSchema: {
      type: "object",
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
      type: "object",
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
      type: "object",
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
      type: "object",
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

/** The body pair a compose tool was given, checked once so gmail_send and the
 * raw-MIME builder state the same contract. */
function resolveBody(
  toolName: string,
  args: Record<string, unknown>
): { body?: string; html?: string } {
  const body = args.body as string | undefined;
  const html = args.html_body as string | undefined;
  if (body === undefined && html === undefined) {
    throw new Error(
      `${toolName}: provide body (plain text), html_body (HTML), or both.`
    );
  }
  return { body, html };
}

/** Flags for the CLI helpers with one body slot (+reply, +forward): either
 * --body <plain>, or --body <html> --html. Both at once is refused rather
 * than one silently dropped — a message sent with half its content missing
 * would be this ticket's silent failure wearing a new hat. */
function htmlOrPlainBody(
  toolName: string,
  args: Record<string, unknown>
): Record<string, string | boolean> {
  const body = args.body as string | undefined;
  const html = args.html_body as string | undefined;
  if (body !== undefined && html !== undefined) {
    throw new Error(
      `${toolName}: provide body or html_body, not both. This path has a ` +
        "single body slot; a separate plain-text fallback is only supported " +
        "on gmail_send and the draft tools."
    );
  }
  if (html !== undefined) return { body: html, html: true };
  return body !== undefined ? { body } : {};
}

function buildRawMessage(
  toolName: string,
  args: Record<string, unknown>
): string {
  const { body, html } = resolveBody(toolName, args);
  const headers = [
    `To: ${args.to as string}`,
    `Subject: ${args.subject as string}`,
  ];
  if (args.cc) headers.push(`Cc: ${args.cc as string}`);
  if (args.bcc) headers.push(`Bcc: ${args.bcc as string}`);
  headers.push("MIME-Version: 1.0");

  let content: string;
  if (html === undefined) {
    headers.push("Content-Type: text/plain; charset=utf-8");
    content = body as string;
  } else {
    // multipart/alternative with the plain part FIRST: clients prefer the
    // last part they can render, so text/html must come after the fallback.
    // The fallback is the caller's plain text when given, otherwise text
    // derived from the HTML — never the raw markup, which is the exact
    // failure this parameter exists to end.
    const boundary = `=_gws_${randomUUID()}`;
    headers.push(
      `Content-Type: multipart/alternative; boundary="${boundary}"`
    );
    content = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body ?? stripHtml(html),
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
      `--${boundary}--`,
      "",
    ].join("\r\n");
  }
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${content}`).toString(
    "base64url"
  );
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
      const { html } = resolveBody(toolName, args);
      if (html !== undefined) {
        // The CLI's +send --html emits a single text/html part with no
        // fallback; the raw API path sends multipart/alternative instead,
        // the same shape as the draft tools.
        const result = await client.api("gmail", "users.messages", "send", {
          params: { userId: "me" },
          jsonBody: { raw: buildRawMessage(toolName, args) },
        });
        return jsonResponse(result.data);
      }
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
      const bodyFlags = htmlOrPlainBody(toolName, args);
      if (!("body" in bodyFlags)) {
        throw new Error(
          `${toolName}: provide body (plain text) or html_body (HTML).`
        );
      }
      const result = await client.helper("gmail", "reply", {
        "message-id": args.message_id as string,
        ...bodyFlags,
      });
      return jsonResponse(result.data);
    }

    case "gmail_forward": {
      const result = await client.helper("gmail", "forward", {
        "message-id": args.message_id as string,
        to: args.to as string,
        ...htmlOrPlainBody(toolName, args),
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
        const flags: Record<string, string> = { name: args.filename as string };
        if (args.parent_folder_id) {
          flags.parent = args.parent_folder_id as string;
        }
        const uploadResult = await client.helper("drive", "upload", flags, {
          positional: [tmpFile],
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
      const raw = buildRawMessage(toolName, args);
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

      const raw = buildRawMessage(toolName, args);
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
      // A mailbox with no filters answers with an empty body, which returned
      // as a bare "" — indistinguishable from a failure to the caller. Say
      // "none" in the same shape as "some".
      const data = result.data as { filter?: unknown[] } | string | undefined;
      const filters =
        typeof data === "object" && Array.isArray(data?.filter) ? data.filter : [];
      return jsonResponse({ count: filters.length, filters });
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
