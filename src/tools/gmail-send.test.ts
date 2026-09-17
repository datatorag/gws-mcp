import { describe, expect, it } from "vitest";
import { handleGmail } from "./gmail.js";
import { fakeClient, payload } from "./fake-client.test-helper.js";

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

/** Every SEND tool resolves the signature before it composes anything
 * (SCRUM-278), so a plan for gmail_send / _reply / _forward / _send_draft
 * leads with a sendAs.list step and the composed call lands at calls[1].
 * These cases assert the UNSIGNED shape, so the account has no signature —
 * which is also the property "a plain send with no signature is byte-identical
 * to before" is made of. */
const NO_SIG = { data: { sendAs: [{ isDefault: true, signature: "" }] } };

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
    const { client, calls } = fakeClient([NO_SIG, { data: { id: "m1" } }]);
    await handleGmail(client, "gmail_send", {
      to: "a@example.com",
      subject: "Hi",
      body: "plain words",
    });

    expect(calls[1]).toMatchObject({
      service: "gmail",
      command: "send",
      flags: { to: "a@example.com", subject: "Hi", body: "plain words" },
    });
  });
});

describe("html_body composes multipart/alternative", () => {
  it("gmail_send with html_body sends raw MIME via the API, not the helper", async () => {
    const { client, calls } = fakeClient([NO_SIG, { data: { id: "m1" } }]);
    await handleGmail(client, "gmail_send", {
      to: "a@example.com",
      subject: "Hi",
      body: "fallback text",
      html_body: "<p>Hello <b>world</b></p>",
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      service: "gmail",
      resource: "users.messages",
      method: "send",
      params: { userId: "me" },
    });

    const mime = rawMime(calls[1]);
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
    const { client, calls } = fakeClient([NO_SIG, { data: { id: "m2" } }]);
    await handleGmail(client, "gmail_reply", {
      message_id: "m1",
      html_body: "<b>Bold reply</b>",
    });

    expect(calls[1]).toMatchObject({
      service: "gmail",
      command: "reply",
      flags: { "message-id": "m1", body: "<b>Bold reply</b>", html: true },
    });
  });

  it("gmail_reply with plain body passes no --html flag", async () => {
    const { client, calls } = fakeClient([NO_SIG, { data: { id: "m2" } }]);
    await handleGmail(client, "gmail_reply", {
      message_id: "m1",
      body: "plain reply",
    });

    const flags = calls[1].flags as Record<string, unknown>;
    expect(flags).toEqual({ "message-id": "m1", body: "plain reply" });
  });

  it("gmail_forward accepts an html note", async () => {
    const { client, calls } = fakeClient([NO_SIG, { data: { id: "m3" } }]);
    await handleGmail(client, "gmail_forward", {
      message_id: "m1",
      to: "b@example.com",
      html_body: "<p>FYI</p>",
    });

    expect(calls[1]).toMatchObject({
      service: "gmail",
      command: "forward",
      flags: { "message-id": "m1", to: "b@example.com", body: "<p>FYI</p>", html: true },
    });
  });

  it("gmail_forward without a note sends neither body nor html flags", async () => {
    const { client, calls } = fakeClient([NO_SIG, { data: { id: "m3" } }]);
    await handleGmail(client, "gmail_forward", {
      message_id: "m1",
      to: "b@example.com",
    });

    expect(calls[1].flags).toEqual({ "message-id": "m1", to: "b@example.com" });
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

/* SCRUM-249: a header is ASCII or it is not a header. The raw builder used to
 * write the subject and the address display names as given, so an em-dash, an
 * accented letter or a CJK character went out as raw UTF-8 bytes and arrived
 * as mojibake. Encoded per RFC 2047 now, and a plain-text send whose headers
 * need it takes the raw path too, so the encoding is ours on every route. */
describe("non-ASCII headers are RFC 2047 encoded (SCRUM-249)", () => {
  function decodeHeader(value: string): string {
    return value
      .replace(/\r\n[ \t]/g, "")
      .replace(/(\?=)\s+(=\?)/g, "$1$2")
      .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g, (_m, b64: string) =>
        Buffer.from(b64, "base64").toString("utf-8")
      );
  }
  /** The Subject header line of a raw MIME string, folded continuation included. */
  function subjectLine(mime: string): string {
    const head = mime.split("\r\n\r\n")[0];
    const m = /^Subject: ((?:.*)(?:\r\n[ \t].*)*)/m.exec(head);
    if (!m) throw new Error("no Subject header");
    return m[1];
  }

  it.each([
    ["an em-dash", "Launch — tomorrow"],
    ["an accented letter", "Résumé attached"],
    ["a CJK character", "会議のメモ"],
  ])("html send: a subject with %s goes out ASCII-only and reads back exactly", async (_l, subject) => {
    const { client, calls } = fakeClient([NO_SIG, { data: { id: "m1" } }]);
    await handleGmail(client, "gmail_send", {
      to: "a@example.com",
      subject,
      html_body: "<p>hi</p>",
    });
    const mime = rawMime(calls[1]);
    const line = subjectLine(mime);
    expect(line).not.toMatch(/[^\x20-\x7e\r\n]/);
    expect(decodeHeader(line)).toBe(subject);
  });

  it("plain send with a non-ASCII subject takes the raw API path with the encoded header", async () => {
    const { client, calls } = fakeClient([NO_SIG, { data: { id: "m1" } }]);
    await handleGmail(client, "gmail_send", {
      to: "a@example.com",
      subject: "Café — 東京",
      body: "plain words",
    });
    expect(calls[1]).toMatchObject({ service: "gmail", resource: "users.messages", method: "send" });
    const mime = rawMime(calls[1]);
    expect(decodeHeader(subjectLine(mime))).toBe("Café — 東京");
    expect(mime).toContain("Content-Type: text/plain; charset=utf-8");
    expect(mime.split("\r\n\r\n").slice(1).join("\r\n\r\n")).toContain("plain words");
  });

  it("plain send with ASCII headers still goes through the CLI helper", async () => {
    const { client, calls } = fakeClient([NO_SIG, { data: { id: "m1" } }]);
    await handleGmail(client, "gmail_send", { to: "a@example.com", subject: "Hi", body: "x" });
    expect(calls[1]).toMatchObject({ command: "send" });
  });

  it("drafts encode the display name in To and leave the address bare", async () => {
    const { client, calls } = fakeClient([{ data: { id: "d1", message: { id: "m1" } } }]);
    await handleGmail(client, "gmail_create_draft", {
      to: "Jörg Müller <jorg@example.com>",
      subject: "Hi",
      body: "x",
    });
    const mime = rawMime(calls[0]);
    const to = /^To: (.*)$/m.exec(mime)![1];
    expect(to).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <jorg@example.com>$/);
    expect(decodeHeader(to)).toBe("Jörg Müller <jorg@example.com>");
  });
});

describe("the raw builder refuses a line break in a header (SCRUM-249)", () => {
  it.each(["subject", "to", "cc", "bcc"])("rejects a %s carrying CR or LF instead of emitting a second header", async (field) => {
    const { client, calls } = fakeClient([{ data: { id: "m1" } }]);
    const args: Record<string, unknown> = {
      to: "a@example.com",
      subject: "Hi",
      html_body: "<p>hi</p>",
      [field]: field === "subject" ? "Hi\r\nBcc: x@example.com" : "a@example.com\nBcc: x@example.com",
    };
    await expect(handleGmail(client, "gmail_send", args)).rejects.toThrow(/line break/);
    expect(calls).toHaveLength(0);
  });
});

/* SCRUM-278: the account's Gmail signature is appended when mail is SENT, and
 * it goes in the HTML PART ONLY. The plain part is built from the body alone,
 * exactly as before. These assert the EMITTED REQUEST and the reported state,
 * because the failure this feature exists to end was silent: a send that
 * looked fine and arrived without the sender's signature. */
describe("signature on send (SCRUM-278)", () => {
  const SIG = '<div dir="ltr">Regards,<div>Dana Rivers</div></div>';
  const withSig = (signature = SIG) => ({
    data: { sendAs: [{ sendAsEmail: "sender@example.com", isDefault: true, signature }] },
  });
  const sent = { data: { id: "m1", threadId: "t1" } };

  it("looks the signature up before it composes anything", async () => {
    const { client, calls } = fakeClient([withSig(), sent]);
    await handleGmail(client, "gmail_send", { to: "a@b.c", subject: "Hi", body: "Hi" });
    expect(calls[0]).toMatchObject({
      service: "gmail",
      resource: "users.settings.sendAs",
      method: "list",
      params: { userId: "me" },
    });
  });

  it("promotes a plain send to multipart, signing only the HTML part", async () => {
    const { client, calls } = fakeClient([withSig(), sent]);
    const res = await handleGmail(client, "gmail_send", {
      to: "a@b.c",
      subject: "Hi",
      body: "1 < 2 & 3 > 2\nsecond line",
    });

    // the CLI helper path is NOT used when a signature has to be applied
    expect(calls[1]).toMatchObject({ resource: "users.messages", method: "send" });
    const { parts } = parseMultipart(rawMime(calls[1]));
    expect(parts).toHaveLength(2);
    // plain part: the caller's body, untouched, no signature
    expect(parts[0]).toContain("1 < 2 & 3 > 2");
    expect(parts[0]).not.toContain("Dana Rivers");
    // html part: escaped body plus the stored markup, byte-identical
    expect(parts[1]).toContain("1 &lt; 2 &amp; 3 &gt; 2<br>second line");
    expect(parts[1]).toContain(SIG);
    expect(parts[1]).toContain('class="gmail_signature"');
    expect(payload(res).signature).toBe("applied");
  });

  it("signs only the html part when the caller gave body and html_body", async () => {
    const { client, calls } = fakeClient([withSig(), sent]);
    await handleGmail(client, "gmail_send", {
      to: "a@b.c",
      subject: "Hi",
      body: "plain",
      html_body: "<p>rich</p>",
    });
    const { parts } = parseMultipart(rawMime(calls[1]));
    expect(parts[0]).toContain("plain");
    expect(parts[0]).not.toContain("Dana Rivers");
    expect(parts[1]).toContain(SIG);
    expect(parts[1]).toContain("<p>rich</p>");
  });

  it("keeps the signature out of a plain fallback derived from html_body", async () => {
    const { client, calls } = fakeClient([withSig(), sent]);
    await handleGmail(client, "gmail_send", {
      to: "a@b.c",
      subject: "Hi",
      html_body: "<p>rich</p>",
    });
    const { parts } = parseMultipart(rawMime(calls[1]));
    expect(parts[0]).toContain("rich");
    expect(parts[0]).not.toContain("Dana Rivers");
    expect(parts[1]).toContain(SIG);
  });

  it("carries an image signature through byte-identical", async () => {
    const img =
      '<div dir="ltr">Dana Rivers<br><div><img width="96" height="96" ' +
      'src="https://img.example.com/mail-sig/abc123"></div></div>';
    const { client, calls } = fakeClient([withSig(img), sent]);
    await handleGmail(client, "gmail_send", { to: "a@b.c", subject: "Hi", body: "Hi" });
    const { parts } = parseMultipart(rawMime(calls[1]));
    expect(parts[1]).toContain(img);
    expect(parts[0]).not.toContain("img");
  });

  it("a plain send with NO signature is byte-identical to before", async () => {
    const { client, calls } = fakeClient([NO_SIG, sent]);
    const res = await handleGmail(client, "gmail_send", {
      to: "a@b.c",
      subject: "Hi",
      body: "plain words",
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ service: "gmail", command: "send" });
    expect(calls[1].flags).toEqual({ to: "a@b.c", subject: "Hi", body: "plain words" });
    expect(payload(res).signature).toBe("none_set");
  });

  it("signature: false makes NO sendAs call and sends the body untouched", async () => {
    const { client, calls } = fakeClient([sent]);
    const res = await handleGmail(client, "gmail_send", {
      to: "a@b.c",
      subject: "Hi",
      body: "plain words",
      signature: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "send" });
    expect(calls[0].flags).toEqual({ to: "a@b.c", subject: "Hi", body: "plain words" });
    expect(payload(res).signature).toBe("suppressed");
  });

  it("a failed lookup does not block the send", async () => {
    const { client, calls } = fakeClient([{ throws: "API error: 503" }, sent]);
    const res = await handleGmail(client, "gmail_send", {
      to: "a@b.c",
      subject: "Hi",
      body: "plain words",
    });
    expect(calls[1]).toMatchObject({ command: "send" });
    expect(calls[1].flags).toEqual({ to: "a@b.c", subject: "Hi", body: "plain words" });
    expect(payload(res).signature).toBe("unavailable");
  });

  it("does not append a second copy to a body that already carries it", async () => {
    const { client, calls } = fakeClient([withSig(), sent]);
    const already = `<p>Hi</p><div class="gmail_signature">${SIG}</div>`;
    const res = await handleGmail(client, "gmail_send", {
      to: "a@b.c",
      subject: "Hi",
      html_body: already,
    });
    expect(rawMime(calls[1])).toContain(already);
    expect(rawMime(calls[1]).match(/gmail_signature/g)).toHaveLength(1);
    expect(payload(res).signature).toBe("already_present");
  });

  /* THE CACHE TEST. create-server.ts builds a new client per tool call with
   * that caller's token, so a signature remembered between calls would go out
   * on another customer's mail. Any cache, at any level, fails this. */
  it("two clients with different signatures never share one", async () => {
    const a = fakeClient([withSig("<div>Alpha Signature</div>"), { data: { id: "m1" } }]);
    await handleGmail(a.client, "gmail_send", { to: "a@b.c", subject: "Hi", body: "Hi" });
    const b = fakeClient([withSig("<div>Beta Signature</div>"), { data: { id: "m2" } }]);
    await handleGmail(b.client, "gmail_send", { to: "a@b.c", subject: "Hi", body: "Hi" });

    const mimeA = rawMime(a.calls[1]);
    const mimeB = rawMime(b.calls[1]);
    expect(mimeA).toContain("Alpha Signature");
    expect(mimeA).not.toContain("Beta Signature");
    expect(mimeB).toContain("Beta Signature");
    expect(mimeB).not.toContain("Alpha Signature");
    expect(a.calls[0]).toMatchObject({ resource: "users.settings.sendAs" });
    expect(b.calls[0]).toMatchObject({ resource: "users.settings.sendAs" });
  });

  it("gmail_reply sends a signed plain note as HTML so it lands above the quote", async () => {
    const { client, calls } = fakeClient([withSig(), sent]);
    const res = await handleGmail(client, "gmail_reply", { message_id: "m0", body: "my reply" });
    const flags = calls[1].flags as Record<string, unknown>;
    expect(flags.html).toBe(true);
    expect(flags.body).toContain("my reply");
    expect(flags.body).toContain('class="gmail_signature"');
    expect(payload(res).signature).toBe("applied");
  });

  it("gmail_reply keeps an html_body reply as HTML and appends the signature", async () => {
    const { client, calls } = fakeClient([withSig(), sent]);
    await handleGmail(client, "gmail_reply", { message_id: "m0", html_body: "<b>rich</b>" });
    const flags = calls[1].flags as Record<string, unknown>;
    expect(flags.body).toContain("<b>rich</b>");
    expect(flags.body).toContain(SIG);
  });

  it("gmail_forward with no note sends the signature as the note", async () => {
    const { client, calls } = fakeClient([withSig(), sent]);
    await handleGmail(client, "gmail_forward", { message_id: "m0", to: "b@c.d" });
    const flags = calls[1].flags as Record<string, unknown>;
    expect(flags.html).toBe(true);
    expect(flags.body).toContain(SIG);
  });

  it("the draft tools never touch the signature", async () => {
    for (const tool of ["gmail_create_draft", "gmail_update_draft"]) {
      const { client, calls } = fakeClient([{ data: { id: "d1", message: { id: "m1" } } }]);
      await handleGmail(client, tool, {
        draft_id: "d1",
        thread_id: "t1",
        to: "a@b.c",
        subject: "Hi",
        body: "Hi",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ resource: "users.drafts" });
      expect(rawMime(calls[0])).not.toContain("gmail_signature");
    }
  });
});

describe("gmail_send_draft signs the stored MIME (SCRUM-278)", () => {
  const SIG = '<div dir="ltr">Regards,<div>Dana Rivers</div></div>';
  const raw = (...lines: string[]) => Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
  const draftGet = (rawB64: string, threadId = "t1") => ({
    data: { id: "d1", message: { id: "m1", threadId, raw: rawB64 } },
  });
  const sendAs = (signature = SIG, email = "sender@example.com") => ({
    data: { sendAs: [{ sendAsEmail: email, isDefault: true, signature }] },
  });
  const PLAIN = raw(
    "From: Dana Rivers <sender@example.com>",
    "To: someone@example.com",
    "Subject: Hello",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Hi there"
  );
  const updatedRaw = (call: Record<string, unknown>) => {
    const body = call.jsonBody as { message: { raw: string } };
    return Buffer.from(body.message.raw, "base64url").toString("utf8");
  };
  /** The updated draft with every part decoded, since an HTML part this code
   * authors is written base64 and so is not literally present in the raw. */
  const updatedDecoded = (call: Record<string, unknown>) => {
    const out = updatedRaw(call);
    const boundary = /boundary="([^"]+)"/.exec(out)?.[1];
    if (!boundary) return out;
    return out
      .split(`--${boundary}`)
      .slice(1, -1)
      .map((p) => {
        const region = p.replace(/^\r\n/, "");
        const sep = region.indexOf("\r\n\r\n");
        const headers = region.slice(0, sep);
        const body = region.slice(sep + 4).replace(/\r\n$/, "");
        return /base64/i.test(headers)
          ? Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8")
          : body;
      })
      .join("\n----\n");
  };

  it("gets the draft, updates it with the signature, then sends it", async () => {
    const { client, calls } = fakeClient([
      draftGet(PLAIN),
      sendAs(),
      { data: { id: "d1" } },
      { data: { id: "m1" } },
    ]);
    const res = await handleGmail(client, "gmail_send_draft", { draft_id: "d1" });

    expect(calls.map((c) => `${c.resource}.${c.method}`)).toEqual([
      "users.drafts.get",
      "users.settings.sendAs.list",
      "users.drafts.update",
      "users.drafts.send",
    ]);
    expect(calls[0]).toMatchObject({ params: { userId: "me", id: "d1", format: "raw" } });
    expect(updatedRaw(calls[2])).toContain("multipart/alternative");
    expect(updatedDecoded(calls[2])).toContain(SIG);
    expect((calls[2].jsonBody as { message: { threadId?: string } }).message.threadId).toBe("t1");
    expect(payload(res).signature).toBe("applied");
  });

  it("uses the sendAs entry matching the draft's From, not the default", async () => {
    const aliasDraft = raw(
      "From: Alias <alias@example.com>",
      "To: a@b.c",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Hi"
    );
    const { client, calls } = fakeClient([
      draftGet(aliasDraft),
      {
        data: {
          sendAs: [
            { sendAsEmail: "sender@example.com", isDefault: true, signature: "<div>Default</div>" },
            { sendAsEmail: "alias@example.com", isDefault: false, signature: "<div>Alias sig</div>" },
          ],
        },
      },
      { data: { id: "d1" } },
      { data: { id: "m1" } },
    ]);
    await handleGmail(client, "gmail_send_draft", { draft_id: "d1" });
    expect(updatedDecoded(calls[2])).toContain("Alias sig");
    expect(updatedDecoded(calls[2])).not.toContain("Default");
  });

  it("signature: false sends the draft as-is, with no get and no lookup", async () => {
    const { client, calls } = fakeClient([{ data: { id: "m1" } }]);
    const res = await handleGmail(client, "gmail_send_draft", { draft_id: "d1", signature: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ resource: "users.drafts", method: "send" });
    expect(payload(res).signature).toBe("suppressed");
  });

  it("sends a draft carrying an attachment untouched", async () => {
    const mixed = raw(
      "From: a@b.c",
      'Content-Type: multipart/mixed; boundary="m1"',
      "",
      "--m1",
      "Content-Type: text/plain",
      "",
      "Hi",
      "--m1",
      "Content-Type: application/pdf; name=x.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      "AAAA",
      "--m1--",
      ""
    );
    const { client, calls } = fakeClient([draftGet(mixed), sendAs(), { data: { id: "m1" } }]);
    const res = await handleGmail(client, "gmail_send_draft", { draft_id: "d1" });
    expect(calls.map((c) => c.method)).toEqual(["get", "list", "send"]);
    expect(payload(res).signature).toBe("skipped_unsupported_draft");
  });

  it("a retry after a failed send does not add a second signature", async () => {
    // The draft on the server now holds the signature the first attempt wrote.
    const signedDraft = raw(
      "From: Dana Rivers <sender@example.com>",
      "To: a@b.c",
      'Content-Type: multipart/alternative; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain",
      "",
      "Hi there",
      "--b1",
      "Content-Type: text/html",
      "",
      `<div>Hi there</div><div class="gmail_signature">${SIG}</div>`,
      "--b1--",
      ""
    );
    const { client, calls } = fakeClient([draftGet(signedDraft), sendAs(), { data: { id: "m1" } }]);
    const res = await handleGmail(client, "gmail_send_draft", { draft_id: "d1" });
    expect(calls.map((c) => c.method)).toEqual(["get", "list", "send"]);
    expect(payload(res).signature).toBe("already_present");
  });

  it("sends the draft when the account has no signature", async () => {
    const { client, calls } = fakeClient([draftGet(PLAIN), NO_SIG, { data: { id: "m1" } }]);
    const res = await handleGmail(client, "gmail_send_draft", { draft_id: "d1" });
    expect(calls.map((c) => c.method)).toEqual(["get", "list", "send"]);
    expect(payload(res).signature).toBe("none_set");
  });

  it("sends the draft when the lookup fails", async () => {
    const { client, calls } = fakeClient([
      draftGet(PLAIN),
      { throws: "API error: 503" },
      { data: { id: "m1" } },
    ]);
    const res = await handleGmail(client, "gmail_send_draft", { draft_id: "d1" });
    expect(calls.map((c) => c.method)).toEqual(["get", "list", "send"]);
    expect(payload(res).signature).toBe("unavailable");
  });

  /* Nothing in the signature path may cost the user their send. */
  it("sends the draft when the get fails", async () => {
    const { client, calls } = fakeClient([{ throws: "API error: 500" }, { data: { id: "m1" } }]);
    const res = await handleGmail(client, "gmail_send_draft", { draft_id: "d1" });
    expect(calls.map((c) => c.method)).toEqual(["get", "send"]);
    expect(payload(res).signature).toBe("unavailable");
  });

  it("sends the draft when Gmail rejects our rewrite on update", async () => {
    const { client, calls } = fakeClient([
      draftGet(PLAIN),
      sendAs(),
      { throws: "API error: 400 invalid raw" },
      { data: { id: "m1" } },
    ]);
    const res = await handleGmail(client, "gmail_send_draft", { draft_id: "d1" });
    expect(calls.map((c) => c.method)).toEqual(["get", "list", "update", "send"]);
    expect(payload(res).signature).toBe("skipped_unsupported_draft");
  });

  it("signs a reply draft whose quoted thread already carries a signature", async () => {
    // Bug 1's real-world form: the quote holds an earlier signature block, and
    // reading the marker across the whole body would send this reply bare.
    const quoted = raw(
      "From: Dana Rivers <sender@example.com>",
      "To: a@b.c",
      'Content-Type: multipart/alternative; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain",
      "",
      "my reply",
      "--b1",
      "Content-Type: text/html",
      "",
      `<div>my reply</div><div class="gmail_quote">earlier` +
        `<div class="gmail_signature">${SIG}</div></div>`,
      "--b1--",
      ""
    );
    const { client, calls } = fakeClient([
      draftGet(quoted),
      sendAs(),
      { data: { id: "d1" } },
      { data: { id: "m1" } },
    ]);
    const res = await handleGmail(client, "gmail_send_draft", { draft_id: "d1" });
    expect(payload(res).signature).toBe("applied");
    const out = updatedDecoded(calls[2]);
    expect(out.indexOf("gmail_signature")).toBeLessThan(out.indexOf("gmail_quote"));
  });

  it("sends the draft untouched when the rewrite would not fit in one argv string", async () => {
    const huge = raw(
      "From: Dana Rivers <sender@example.com>",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "x".repeat(130_000)
    );
    const { client, calls } = fakeClient([draftGet(huge), sendAs(), { data: { id: "m1" } }]);
    const res = await handleGmail(client, "gmail_send_draft", { draft_id: "d1" });
    expect(calls.map((c) => c.method)).toEqual(["get", "list", "send"]);
    expect(payload(res).signature).toBe("skipped_unsupported_draft");
  });
});

/* The plugin serves every session from one event loop, so work done on a
 * caller's uncapped html_body is every tenant's problem. Nothing upstream
 * caps an inbound body — the argv guard is downstream of this. */
describe("a large adversarial html_body does not stall the loop", () => {
  const withSig = { data: { sendAs: [{ isDefault: true, signature: "<div>Sig</div>" }] } };
  // Markup with many '<' and no '>' is the shape that makes a tag-stripping
  // scan superlinear. Sized at the argv ceiling: the largest body that can
  // reach any of this.
  const evil = "<div ".repeat(Math.ceil((128 * 1024) / 5));

  it("gmail_reply does not flatten the caller's markup at all", async () => {
    const { client, calls } = fakeClient([withSig, { data: { id: "m1" } }]);
    const started = Date.now();
    await handleGmail(client, "gmail_reply", { message_id: "m0", html_body: evil });
    expect(Date.now() - started).toBeLessThan(1000);
    // and what goes out is the caller's markup plus the signature
    expect(calls[1].flags).toMatchObject({ html: true });
  });

  it("gmail_forward does not flatten the caller's markup at all", async () => {
    const { client } = fakeClient([withSig, { data: { id: "m1" } }]);
    const started = Date.now();
    await handleGmail(client, "gmail_forward", {
      message_id: "m0",
      to: "b@c.d",
      html_body: evil,
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
