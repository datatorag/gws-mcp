import { describe, expect, it } from "vitest";
import { handleTasks, tasksTools } from "./tasks.js";
import { fakeClient, payload } from "./fake-client.test-helper.js";
import { validateArgs } from "./validate.js";

const tool = (name: string) => {
  const found = tasksTools.find((t) => t.name === name);
  if (!found) throw new Error(`tasksTools has no ${name}`);
  return found;
};

describe("tasks_create_tasklist (SCRUM-167)", () => {
  it("inserts the list, with the title in the body and no params", async () => {
    const { client, calls } = fakeClient([{ data: { id: "L1", title: "Q3 triage" } }]);

    const result = await handleTasks(client, "tasks_create_tasklist", {
      title: "Q3 triage",
    });

    expect(calls).toEqual([
      {
        service: "tasks",
        resource: "tasklists",
        method: "insert",
        jsonBody: { title: "Q3 triage" },
      },
    ]);
    expect(payload(result)).toEqual({ id: "L1", title: "Q3 triage" });
  });

  it("trims surrounding whitespace rather than sending it", async () => {
    const { client, calls } = fakeClient([{ data: {} }]);
    await handleTasks(client, "tasks_create_tasklist", { title: "  Q3 triage  " });
    expect(calls[0].jsonBody).toEqual({ title: "Q3 triage" });
  });

  it.each(["", "   ", "\t\n"])(
    "refuses the blank title %j without calling the API",
    async (title) => {
      // The failure direction, and the reason this check exists at all: the
      // live API answers 200 for a blank title and creates a list with no name,
      // which the caller reads as success and the user cannot find in the UI.
      // Both "" and "   " were accepted when tried against the real endpoint.
      const { client, calls } = fakeClient([{ data: { id: "should-not-happen" } }]);

      await expect(
        handleTasks(client, "tasks_create_tasklist", { title })
      ).rejects.toThrow(/must not be blank/i);

      expect(calls).toHaveLength(0);
    }
  );

  it("rejects a missing title at the schema boundary", () => {
    expect(() => validateArgs(tool("tasks_create_tasklist"), {})).toThrow(
      /missing required parameter "title"/
    );
  });

  it("is annotated as a create, not a destructive mutation", () => {
    // Adding a list cannot overwrite or remove anything that exists.
    expect(tool("tasks_create_tasklist").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });
});

describe("the Tasks surface deliberately has no delete-tasklist tool", () => {
  it("exposes no tool that can delete a task list", () => {
    // Deleting a task list takes every task inside it with no undo, so it is
    // not a surface this server hands to a model. The asymmetry with
    // tasks_create_tasklist is the intended shape; this pins it so that
    // "the CRUD looks incomplete" cannot quietly close it.
    const names = tasksTools.map((t) => t.name);
    expect(names).toContain("tasks_create_tasklist");
    expect(names.filter((n) => /tasklist/.test(n))).toEqual([
      "tasks_create_tasklist",
    ]);
  });
});
