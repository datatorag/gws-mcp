import { describe, expect, it } from "vitest";
import { GwsClient, TransientGwsError, isTransient } from "./gws-client.js";

/** Drives the real `api()` with `exec` swapped out, so the argument assembly
 * under test runs exactly as it does in production. */
function clientWithExec(
  exec: (args: string[]) => Promise<{ success: boolean; data: unknown }>
): { client: GwsClient; argv: string[][] } {
  const argv: string[][] = [];
  const client = Object.create(GwsClient.prototype) as GwsClient;
  (client as unknown as { exec: unknown }).exec = async (args: string[]) => {
    argv.push(args);
    return exec(args);
  };
  return { client, argv };
}

describe("array-valued params (SCRUM-121)", () => {
  it("rejects them before the call, naming the offending keys", async () => {
    const { client, argv } = clientWithExec(async () => ({ success: true, data: {} }));

    await expect(
      client.api("sheets", "spreadsheets.values", "batchGet", {
        params: { spreadsheetId: "s", ranges: ["A!A1:B2", "A!A9:B10"] },
      })
    ).rejects.toThrow(/"ranges"/);

    // Failing BEFORE the request is the point: the old behaviour reached
    // Google and came back blaming the caller's A1 notation, which was fine.
    expect(argv).toHaveLength(0);
  });

  it("explains the encoding rather than the range", async () => {
    const { client } = clientWithExec(async () => ({ success: true, data: {} }));
    const err = await client
      .api("sheets", "spreadsheets.values", "batchGet", {
        params: { ranges: ["A1", "A2"] },
      })
      .catch((e: Error) => e);

    expect((err as Error).message).toMatch(/one call per value/i);
    expect((err as Error).message).not.toMatch(/unable to parse range/i);
  });

  it("names every array param, not only the first", async () => {
    const { client } = clientWithExec(async () => ({ success: true, data: {} }));
    const err = await client
      .api("drive", "files", "list", { params: { ids: ["a"], parents: ["b"] } })
      .catch((e: Error) => e);

    expect((err as Error).message).toContain('"ids"');
    expect((err as Error).message).toContain('"parents"');
  });

  it("leaves scalar params alone", async () => {
    const { client, argv } = clientWithExec(async () => ({ success: true, data: {} }));
    await client.api("sheets", "spreadsheets.values", "get", {
      params: { spreadsheetId: "s", range: "A1", valueRenderOption: "FORMULA" },
    });
    expect(argv[0]).toContain("--params");
    expect(argv[0].join(" ")).toContain("FORMULA");
  });
});

describe("transient upstream failures are marked retryable", () => {
  it.each([
    // The one seen twice in one day by two different sessions.
    "Proxy failed to connect to upstream server",
    "API error: {\"error\":{\"code\":503,\"message\":\"Service Unavailable\"}}",
    "API error: {\"error\":{\"code\":502,\"message\":\"Bad Gateway\"}}",
    "read ECONNRESET",
    "socket hang up",
    "API error: {\"error\":{\"errors\":[{\"reason\":\"backendError\"}]}}",
    "API error: {\"error\":{\"errors\":[{\"reason\":\"rateLimitExceeded\"}]}}",
  ])("classifies %s as transient", (message) => {
    expect(isTransient(message)).toBe(true);
  });

  it("carries the hint in the message text, not just on the object", () => {
    // An MCP client receives a string; a `retryable` property nobody
    // serialises helps nobody.
    const err = new TransientGwsError("Proxy failed to connect to upstream server");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("Proxy failed to connect to upstream server");
    expect(err.message).toMatch(/transient/i);
  });

  it("is an Error, so existing catch sites keep working", () => {
    expect(new TransientGwsError("x")).toBeInstanceOf(Error);
  });

  it.each([
    "API error: {\"error\":{\"code\":404,\"message\":\"Not Found\"}}",
    "API error: {\"error\":{\"code\":403,\"message\":\"insufficient authentication scopes\"}}",
    "Validation error: missing spreadsheetId",
    "No sheet named \"Q3\" in this spreadsheet.",
    "Unable to parse range: Sheet1!A1",
  ])("does NOT mark %s retryable", (message) => {
    // The expensive direction to get wrong: a permanent failure marked
    // retryable sends a caller into a loop against a wall.
    expect(isTransient(message)).toBe(false);
  });
});
