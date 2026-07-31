import { describe, expect, it } from "vitest";
import { allTools } from "./index.js";

describe("tool annotations", () => {
  it("every registered tool has a human-readable title", () => {
    for (const tool of allTools) {
      expect(tool.annotations?.title, `${tool.name} is missing a title`).toBeTruthy();
    }
  });

  // Pure creation: these add something new and cannot destroy or overwrite
  // existing state, so they must not carry destructiveHint.
  it.each([
    "calendar_create_event",
    "contacts_create",
    "docs_create",
    "drive_create_folder",
    "slides_create",
    "tasks_create",
    "sheets_append",
  ])("%s is not destructive", (name) => {
    const tool = allTools.find((t) => t.name === name);
    expect(tool?.annotations?.destructiveHint).toBe(false);
  });

  it("gws_auth_setup is not read-only: login triggers OAuth and writes credentials", () => {
    const tool = allTools.find((t) => t.name === "gws_auth_setup");
    expect(tool?.annotations?.readOnlyHint).toBe(false);
  });
});
