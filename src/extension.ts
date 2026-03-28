import { spawn } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, gwsClient } from "./create-server.js";

const EXPECTED_SERVICES = "drive,gmail,sheets,calendar,docs,slides,people,tasks";

// Scopes that must be present — if any are missing, re-auth is triggered.
// Uses substrings to match regardless of full URL vs short form.
const REQUIRED_SCOPE_KEYWORDS = [
  "drive",
  "gmail",
  "calendar",
  "documents",
  "spreadsheets",
  "presentations",
  "contacts",
  "tasks",
];

// Catch any uncaught errors so they appear in Claude Desktop logs
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

function openAuthUrl(url: string) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "linux") {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

async function triggerReAuth(reason: string) {
  console.error(`Re-authenticating: ${reason}`);
  // Clear old credentials first to guarantee a fresh token with all scopes
  await gwsClient.logout();

  const child = gwsClient.spawnAuth(EXPECTED_SERVICES);

  let stderrBuf = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    const match = stderrBuf.match(/(https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s]+)/);
    if (match) {
      stderrBuf = "";
      openAuthUrl(match[1]);
    }
  });
}

// Start MCP server immediately so Claude Desktop doesn't time out
console.error("Extension starting...");
const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Extension connected.");

// Then check auth in background and open browser if needed
gwsClient.authStatus().then((status) => {
  const data = status.data as Record<string, unknown> | null;

  // Case 1: No credentials at all
  if (!status.success || data?.auth_method === "none" || data?.storage === "none") {
    triggerReAuth("no credentials found");
    return;
  }

  // Case 2: Credentials exist but scopes are missing
  const scopes = data?.scopes as string[] | undefined;
  if (scopes) {
    const missing = REQUIRED_SCOPE_KEYWORDS.filter(
      (keyword) => !scopes.some((s) => s.includes(keyword))
    );
    if (missing.length > 0) {
      triggerReAuth(`missing scopes: ${missing.join(", ")}`);
    }
  }
}).catch((err) => {
  console.error("Auth status check failed:", err instanceof Error ? err.message : err);
});
