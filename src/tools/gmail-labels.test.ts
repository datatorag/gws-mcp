import { describe, expect, it, vi } from "vitest";
import type { GwsClient } from "../gws-client.js";
import { gmailTools, handleGmail } from "./gmail.js";
import { MUTATE, READ } from "./annotations.js";

function fakeClient(plan: Array<{ data?: unknown; throws?: string }>) {
  const calls: Array<Record<string, unknown>> = [];
  const api = vi.fn(async (service, resource, method, opts) => {
    calls.push({ service, resource, method, ...opts });
    const step = plan.shift();
    if (!step) throw new Error("fake client: no planned response left");
    if (step.throws) throw new Error(step.throws);
    return { success: true, data: step.data };
  });
  return { client: { api } as unknown as GwsClient, calls };
}

const payload = (r: { content: { text: string }[] }) =>
  JSON.parse(r.content[0].text);

describe("gmail_create_label", () => {
  it("returns the created label with its id", async () => {
    const { client } = fakeClient([
      { data: { id: "Label_12", name: "Alerts/Invoices", type: "user" } },
    ]);

    const result = await handleGmail(client, "gmail_create_label", {
      name: "Alerts/Invoices",
    });

    expect(payload(result)).toMatchObject({ id: "Label_12" });
  });

  /** The bug this suite exists for: the API creates the label and answers
   * with an EMPTY body, which used to be returned verbatim. The tool
   * promises "the created label including its ID" and the documented
   * create -> filter chain depends on it, so a caller was left with no way
   * to get the id. A fake client that always supplies a response is exactly
   * what hid this, so the empty answer is modelled explicitly. */
  it("recovers the id by listing when the API answers with nothing", async () => {
    const { client, calls } = fakeClient([
      { data: "" },
      {
        data: {
          labels: [
            { id: "INBOX", name: "INBOX", type: "system" },
            { id: "Label_12", name: "Alerts/Invoices", type: "user" },
          ],
        },
      },
    ]);

    const result = await handleGmail(client, "gmail_create_label", {
      name: "Alerts/Invoices",
    });

    expect(payload(result)).toEqual({
      id: "Label_12",
      name: "Alerts/Invoices",
      type: "user",
    });
    expect(calls[1]).toMatchObject({ resource: "users.labels", method: "list" });
  });

  it("says how to recover rather than returning an empty success", async () => {
    const { client } = fakeClient([{ data: "" }, { data: { labels: [] } }]);

    await expect(
      handleGmail(client, "gmail_create_label", { name: "Ghost" })
    ).rejects.toThrow("gmail_list_labels");
  });
});

describe("the rest of the label surface", () => {
  it("lists labels with a count", async () => {
    const { client } = fakeClient([
      { data: { labels: [{ id: "INBOX", name: "INBOX" }, { id: "L_1", name: "Work" }] } },
    ]);

    const result = await handleGmail(client, "gmail_list_labels", {});

    expect(payload(result)).toMatchObject({ count: 2 });
  });

  it("patches only the fields it was given", async () => {
    const { client, calls } = fakeClient([{ data: { id: "L_1", name: "Renamed" } }]);

    await handleGmail(client, "gmail_update_label", {
      label_id: "L_1",
      name: "Renamed",
    });

    expect(calls[0]).toMatchObject({
      resource: "users.labels",
      method: "patch",
      params: { id: "L_1" },
      jsonBody: { name: "Renamed" },
    });
    expect(calls[0].jsonBody).not.toHaveProperty("labelListVisibility");
  });

  it("refuses an update that changes nothing", async () => {
    const { client } = fakeClient([]);
    await expect(
      handleGmail(client, "gmail_update_label", { label_id: "L_1" })
    ).rejects.toThrow("at least one of");
  });

  it("deletes by id", async () => {
    const { client, calls } = fakeClient([{ data: "" }]);

    await handleGmail(client, "gmail_delete_label", { label_id: "L_1" });

    expect(calls[0]).toMatchObject({
      resource: "users.labels",
      method: "delete",
      params: { id: "L_1" },
    });
  });
});

describe("gmail_label_message vs gmail_mark_read", () => {
  it("applies exactly the labels asked for, with no read-state side effect", async () => {
    const { client, calls } = fakeClient([{ data: { id: "m1" } }]);

    await handleGmail(client, "gmail_label_message", {
      message_id: "m1",
      add_labels: ["Label_12"],
    });

    // The crucial difference from mark_read: no removeLabelIds: ["UNREAD"].
    expect(calls[0].jsonBody).toEqual({ addLabelIds: ["Label_12"] });
  });

  it("will not run without labels, rather than silently marking read", async () => {
    const { client } = fakeClient([]);
    await expect(
      handleGmail(client, "gmail_label_message", { message_id: "m1" })
    ).rejects.toThrow("add_labels");
  });

  it("keeps gmail_mark_read's default and its label params working", async () => {
    // Backward compatibility: callers already pass add_labels/remove_labels
    // to gmail_mark_read daily. Those keep working unchanged.
    const { client, calls } = fakeClient([{ data: { id: "m1" } }, { data: { id: "m2" } }]);

    await handleGmail(client, "gmail_mark_read", { message_id: "m1" });
    expect(calls[0].jsonBody).toEqual({ removeLabelIds: ["UNREAD"] });

    await handleGmail(client, "gmail_mark_read", {
      message_id: "m2",
      add_labels: ["Label_12"],
      remove_labels: ["INBOX"],
    });
    expect(calls[1].jsonBody).toEqual({
      addLabelIds: ["Label_12"],
      removeLabelIds: ["INBOX"],
    });
  });

  it("batches without pretending the API returned a body", async () => {
    const { client } = fakeClient([{ data: "" }]);

    const result = await handleGmail(client, "gmail_label_message", {
      message_ids: ["a", "b"],
      remove_labels: ["INBOX"],
    });

    expect(payload(result)).toMatchObject({ modified: 2, ids: ["a", "b"] });
  });
});

describe("label tool annotations", () => {
  it.each([
    ["gmail_list_labels", READ("List email labels")],
    ["gmail_delete_label", MUTATE("Delete email label and remove it from all mail")],
    ["gmail_label_message", MUTATE("Add or remove labels on email")],
  ])("%s is pinned to its exact shape", (name, expected) => {
    const tool = gmailTools.find((t) => t.name === name);
    expect(tool?.annotations).toEqual(expected);
  });
});
