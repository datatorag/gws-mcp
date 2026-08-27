import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_SERVICES = "drive,gmail,sheets,calendar,docs,slides,people,tasks";

// The gws binary's -s picker maps each service to fixed scopes and has no way
// to add extras (--scopes REPLACES the service-derived list), so we own the map
// and state each service's scopes explicitly. Keep in sync with the binary's
// picker; unknown services fall back to -s.
//
// gmail deliberately does NOT request settings.basic. It was here for the
// filter create/delete tools, which are withheld until that scope is granted —
// asking a self-hosted user to consent to writing their mail settings buys
// nothing while no tool can use it. Restore it when those tools return.
const SERVICE_SCOPES: Record<string, string[]> = {
  drive: ["https://www.googleapis.com/auth/drive"],
  sheets: ["https://www.googleapis.com/auth/spreadsheets"],
  gmail: ["https://www.googleapis.com/auth/gmail.modify"],
  calendar: ["https://www.googleapis.com/auth/calendar"],
  docs: ["https://www.googleapis.com/auth/documents"],
  slides: ["https://www.googleapis.com/auth/presentations"],
  tasks: ["https://www.googleapis.com/auth/tasks"],
  people: [
    "https://www.googleapis.com/auth/contacts",
    "https://www.googleapis.com/auth/contacts.other.readonly",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/directory.readonly",
    "https://www.googleapis.com/auth/user.addresses.read",
    "https://www.googleapis.com/auth/user.birthday.read",
    "https://www.googleapis.com/auth/user.emails.read",
    "https://www.googleapis.com/auth/user.gender.read",
    "https://www.googleapis.com/auth/user.organization.read",
    "https://www.googleapis.com/auth/user.phonenumbers.read",
    "https://www.googleapis.com/auth/userinfo.profile",
  ],
};

// One keyword per DEFAULT_SERVICES entry, matched as a substring of the
// granted scope URLs so short forms match too. Lives here, next to
// SERVICE_SCOPES, because the two lists mirror each other: a service added
// above needs its keyword added here or the re-auth check won't ask for it.
export const REQUIRED_SCOPE_KEYWORDS = [
  "drive",
  "gmail",
  "calendar",
  "documents",
  "spreadsheets",
  "presentations",
  "contacts",
  "tasks",
];

/**
 * Resolve service names to explicit OAuth scopes (the binary appends
 * openid/userinfo.email itself). Returns undefined if any service is unknown,
 * so callers can fall back to the binary's own -s picker.
 */
export function scopesForServices(services: string): string[] | undefined {
  const out: string[] = [];
  for (const name of services.split(",").map((s) => s.trim()).filter(Boolean)) {
    const scopes = SERVICE_SCOPES[name];
    if (!scopes) return undefined;
    out.push(...scopes);
  }
  return [...new Set(out)];
}

/** The message of anything thrown, without every catch site re-deriving it. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let _bundledOAuth: { clientId?: string; clientSecret?: string } | undefined;
function loadBundledOAuth(): { clientId?: string; clientSecret?: string } {
  if (_bundledOAuth) return _bundledOAuth;
  try {
    const raw = readFileSync(path.join(__dirname, "oauth.json"), "utf-8");
    _bundledOAuth = JSON.parse(raw) as { clientId?: string; clientSecret?: string };
  } catch {
    _bundledOAuth = {};
  }
  return _bundledOAuth;
}

export interface GwsResult {
  success: boolean;
  data: unknown;
}

/** An error the caller should retry rather than reason about.
 *
 * These arrive as ordinary API errors and read like permanent ones, so a
 * caller — human or model — treats "Proxy failed to connect to upstream
 * server" as a fact about the request and rewrites a call that was correct.
 * Two different sessions hit that same message on one day and both succeeded
 * on an immediate retry. Naming the class is the whole fix: nothing here
 * retries on the caller's behalf, because a retry that hides a real outage is
 * how a broken integration looks healthy. */
export class TransientGwsError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(`${message}\n\n[transient — this usually succeeds on an immediate retry]`);
    this.name = "TransientGwsError";
  }
}

/** Failures of the path to Google rather than of the request itself.
 * Deliberately narrow: a pattern that also matches a permanent failure would
 * send callers into a retry loop against a wall. */
const TRANSIENT_PATTERNS = [
  /proxy failed to connect to upstream/i,
  /\b(502|503|504)\b/,
  /bad gateway|service unavailable|gateway time-?out/i,
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang ?up/i,
  /backendError|rateLimitExceeded|userRateLimitExceeded/,
];

/** Exported for test: the classification is the whole feature, so pinning the
 * constructor without pinning what reaches it would pin nothing. */
export function isTransient(message: string): boolean {
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}

/** Throw `message` as transient when it looks like one, plain otherwise. */
function throwGwsError(message: string): never {
  throw isTransient(message) ? new TransientGwsError(message) : new Error(message);
}

/**
 * Reject array-valued query parameters, which this transport cannot carry.
 *
 * Params reach the binary as one `--params` JSON blob, and it flattens each
 * value to a single query string: `ranges: ["A!A1", "A!A9"]` goes out as the
 * literal `ranges=["A!A1","A!A9"]`. Google answers `Unable to parse range`
 * with the JSON array printed back — an error about the caller's RANGES,
 * which are fine, rather than about the encoding, which is not. The same
 * flattening silently returned zero headers for `metadataHeaders` until the
 * comment at gmail.ts:525 pinned it down.
 *
 * Nothing here can fix it: URL construction happens inside the binary. So
 * fail before the call with the reason, rather than after it with a message
 * that sends the caller to rewrite correct A1 notation. Repeated-parameter
 * support belongs in the gws binary; until then, callers should issue one
 * request per value.
 */
function assertScalarParams(params: Record<string, unknown>): void {
  const arrays = Object.entries(params)
    .filter(([, value]) => Array.isArray(value))
    .map(([key]) => key);
  if (arrays.length === 0) return;
  throw new Error(
    `Array-valued parameters are not supported by the gws CLI transport: ` +
      `${arrays.map((k) => `"${k}"`).join(", ")}. ` +
      `The binary serialises them into a single query value (ranges=["A1","A2"]), ` +
      `which the API rejects as a malformed range. Issue one call per value instead.`
  );
}

function getGwsBinaryPath(): string {
  const platform = process.platform;
  const arch = process.arch;
  const binDir = path.join(__dirname, "..", "bin");

  if (platform === "darwin" && arch === "arm64")
    return path.join(binDir, "gws-aarch64-apple-darwin", "gws");
  if (platform === "darwin" && arch === "x64")
    return path.join(binDir, "gws-x86_64-apple-darwin", "gws");
  if (platform === "linux" && arch === "x64")
    return path.join(binDir, "gws-x86_64-unknown-linux-gnu", "gws");
  if (platform === "win32" && arch === "x64")
    return path.join(binDir, "gws.exe");

  throw new Error(
    `Unsupported platform: ${platform}/${arch}. Supported: macOS (arm64, x64), Linux (x64), Windows (x64).`
  );
}

const gwsBinaryPath = getGwsBinaryPath();

export interface GwsClientOptions {
  accessToken?: string;
}

/** The most informative thing we can say about a failed gws invocation.
 *
 * Order matters. stderr is the CLI's own diagnostic. stdout is where the API's
 * error body lands when the call reached Google and was rejected there, which
 * is the case a caller most needs to see: it names the field and the reason.
 *
 * The last resort is deliberately NOT `error.message`. Node sets that to
 * "Command failed: <the entire command line>", and for these calls the command
 * line contains the whole serialised batchUpdate request. Echoing it produced
 * pages of JSON that named neither the failing field nor the reason, which is
 * strictly worse than saying nothing: it looks like a diagnostic, so it stops
 * you looking for one. A batchUpdate is atomic, so one bad request fails the
 * whole pass and the caller has no way to tell which. */
function errorDetail(error: {
  code?: number | string;
  stdout?: string;
  stderr?: string;
  message?: string;
}): string {
  const stderr = error.stderr?.trim();
  if (stderr) return stderr;

  const stdout = error.stdout?.trim();
  if (stdout) {
    try {
      const parsed = JSON.parse(stdout) as { error?: { message?: string } };
      const apiMessage = parsed?.error?.message;
      if (apiMessage) return apiMessage;
      return JSON.stringify(parsed);
    } catch {
      return stdout;
    }
  }

  return `gws exited with code ${error.code ?? "unknown"} and produced no diagnostic output`;
}

export class GwsClient {
  private mergedEnv: NodeJS.ProcessEnv;
  private defaultAccessToken?: string;

  constructor(options?: GwsClientOptions) {
    const env: Record<string, string> = {};
    const bundled = loadBundledOAuth();
    const clientId = process.env.GWS_OAUTH_CLIENT_ID || bundled.clientId;
    const clientSecret = process.env.GWS_OAUTH_CLIENT_SECRET || bundled.clientSecret;
    if (clientId) env.GOOGLE_WORKSPACE_CLI_CLIENT_ID = clientId;
    if (clientSecret) env.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET = clientSecret;
    // Ensure gws has a writable config dir (Claude Desktop sandbox is read-only)
    if (!process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR) {
      env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR = path.join(os.homedir(), ".config", "gws");
    }
    this.mergedEnv = { ...process.env, ...env };
    this.defaultAccessToken = options?.accessToken;
  }

  /** Returns a new GwsClient that uses the given access token for all calls.
   * The constructor is deterministic (env + cached bundled OAuth), so a plain
   * re-construction gives the same client without prototype surgery. */
  withToken(accessToken: string): GwsClient {
    return new GwsClient({ accessToken });
  }

  /** Clear stored credentials so the next login gets a fresh token. */
  async logout(): Promise<void> {
    try {
      await execFileAsync(gwsBinaryPath, ["auth", "logout"], {
        timeout: 10_000,
        env: this.mergedEnv,
        cwd: os.tmpdir(),
      });
    } catch {
      // Ignore — may already be logged out
    }
  }

  /** Spawn a background auth login process. Returns the child for stderr monitoring. */
  private spawnAuth(services: string): ChildProcess {
    const scopes = scopesForServices(services);
    const scopeArgs = scopes
      ? ["--scopes", scopes.join(",")]
      : ["-s", services];
    const child = spawn(
      gwsBinaryPath,
      ["auth", "login", ...scopeArgs],
      { env: this.mergedEnv, stdio: ["ignore", "pipe", "pipe"] }
    );
    child.unref();
    return child;
  }

  /**
   * Spawn a background auth login and resolve with the OAuth URL the gws
   * binary prints to stderr — or undefined if the process closes or the
   * timeout elapses without one. The login process keeps running in the
   * background either way so the browser flow can complete.
   */
  spawnAuthForUrl(services: string, timeoutMs = 10_000): Promise<string | undefined> {
    const child = this.spawnAuth(services);
    return new Promise((resolve) => {
      let buf = "";
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      timer.unref?.();
      child.stderr?.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const match = buf.match(
          /(https:\/\/accounts\.google\.com\/o\/oauth2\/auth\S+)/
        );
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }

  async exec(
    args: string[],
    options?: { timeout?: number }
  ): Promise<GwsResult> {
    const timeout = options?.timeout ?? 30_000;
    const token = this.defaultAccessToken;
    const env = token
      ? { ...this.mergedEnv, GOOGLE_WORKSPACE_CLI_TOKEN: token }
      : this.mergedEnv;

    try {
      const { stdout, stderr } = await execFileAsync(gwsBinaryPath, args, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env,
        cwd: os.tmpdir(),
      });

      let data: unknown;
      try {
        data = JSON.parse(stdout);
      } catch {
        data = stdout.trim();
      }

      return { success: true, data };
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
        throw new Error(`Validation error: ${errorDetail(error)}`);
      }
      if (error.code === 4) {
        throw new Error(`API discovery error: ${errorDetail(error)}`);
      }

      if (error.stdout) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(error.stdout);
        } catch {
          // stdout wasn't JSON — fall through to the generic error below
        }
        if (parsed !== undefined) {
          throwGwsError(`API error: ${JSON.stringify(parsed)}`);
        }
      }

      throwGwsError(error.stderr || error.message || "Unknown gws error");
    }
  }

  async helper(
    service: string,
    command: string,
    flags: Record<string, string | boolean>,
    opts?: { positional?: string[]; timeout?: number }
  ): Promise<GwsResult> {
    const args = [service, `+${command}`, ...(opts?.positional ?? [])];
    for (const [key, value] of Object.entries(flags)) {
      if (value === true) args.push(`--${key}`);
      else if (value) args.push(`--${key}`, value);
    }
    return this.exec(args, { timeout: opts?.timeout });
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
      assertScalarParams(options.params);
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

  async authStatus(): Promise<GwsResult> {
    try {
      return await this.exec(["auth", "status"]);
    } catch {
      return { success: false, data: null };
    }
  }
}
