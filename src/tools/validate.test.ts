import { describe, expect, it } from "vitest";
import { allTools } from "./index.js";
import type { ToolDef } from "./annotations.js";
import { validateArgs } from "./validate.js";

const tool = (name: string): ToolDef => {
  const found = allTools.find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
};

const failure = (name: string, args: Record<string, unknown>): string => {
  try {
    validateArgs(tool(name), args);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`expected ${name} to reject ${JSON.stringify(args)}`);
};

/**
 * The two failures SCRUM-121 reported, pinned by the shape of the message
 * rather than only by the fact of throwing. Both used to reach Google and come
 * back describing GOOGLE's state, which is what sent people looking in the
 * wrong place; a test that only asserted "it throws" would pass on a message
 * that made the same mistake.
 */
describe("SCRUM-121: the caller's mistake is named as the caller's", () => {
  it("sheets_rename_tab without title says so, instead of 'No sheet named undefined'", () => {
    const message = failure("sheets_rename_tab", {
      spreadsheet_id: "s",
      new_title: "Q4",
    });

    expect(message).toContain("sheets_rename_tab");
    expect(message).toContain("missing required");
    expect(message).toContain('"title"');
    // The old failure, and the reason this test pins the text.
    expect(message).not.toContain("No sheet named");
    expect(message).not.toContain("undefined");
  });

  it("docs_write with content instead of text names the typo and the accepted keys", () => {
    const message = failure("docs_write", {
      document_id: "d",
      content: "hello",
    });

    expect(message).toContain("docs_write");
    expect(message).toContain('"content"');
    // Naming what IS accepted is the half that makes it actionable.
    expect(message).toContain('"text"');
    expect(message).not.toContain("insertText");
  });
});

describe("validateArgs", () => {
  it("accepts a correct call", () => {
    expect(() =>
      validateArgs(tool("sheets_read"), { spreadsheet_id: "s", range: "A1:B2" })
    ).not.toThrow();
  });

  it("accepts a call that omits optional parameters", () => {
    expect(() =>
      validateArgs(tool("sheets_append"), { spreadsheet_id: "s", values: [["a"]] })
    ).not.toThrow();
  });

  it("treats null as missing rather than as a value", () => {
    // Letting null through recreates the original bug with a different word
    // in the error message.
    expect(failure("docs_write", { document_id: "d", text: null })).toContain(
      "missing required"
    );
  });

  it("rejects a wrong type, reporting what arrived", () => {
    const message = failure("sheets_update", {
      spreadsheet_id: "s",
      range: "A1",
      values: "a,b",
    });
    expect(message).toContain('"values"');
    expect(message).toContain("must be an array");
    expect(message).toContain("received a string");
  });

  it("rejects a value outside an enum, listing the legal ones", () => {
    const message = failure("sheets_read", {
      spreadsheet_id: "s",
      range: "A1",
      value_render_option: "FORMULAS",
    });
    expect(message).toContain('"value_render_option"');
    expect(message).toContain("FORMULA");
  });

  it("rejects a string shorter than minLength, naming the length and what arrived", () => {
    // `required` catches an absent name; only `minLength` catches "", which
    // Drive would otherwise accept and store as the file's name.
    const message = failure("drive_rename_file", { file_id: "f", name: "" });
    expect(message).toContain('"name"');
    expect(message).toContain("at least 1 character");
    expect(message).toContain('received a string ("")');
  });

  it("leaves minLength to the type check when the value is not a string", () => {
    // A number has no length; the message must be about the type, not the
    // length, or it describes the wrong problem.
    const message = failure("drive_rename_file", { file_id: "f", name: 7 });
    expect(message).toContain("must be a string");
    expect(message).not.toContain("at least");
  });

  it("reports every unknown parameter at once, not just the first", () => {
    const message = failure("docs_create", { title: "t", colour: "red", size: 3 });
    expect(message).toContain('"colour"');
    expect(message).toContain('"size"');
  });

  it("covers every registered tool without crashing on its schema", () => {
    // Cheap guard against a tool whose schema shape this validator cannot
    // read: a new tool is far likelier to arrive than this file is to be
    // revisited.
    for (const t of allTools) {
      expect(() => validateArgs(t, {})).not.toThrow(TypeError);
    }
  });
});
