import { describe, expect, it } from "vitest";
import { handleGmail } from "./gmail.js";
import { fakeClient } from "./fake-client.test-helper.js";

/** Decode the base64url raw MIME a compose call emitted. These tests assert
 * the EMITTED REQUEST, not the response: the bug they pin was a success
 * response wrapping a message whose Content-Type contradicted its body. */
function rawMime(call: Record<string, unknown>): string {
  const jsonBody = call.jsonBody as {
    raw?: string;
    message?: { raw?: string };
  };
  const raw = jsonBody.raw ?? jsonBody.message?.raw;
  if (!raw) throw new Error("call carried no raw MIME");
  return Buffer.from(raw, "base64url").toString("utf-8");
}

/** Split a multipart/alternative MIME string into its boundary and parts. */
function parseMultipart(mime: string) {
  const boundary = /boundary="([^"]+)"/.exec(mime)?.[1];
  if (!boundary) throw new Error("no multipart boundary in message");
  expect(mime).toContain(`--${boundary}--`); // closing delimiter
  const parts = mime
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((p) => p.replace(/^\r\n/, ""));
  return { boundary, parts };
}

describe("plain-text compose (unchanged shape)", () => {
  it("gmail_create_draft with body only emits single-part text/plain", async () => {
    const { client, calls } = fakeClient([
      { data: { id: "d1", message: { id: "m1" } } },
    ]);
    await handleGmail(client, "gmail_create_draft", {
      to: "a@example.com",
      subject: "Hi",
      body: "plain words",
    });

    const mime = rawMime(calls[0]);
    expect(mime).toContain("Content-Type: text/plain; charset=utf-8");
    expect(mime).not.toContain("multipart/alternative");
    expect(mime).toContain("plain words");
  });

  it("gmail_send with body only still goes through the CLI helper", async () => {
    const { client, calls } = fakeClient([{ data: { id: "m1" } }]);
    await handleGmail(client, "gmail_send", {
      to: "a@example.com",
      subject: "Hi",
      body: "plain words",
    });

    expect(calls[0]).toMatchObject({
      service: "gmail",
      command: "send",
      flags: { to: "a@example.com", subject: "Hi", body: "plain words" },
    });
  });
});

describe("html_body composes multipart/alternative", () => {
  it("gmail_send with html_body sends raw MIME via the API, not the helper", async () => {
    const { client, calls } = fakeClient([{ data: { id: "m1" } }]);
    await handleGmail(client, "gmail_send", {
      to: "a@example.com",
      subject: "Hi",
      body: "fallback text",
      html_body: "<p>Hello <b>world</b></p>",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      service: "gmail",
      resource: "users.messages",
      method: "send",
      params: { userId: "me" },
    });

    const mime = rawMime(calls[0]);
    expect(mime).toContain("MIME-Version: 1.0");
    expect(mime).toContain("To: a@example.com");

    const { parts } = parseMultipart(mime);
    expect(parts).toHaveLength(2);
    // Plain part FIRST, html LAST: clients prefer the last renderable part.
    expect(parts[0]).toContain("Content-Type: text/plain; charset=utf-8");
    expect(parts[0]).toContain("fallback text");
    expect(parts[1]).toContain("Content-Type: text/html; charset=utf-8");
    expect(parts[1]).toContain("<p>Hello <b>world</b></p>");
  });

  it("derives the plain fallback from the HTML when body is absent", async () => {
    const { client, calls } = fakeClient([
      { data: { id: "d1", message: { id: "m1" } } },
    ]);
    await handleGmail(client, "gmail_create_draft", {
      to: "a@example.com",
      subject: "Hi",
      html_body: "<p>Hello <b>world</b></p>",
    });

    const { parts } = parseMultipart(rawMime(calls[0]));
    const plainBody = parts[0].split("\r\n\r\n")[1];
    expect(plainBody).toContain("Hello world");
    expect(plainBody).not.toContain("<b>"); // never raw markup in the fallback
  });

  it("gmail_update_draft carries html_body through the same builder", async () => {
    const { client, calls } = fakeClient([{ data: { id: "d1" } }]);
    await handleGmail(client, "gmail_update_draft", {
      draft_id: "d1",
      thread_id: "t1",
      to: "a@example.com",
      subject: "Hi",
      html_body: "<i>updated</i>",
    });

    const mime = rawMime(calls[0]);
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain("<i>updated</i>");
    expect((calls[0].jsonBody as { message: { threadId?: string } }).message.threadId).toBe("t1");
  });
});

describe("reply and forward route html through the CLI helper", () => {
  it("gmail_reply with html_body passes --body <html> --html", async () => {
    const { client, calls } = fakeClient([{ data: { id: "m2" } }]);
    await handleGmail(client, "gmail_reply", {
      message_id: "m1",
      html_body: "<b>Bold reply</b>",
    });

    expect(calls[0]).toMatchObject({
      service: "gmail",
      command: "reply",
      flags: { "message-id": "m1", body: "<b>Bold reply</b>", html: true },
    });
  });

  it("gmail_reply with plain body passes no --html flag", async () => {
    const { client, calls } = fakeClient([{ data: { id: "m2" } }]);
    await handleGmail(client, "gmail_reply", {
      message_id: "m1",
      body: "plain reply",
    });

    const flags = calls[0].flags as Record<string, unknown>;
    expect(flags).toEqual({ "message-id": "m1", body: "plain reply" });
  });

  it("gmail_forward accepts an html note", async () => {
    const { client, calls } = fakeClient([{ data: { id: "m3" } }]);
    await handleGmail(client, "gmail_forward", {
      message_id: "m1",
      to: "b@example.com",
      html_body: "<p>FYI</p>",
    });

    expect(calls[0]).toMatchObject({
      service: "gmail",
      command: "forward",
      flags: { "message-id": "m1", to: "b@example.com", body: "<p>FYI</p>", html: true },
    });
  });

  it("gmail_forward without a note sends neither body nor html flags", async () => {
    const { client, calls } = fakeClient([{ data: { id: "m3" } }]);
    await handleGmail(client, "gmail_forward", {
      message_id: "m1",
      to: "b@example.com",
    });

    expect(calls[0].flags).toEqual({ "message-id": "m1", to: "b@example.com" });
  });
});

describe("body/html_body contract errors fire before any call", () => {
  it("gmail_send with neither body nor html_body is rejected", async () => {
    const { client, calls } = fakeClient([]);
    await expect(
      handleGmail(client, "gmail_send", { to: "a@example.com", subject: "Hi" })
    ).rejects.toThrow(
      "gmail_send: provide body (plain text), html_body (HTML), or both."
    );
    expect(calls).toHaveLength(0);
  });

  it("gmail_reply with both body and html_body is rejected, not half-sent", async () => {
    const { client, calls } = fakeClient([]);
    await expect(
      handleGmail(client, "gmail_reply", {
        message_id: "m1",
        body: "plain",
        html_body: "<b>html</b>",
      })
    ).rejects.toThrow("gmail_reply: provide body or html_body, not both");
    expect(calls).toHaveLength(0);
  });

  it("gmail_reply with neither body nor html_body is rejected", async () => {
    const { client, calls } = fakeClient([]);
    await expect(
      handleGmail(client, "gmail_reply", { message_id: "m1" })
    ).rejects.toThrow("gmail_reply: provide body (plain text) or html_body (HTML).");
    expect(calls).toHaveLength(0);
  });

  it("gmail_forward with both body and html_body is rejected", async () => {
    const { client, calls } = fakeClient([]);
    await expect(
      handleGmail(client, "gmail_forward", {
        message_id: "m1",
        to: "b@example.com",
        body: "plain",
        html_body: "<p>html</p>",
      })
    ).rejects.toThrow("gmail_forward: provide body or html_body, not both");
    expect(calls).toHaveLength(0);
  });
});
