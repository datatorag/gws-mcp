import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    return path.join(binDir, "gws-aarch64-apple-darwin");
  if (platform === "darwin" && arch === "x64")
    return path.join(binDir, "gws-x86_64-apple-darwin");
  if (platform === "win32" && arch === "x64")
    return path.join(binDir, "gws-x86_64-pc-windows-msvc.exe");

  throw new Error(
    `Unsupported platform: ${platform}/${arch}. Supported: macOS (arm64, x64), Windows (x64).`
  );
}

export class GwsClient {
  private binaryPath: string;

  constructor() {
    this.binaryPath = getGwsBinaryPath();
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

      // Map gws exit codes to actionable messages
      if (error.code === 2 || error.stderr?.includes("auth")) {
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

      // Try to parse error response from stdout
      if (error.stdout) {
        try {
          const parsed = JSON.parse(error.stdout);
          throw new Error(
            `API error: ${JSON.stringify(parsed, null, 2)}`
          );
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
    const args = [service, resource, method];

    if (options?.params) {
      args.push("--params", JSON.stringify(options.params));
    }
    if (options?.jsonBody) {
      args.push("--json-body", JSON.stringify(options.jsonBody));
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

  async authSetup(): Promise<GwsResult> {
    return this.exec(["auth", "setup"], { timeout: 120_000 });
  }

  async authStatus(): Promise<GwsResult> {
    try {
      return await this.exec(["auth", "status"]);
    } catch {
      return { success: false, data: null, stderr: "Not authenticated" };
    }
  }
}
