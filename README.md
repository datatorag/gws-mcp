# Google Workspace MCP Extension for Claude

A [Model Context Protocol](https://modelcontextprotocol.io/) server that gives Claude access to Google Workspace — Gmail, Calendar, Drive, Contacts, Sheets, Docs, Slides, and 100+ APIs via the [gws CLI](https://github.com/googleworkspace/cli).

## Tools

| Service | Tools | Operations |
|---------|-------|------------|
| **Gmail** | 7 | send, reply, forward, triage, read, search, list |
| **Calendar** | 6 | list events, get event, create, update, delete, freebusy |
| **Contacts** | 7 | search, get, list, create, update, delete, directory search |
| **Drive** | 2 | search, read file |
| **Sheets** | 5 | read, update, append, create, delete |
| **Docs** | 5 | get, write, batch update, create, delete |
| **Slides** | 4 | get, create, batch update, delete |
| **Generic** | 1 | `gws_run` — fallback for any GWS API not covered above |
| **Auth** | 1 | OAuth login and status |

**38 tools total.** All tools support shared (team) Drives.

### Key tool details

**drive_search** — Searches across both personal and shared Drives. Supports full [Drive query syntax](https://developers.google.com/drive/api/guides/search-files) including folder parents, mimeType filters, and name matching.

**drive_read_file** — Reads the text content of any file in Drive by file ID. Routes by mimeType:
- Google Docs → plain text extraction
- Google Sheets → row/column data (A1:Z1000)
- Google Slides → slide structure with placeholder maps and text
- Office formats (.docx, .xlsx, .pptx) → server-side conversion to native Google format via `files.copy` with explicit target mimeType, read converted copy, then delete temp copy (guaranteed cleanup via try/finally)
- Plain text / CSV (`text/plain`, `text/csv`) → raw content fetch
- Unsupported types (PDF, images, `text/calendar`, `text/html`, etc.) → returns `{ error: "Unsupported file type: <mimeType>" }`

**docs_get** — Three modes:
- `text` (default): plain text, best for reading/summarizing
- `index`: text with startIndex/endIndex character positions, use before positional edits
- `full`: raw API response, for debugging or style operations

**docs_create / sheets_create** — Return stripped responses with only essential fields:
- docs_create → `{ documentId, title }`
- sheets_create → `{ spreadsheetId, title, spreadsheetUrl }`

**slides_get / slides_create** — Return trimmed responses (no masters, layouts, geometry, styling). Each slide includes:
- `placeholder_map`: maps standard types (TITLE, BODY, SUBTITLE) to objectIds
- `elements`: all shapes — both standard placeholders and custom text boxes
- Empty placeholders are included (with objectId and placeholderType, no text field) so callers can insert text immediately after create without a redundant get call

**sheets_read** — Returns normalized data:
- `columnCount` derived from the widest row (handles empty leading rows correctly)
- All rows padded to uniform column count with empty strings

**sheets_append** — Uses direct Sheets API (`spreadsheets.values.append`) to preserve 2D array structure. Each inner array becomes a separate row.

**docs_write** — Uses batchUpdate API with insertText (not CLI helper), correctly handles newlines, em dashes, and unicode characters.

**gws_run** — Fallback tool for any Google Workspace API not covered by the dedicated tools. Accepts service, resource, method, params, and JSON body. Use only when no dedicated tool exists.

## Setup (Extension — Claude Desktop)

### 1. Create a Google Cloud project

Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project (or use an existing one).

### 2. Enable Google Workspace APIs

Enable each API you plan to use in your project. Click the links below and hit **Enable** on each page:

- [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
- [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
- [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
- [Google Docs API](https://console.cloud.google.com/apis/library/docs.googleapis.com)
- [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)
- [Google Slides API](https://console.cloud.google.com/apis/library/slides.googleapis.com)
- [People API](https://console.cloud.google.com/apis/library/people.googleapis.com) (for contacts)

### 3. Configure OAuth consent screen

Go to [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent):

1. Select **External** user type
2. Fill in the app name (e.g. "Google Workspace CLI") and your email
3. Save and continue through all screens
4. Under **Test users**, click **Add users** and add your Google account email

### 4. Create OAuth credentials

Go to [Credentials](https://console.cloud.google.com/apis/credentials):

1. Click **Create Credentials** → **OAuth client ID**
2. Application type: **Desktop app**
3. Click **Create**
4. Copy the **Client ID** and **Client Secret**

### 5. Configure OAuth credentials

```bash
cp .env.example .env
```

Open `.env` and fill in your Client ID and Client Secret from the previous step.

### 6. Build the extension

```bash
pnpm install
pnpm run build
pnpm run build:extension
```

This produces `google-workspace-mcp.mcpb`.

### 7. Install in Claude Desktop

Open Claude Desktop → Settings → Extensions → Install from file → select `google-workspace-mcp.mcpb`.

When the extension loads for the first time, a browser window opens automatically for Google OAuth login. Sign in and authorize the app. After that, all tools are ready to use.

> **Note:** If your app is in testing mode (unverified), you'll see a "Google hasn't verified this app" warning. Click **Advanced** → **Go to \<app name\> (unsafe)** to proceed. This is safe for personal use.

## Setup (HTTP Server — Claude Code / standalone)

### 1. Complete steps 1–5 above

### 2. Install and build

```bash
pnpm install
pnpm run build
```

### 3. Authenticate

With the env vars from step 5 set, run:

```bash
./bin/gws-aarch64-apple-darwin/gws auth login -s drive,gmail,sheets,calendar,docs,slides,people
```

### 4. Start the server

```bash
node server/index.js
```

The MCP server starts on `http://localhost:39147/mcp` (override with `PORT` env var).

### 5. Connect Claude Code

```bash
claude mcp add google-workspace --transport http http://localhost:39147/mcp
```

Or add to Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "google-workspace": {
      "type": "streamable-http",
      "url": "http://localhost:39147/mcp"
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `39147` | HTTP server port |
| `GWS_OAUTH_CLIENT_ID` | — | OAuth client ID |
| `GWS_OAUTH_CLIENT_SECRET` | — | OAuth client secret |

## Architecture

```
src/
├── create-server.ts      # Shared MCP server factory
├── extension.ts          # Stdio entry point (.mcpb extension)
├── index.ts              # HTTP entry point (standalone server)
├── gws-client.ts         # Wrapper around the gws CLI binary
└── tools/
    ├── response.ts       # Response helpers (JSON formatting, 900KB truncation)
    ├── auth.ts           # OAuth login (browser-based, no gcloud needed)
    ├── gmail.ts          # Gmail tools
    ├── calendar.ts       # Calendar tools
    ├── contacts.ts       # Contacts / People API tools
    ├── drive.ts          # Drive tools (search, read file with auto-conversion)
    ├── sheets.ts         # Sheets tools (normalized reads, direct API append)
    ├── docs.ts           # Docs tools (text/index/full modes, batchUpdate writes)
    ├── slides.ts         # Slides tools (trimmed responses, placeholder maps)
    ├── generic.ts        # Generic gws_run fallback
    └── index.ts          # Tool registry (flat Map<name, handler>)
```

The server wraps the [`gws` CLI](https://github.com/googleworkspace/cli) binary, which handles OAuth token management and API discovery. Each tool either uses `client.helper()` for high-level CLI commands or `client.api()` for direct Google API calls.

The extension (`extension.ts`) runs via stdio for Claude Desktop `.mcpb` bundles. The HTTP server (`index.ts`) runs as a standalone process for Claude Code or other MCP clients. Both share the same `createMcpServer()` factory.

### Key implementation details

- **Shared Drive support**: All Drive API calls include `supportsAllDrives: true` (and `includeItemsFromAllDrives: true` for list operations) so files on team Drives are accessible
- **Sandbox compatibility**: Sets `cwd: os.tmpdir()` and `GOOGLE_WORKSPACE_CLI_CONFIG_DIR` for Claude Desktop's read-only filesystem
- **OAuth credentials**: Reads from env vars, falls back to bundled `oauth.json` (injected at build time by `scripts/build-extension.sh`)
- **Auto-auth**: Extension checks auth status on startup and opens browser for OAuth login if needed (non-blocking — MCP server starts immediately)
- **Response truncation**: All responses capped at 900KB to stay within context limits
- **Slides trimming**: Strips masters, layouts, geometry, and styling from API responses — returns only objectIds, placeholder types, and text content
- **Office file reading**: `drive_read_file` copies Office files with explicit target mimeType to trigger server-side conversion, reads the native copy, then deletes it (guaranteed cleanup via try/finally)
- **Unsupported type guard**: `drive_read_file` only fetches raw content for `text/plain` and `text/csv` — all other non-native types return a clean error instead of binary data

## Development

```bash
pnpm run dev    # Watch mode — recompiles on change
```

## License

MIT
