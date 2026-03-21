import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadBundledOAuth(): { clientId?: string; clientSecret?: string } {
  try {
    const raw = readFileSync(path.join(__dirname, "oauth.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export interface GwsResult {
  success: boolean;
  data: unknown;
  stderr: string;
}

function getGwsBinaryPath(): string {
  const platform = process.platform;
  const arch = process.arch;
  const binDir = path.join(__dirname, "..", "bin");

  if (platform === "darwin" && arch === "arm64")
    return path.join(binDir, "gws-aarch64-apple-darwin", "gws");
  if (platform === "darwin" && arch === "x64")
    return path.join(binDir, "gws-x86_64-apple-darwin", "gws");
  if (platform === "win32" && arch === "x64")
    return path.join(binDir, "gws.exe");

  throw new Error(
    `Unsupported platform: ${platform}/${arch}. Supported: macOS (arm64, x64), Windows (x64).`
  );
}

export interface GwsClientOptions {
  clientId?: string;
  clientSecret?: string;
}

export class GwsClient {
  private binaryPath: string;
  private mergedEnv: NodeJS.ProcessEnv;

  constructor(options?: GwsClientOptions) {
    this.binaryPath = getGwsBinaryPath();
    const env: Record<string, string> = {};
    const bundled = loadBundledOAuth();
    const clientId = options?.clientId || process.env.GWS_OAUTH_CLIENT_ID || bundled.clientId;
    const clientSecret = options?.clientSecret || process.env.GWS_OAUTH_CLIENT_SECRET || bundled.clientSecret;
    if (clientId) env.GOOGLE_WORKSPACE_CLI_CLIENT_ID = clientId;
    if (clientSecret) env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET = clientSecret;
    // Ensure gws has a writable config dir (Claude Desktop sandbox is read-only)
    if (!process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR) {
      env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = path.join(os.homedir(), ".config", "gws");
    }
    this.mergedEnv = { ...process.env, ...env };
  }

  /** Spawn a background auth login process. Returns the child for stderr monitoring. */
  spawnAuth(services: string): ChildProcess {
    const child = spawn(
      this.binaryPath,
      ["auth", "login", "-s", services],
      { env: this.mergedEnv, stdio: ["ignore", "pipe", "pipe"] }
    );
    child.unref();
    return child;
  }

  async exec(
    args: string[],
    options?: { timeout?: number }
  ): Promise<GwsResult> {
    const timeout = options?.timeout ?? 30_000;

    try {
      const { stdout, stderr } = await execFileAsync(this.binaryPath, args, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env: this.mergedEnv,
        cwd: os.tmpdir(),
      });

      let data: unknown;
      try {
        data = JSON.parse(stdout);
      } catch {
        data = stdout.trim();
      }

      return { success: true, data, stderr };
    } catch (err: unknown) {
      const error = err as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      if (error.code === 2) {
        throw new Error(
          "Google Workspace authentication required. Use the gws_auth_setup tool to authenticate."
        );
      }
      if (error.code === 3) {
        throw new Error(`Validation error: ${error.stderr || error.message}`);
      }
      if (error.code === 4) {
        throw new Error(
          `API discovery error: ${error.stderr || error.message}`
        );
      }

      if (error.stdout) {
        try {
          const parsed = JSON.parse(error.stdout);
          throw new Error(`API error: ${JSON.stringify(parsed)}`);
        } catch (parseErr) {
          if (parseErr instanceof Error && parseErr.message.startsWith("API error:")) {
            throw parseErr;
          }
        }
      }

      throw new Error(
        error.stderr || error.message || "Unknown gws error"
      );
    }
  }

  async helper(
    service: string,
    command: string,
    flags: Record<string, string>
  ): Promise<GwsResult> {
    const args = [service, `+${command}`];
    for (const [key, value] of Object.entries(flags)) {
      if (value !== undefined && value !== "") {
        args.push(`--${key}`, value);
      }
    }
    return this.exec(args);
  }

  async api(
    service: string,
    resource: string,
    method: string,
    options?: {
      params?: Record<string, unknown>;
      jsonBody?: unknown;
      pageAll?: boolean;
      dryRun?: boolean;
    }
  ): Promise<GwsResult> {
    const args = [service, ...resource.split("."), method];

    if (options?.params) {
      args.push("--params", JSON.stringify(options.params));
    }
    if (options?.jsonBody) {
      args.push("--json", JSON.stringify(options.jsonBody));
    }
    if (options?.pageAll) {
      args.push("--page-all", "--page-limit", "10");
    }
    if (options?.dryRun) {
      args.push("--dry-run");
    }

    const timeout = options?.pageAll ? 120_000 : 30_000;
    return this.exec(args, { timeout });
  }

  async authLogin(services?: string): Promise<GwsResult> {
    const args = ["auth", "login"];
    if (services) args.push("-s", services);
    return this.exec(args, { timeout: 120_000 });
  }

  async authStatus(): Promise<GwsResult> {
    try {
      return await this.exec(["auth", "status"]);
    } catch {
      return { success: false, data: null, stderr: "Not authenticated" };
    }
  }
}
