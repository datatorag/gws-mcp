import { spawn } from "node:child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, gwsClient } from "./create-server.js";

// Global error handlers to prevent silent crashes
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

// Start MCP server immediately so Claude Desktop doesn't time out
console.error("Starting Google Workspace MCP server...");
const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP server connected via stdio.");

// Then check auth in background and open browser if needed
gwsClient.authStatus().then((status) => {
  const data = status.data as Record<string, unknown> | null;
  if (!status.success || data?.auth_method === "none" || data?.storage === "none") {
    const child = gwsClient.spawnAuth("drive,gmail,sheets,calendar,docs,slides,people");

    // Watch stderr for the auth URL and open it in the browser
    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(/(https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s]+)/);
      if (match) {
        child.stderr?.removeAllListeners("data");
        stderrBuf = "";
        const openCmd = process.platform === "win32" ? "start" : process.platform === "linux" ? "xdg-open" : "open";
        spawn(openCmd, [match[1]], { stdio: "ignore", shell: process.platform === "win32" });
      }
    });
  }
}).catch((err) => {
  console.error("Auth status check failed:", err);
});
