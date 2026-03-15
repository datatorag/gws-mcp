import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GwsClient } from "./gws-client.js";
import { allTools } from "./tools/index.js";
import { handleAuth } from "./tools/auth.js";
import { handleGeneric } from "./tools/generic.js";
import { handleGmail } from "./tools/gmail.js";
import { handleCalendar } from "./tools/calendar.js";
import { handleContacts } from "./tools/contacts.js";
import { handleDrive } from "./tools/drive.js";
import { handleSheets } from "./tools/sheets.js";
import { handleDocs } from "./tools/docs.js";
import { handleSlides } from "./tools/slides.js";

const server = new Server(
  { name: "google-workspace", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const client = new GwsClient();

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      // Auth
      case "gws_auth_setup":
        return await handleAuth(client, args as Record<string, unknown>);

      // Gmail
      case "gmail_send":
      case "gmail_reply":
      case "gmail_forward":
      case "gmail_triage":
      case "gmail_read":
      case "gmail_search":
      case "gmail_list":
        return await handleGmail(
          client,
          name,
          args as Record<string, unknown>
        );

      // Calendar
      case "calendar_list_events":
      case "calendar_get_event":
      case "calendar_create_event":
      case "calendar_update_event":
      case "calendar_delete_event":
      case "calendar_freebusy":
        return await handleCalendar(
          client,
          name,
          args as Record<string, unknown>
        );

      // Contacts
      case "contacts_search":
      case "contacts_get":
      case "contacts_list":
      case "contacts_create":
      case "contacts_update":
      case "contacts_delete":
      case "contacts_directory_search":
        return await handleContacts(
          client,
          name,
          args as Record<string, unknown>
        );

      // Drive
      case "drive_search":
      case "drive_upload":
      case "drive_download":
      case "drive_share":
        return await handleDrive(
          client,
          name,
          args as Record<string, unknown>
        );

      // Sheets
      case "sheets_read":
      case "sheets_update":
      case "sheets_append":
      case "sheets_create":
      case "sheets_delete":
        return await handleSheets(
          client,
          name,
          args as Record<string, unknown>
        );

      // Docs
      case "docs_get":
      case "docs_write":
      case "docs_batch_update":
      case "docs_delete":
        return await handleDocs(
          client,
          name,
          args as Record<string, unknown>
        );

      // Slides
      case "slides_get":
      case "slides_create":
      case "slides_batch_update":
      case "slides_delete":
        return await handleSlides(
          client,
          name,
          args as Record<string, unknown>
        );

      // Generic fallback
      case "gws_run":
        return await handleGeneric(
          client,
          args as Record<string, unknown>
        );

      default:
        return {
          content: [
            { type: "text" as const, text: `Unknown tool: ${name}` },
          ],
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

const PORT = parseInt(process.env.PORT || "37778", 10);

const transports = new Map<string, StreamableHTTPServerTransport>();

const httpServer = createServer(async (req, res) => {
  if (req.url !== "/mcp") {
    res.writeHead(404).end("Not found");
    return;
  }

  // Route to existing session
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId) {
    const existing = transports.get(sessionId);
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }
    res.writeHead(404).end("Session not found");
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId);
    }
  };

  await server.connect(transport);

  if (transport.sessionId) {
    transports.set(transport.sessionId, transport);
  }

  await transport.handleRequest(req, res);
});

httpServer.listen(PORT, () => {
  console.error(`Google Workspace MCP server running on http://localhost:${PORT}/mcp`);
});
