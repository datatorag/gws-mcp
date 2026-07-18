# CLAUDE.md

## Project

Google Workspace MCP extension for Claude. Wraps the `gws` CLI binary to expose 50 tools (Gmail, Calendar, Drive, Contacts, Sheets, Docs, Slides, Tasks, generic API access) via MCP.

## Commands

- `pnpm run build` — compile TypeScript (src/ → server/)
- `pnpm run dev` — watch mode
- `pnpm run build:extension` — compile + pack into `google-workspace-mcp.mcpb`
- `pnpm run download-binaries` — fetch gws binaries into bin/

## Architecture

Two entry points sharing `createMcpServer()` from `create-server.ts`:

- `extension.ts` — stdio transport for `.mcpb` (Claude Desktop). Auto-triggers browser OAuth login on first run.
- `index.ts` — HTTP transport on port 39147 for Claude Code / standalone use.

`gws-client.ts` wraps the `gws` CLI binary (Rust, in `bin/`). OAuth client ID and secret are read from `GWS_OAUTH_CLIENT_ID` / `GWS_OAUTH_CLIENT_SECRET` env vars and passed to the binary.

## Key conventions

- ESM (`"type": "module"`), all imports use `.js` extensions
- TypeScript strict mode, target ES2024, NodeNext module resolution
- Output dir is `server/` (not `dist/`)
- Use `pnpm`, not `npm`
- No test framework currently

## Extension packaging

- `manifest.json` defines the `.mcpb` extension (entry: `server/extension.js`)
- `.mcpbignore` excludes src/, tsconfig, dev deps, google-cloud-sdk/
- Binaries for macOS (arm64, x64) and Windows (x64) are bundled in `bin/`
- Pack with `mcpb pack . google-workspace-mcp.mcpb`

## Auth flow

The extension uses OAuth Desktop app credentials. On startup, `extension.ts` checks auth status in the background. If unauthenticated, it spawns `gws auth login`, captures the auth URL from stderr, and opens it in the system browser. Users must have a GCP project with APIs enabled and OAuth credentials configured (see README).
