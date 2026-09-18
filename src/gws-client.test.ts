import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GwsClient, TransientGwsError, isTransient } from "./gws-client.js";

/** A token-bearing client with `fetch` swapped out, so the request assembly
 * under test runs exactly as it does in production. */
function clientWithFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return respond(String(input), init ?? {});
  });
  return { client: new GwsClient({ accessToken: "test-token" }), requests, spy };
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.restoreAllMocks());

/* SCRUM-178, carried across SCRUM-289. The old transport once refused every
 * array on a wrong belief about the binary; the pinned binary sends a
 * repeated key, and so must this client. The oracle test holds the two equal
 * for every method; these pin the wire form a reader can see. */
describe("repeated query parameters go out as repeated keys (SCRUM-178)", () => {
  it.each([
    ["sheets", "spreadsheets", "get", { spreadsheetId: "s", ranges: ["A!A1:B2", "A!A9:B10"] }, "ranges"],
    ["gmail", "users.messages", "get", { userId: "me", id: "m", format: "metadata", metadataHeaders: ["From", "Subject"] }, "metadataHeaders"],
    ["gmail", "users.messages", "list", { userId: "me", labelIds: ["INBOX", "UNREAD"] }, "labelIds"],
  ])("%s %s %s: one pair per element", async (service, resource, method, params, key) => {
    const { client, requests } = clientWithFetch(() => ok({}));
    await client.api(service, resource, method, { params });

    expect(requests).toHaveLength(1);
    const sent = new URL(requests[0].url).searchParams.getAll(key);
    expect(sent).toEqual(params[key as keyof typeof params]);
  });

  it("refuses an array of non-scalars before the call, naming the key and the shape", async () => {
    const { client, requests } = clientWithFetch(() => ok({}));
    const err = await client
      .api("sheets", "spreadsheets", "get", {
        params: { spreadsheetId: "s", ranges: [{ sheet: "A", range: "A1" }] },
      })
      .catch((e: Error) => e);

    // Failing BEFORE the request is still the point for this shape: it would
    // go out as one stringified value and Google would blame the range.
    expect(requests).toHaveLength(0);
    expect((err as Error).message).toContain('"ranges"');
    expect((err as Error).message).toMatch(/nested arrays or objects/);
    expect((err as Error).message).not.toMatch(/unable to parse range/i);
  });

  it("names every offending key, and only the offending ones", async () => {
    const { client } = clientWithFetch(() => ok({}));
    const err = await client
      .api("drive", "files", "list", {
        params: { ids: [["a"]], parents: [null], fields: ["id", "name"] },
      })
      .catch((e: Error) => e);

    expect((err as Error).message).toContain('"ids"');
    expect((err as Error).message).toContain('"parents"');
    expect((err as Error).message).not.toContain('"fields"');
  });

  it("leaves scalar params alone, and puts path parameters in the path", async () => {
    const { client, requests } = clientWithFetch(() => ok({}));
    await client.api("sheets", "spreadsheets.values", "get", {
      params: { spreadsheetId: "s", range: "A1", valueRenderOption: "FORMULA" },
    });
    const url = new URL(requests[0].url);
    expect(url.pathname).toBe("/v4/spreadsheets/s/values/A1");
    expect([...url.searchParams]).toEqual([["valueRenderOption", "FORMULA"]]);
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

/* SCRUM-261: the one plain authenticated GET, pinned to Google. The token
 * goes only where the CLI would have taken it; a caller cannot point it
 * elsewhere, and there is no anonymous fallback. */
describe("fetchText carries the token only to Google (SCRUM-261)", () => {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    seen.length = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      seen.push({ url: String(url), auth: headers?.Authorization });
      return new Response("/*O_o*/\ngoogle.visualization.Query.setResponse({});", { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("refuses without a token, before any request", async () => {
    const anonymous = new GwsClient();
    await expect(anonymous.fetchText("https://docs.google.com/spreadsheets/d/s/gviz/tq")).rejects.toThrow(/needs an access token/);
    expect(seen).toHaveLength(0);
  });

  it("refuses a non-Google origin, before any request", async () => {
    const client = new GwsClient({ accessToken: "tok" });
    await expect(client.fetchText("https://example.com/collect?x=1")).rejects.toThrow(/only reaches Google origins/);
    await expect(client.fetchText("http://docs.google.com/spreadsheets/d/s/gviz/tq")).rejects.toThrow(/only reaches Google origins/);
    expect(seen).toHaveLength(0);
  });

  it("sends the bearer to a Google origin and hands back status and text", async () => {
    const client = new GwsClient({ accessToken: "tok" });
    const out = await client.fetchText("https://docs.google.com/spreadsheets/d/s/gviz/tq?tq=select%20A");
    expect(seen).toEqual([{ url: "https://docs.google.com/spreadsheets/d/s/gviz/tq?tq=select%20A", auth: "Bearer tok" }]);
    expect(out.status).toBe(200);
    expect(out.text).toContain("setResponse");
  });
});
