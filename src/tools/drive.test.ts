import { describe, expect, it } from "vitest";
import { CREATE, MUTATE } from "./annotations.js";
import { driveTools, handleDrive } from "./drive.js";
import { fakeClient, payload } from "./fake-client.test-helper.js";

/** SCRUM-170: a file created through this server could not be renamed or
 * copied through it. The gws CLI is not a fallback — it is authed as another
 * identity and 403s on the owner's own files — so these two tools are the
 * only path. The tests below are about the call actually sent to Drive,
 * because that is the part no unit test can re-verify after a shape change
 * upstream and the part a live smoke test is slowest to bisect. */

const renamed = {
  data: { id: "file-1", name: "Built With directory", webViewLink: "https://drive/f1" },
};

describe("drive_rename_file", () => {
  it("renames through files.update, sending the name and nothing else", async () => {
    // files.update is a PATCH: every field present in the body is written.
    // Sending anything beyond `name` here would overwrite state the caller
    // never mentioned — the reason this body is asserted key-for-key.
    const { client, calls } = fakeClient([renamed]);

    await handleDrive(client, "drive_rename_file", {
      file_id: "file-1",
      name: "Built With directory",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      service: "drive",
      resource: "files",
      method: "update",
      params: { fileId: "file-1", supportsAllDrives: true },
      jsonBody: { name: "Built With directory" },
    });
    expect(Object.keys(calls[0].jsonBody as object)).toEqual(["name"]);
  });

  it("asks Drive for the stored name back, so the caller sees what landed", async () => {
    // Drive normalises names (it strips nothing today, but it has). Echoing
    // the requested name would report success for a write we never read.
    const { client, calls } = fakeClient([renamed]);

    const result = await handleDrive(client, "drive_rename_file", {
      file_id: "file-1",
      name: "Built With directory",
    });

    expect(String((calls[0].params as { fields: string }).fields)).toContain("name");
    expect(payload(result).name).toBe("Built With directory");
  });

  it("refuses a blank name instead of erasing the one the file has", async () => {
    // The schema check at the boundary catches a missing `name`, not an empty
    // or whitespace one. Drive accepts "" and the file becomes unfindable by
    // name — a destructive outcome from a tool the user approved as a rename.
    const { client, calls } = fakeClient([renamed]);

    await expect(
      handleDrive(client, "drive_rename_file", { file_id: "file-1", name: "   " })
    ).rejects.toThrow(/blank/i);
    expect(calls).toHaveLength(0);
  });
});

const copied = {
  data: {
    id: "copy-1",
    name: "r/saasbuild harvest",
    parents: ["folder-9"],
    webViewLink: "https://drive/c1",
  },
};

describe("drive_copy_file", () => {
  it("copies through files.copy, naming the copy in one round trip", async () => {
    // The template path is copy-then-use. A copy that lands as "Copy of X"
    // and needs a second rename call is the gap this ticket exists to close.
    const { client, calls } = fakeClient([copied]);

    await handleDrive(client, "drive_copy_file", {
      file_id: "template-1",
      name: "r/saasbuild harvest",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      service: "drive",
      resource: "files",
      method: "copy",
      params: { fileId: "template-1", supportsAllDrives: true },
      jsonBody: { name: "r/saasbuild harvest" },
    });
  });

  it("omits parents entirely when no parent_id is given", async () => {
    // `parents: []` and `parents: [undefined]` are not the same request as
    // no key at all: Drive reads an explicit empty list as "no folder".
    const { client, calls } = fakeClient([copied]);

    await handleDrive(client, "drive_copy_file", {
      file_id: "template-1",
      name: "r/saasbuild harvest",
    });

    expect(calls[0].jsonBody).not.toHaveProperty("parents");
  });

  it("puts the copy in parent_id when one is given", async () => {
    const { client, calls } = fakeClient([copied]);

    const result = await handleDrive(client, "drive_copy_file", {
      file_id: "template-1",
      name: "r/saasbuild harvest",
      parent_id: "folder-9",
    });

    expect(calls[0].jsonBody).toMatchObject({ parents: ["folder-9"] });
    // Where it landed is the one thing the caller cannot see afterwards
    // without another call, so the response has to carry it.
    expect(String((calls[0].params as { fields: string }).fields)).toContain("parents");
    expect(payload(result).parents).toEqual(["folder-9"]);
  });

  it("refuses a blank name rather than creating an unnamed duplicate", async () => {
    const { client, calls } = fakeClient([copied]);

    await expect(
      handleDrive(client, "drive_copy_file", { file_id: "template-1", name: "" })
    ).rejects.toThrow(/blank/i);
    expect(calls).toHaveLength(0);
  });
});

describe("registration and consent", () => {
  it("advertises both tools, since a handler alone is invisible to the model", () => {
    // SCRUM-170 names this exact failure mode: the surface is what is
    // registered, not what is implemented.
    const names = driveTools.map((t) => t.name);
    expect(names).toContain("drive_rename_file");
    expect(names).toContain("drive_copy_file");
  });

  it("prompts for rename as destructive and copy as merely additive", () => {
    // A rename overwrites state the user cannot recover from the tool; a copy
    // adds a file and destroys nothing. Getting these backwards either buries
    // the copy path in prompts or lets a rename through without one.
    const byName = new Map(driveTools.map((t) => [t.name, t]));
    expect(byName.get("drive_rename_file")?.annotations).toMatchObject({
      readOnlyHint: MUTATE("x").readOnlyHint,
      destructiveHint: MUTATE("x").destructiveHint,
    });
    expect(byName.get("drive_copy_file")?.annotations).toMatchObject({
      readOnlyHint: CREATE("x").readOnlyHint,
      destructiveHint: CREATE("x").destructiveHint,
    });
  });
});
