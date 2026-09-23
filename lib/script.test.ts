import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SCRIPT_TEMPLATE } from "./defaults";
import {
  buildScriptFromTemplate,
  chosenHookText,
  countWords,
  isScriptStructure,
  MAX_END_SCREEN_TARGET_LENGTH,
  MAX_SCRIPT_LENGTH,
  SCRIPT_STRUCTURES,
  scriptForColumn,
  scriptIsEditable,
} from "./script";
import { VideoPatchSchema } from "./video-fields";

/**
 * The script's pure half (M10): the column form, the template build that must
 * agree with `move_video`, the stage rule, and the patch vocabulary's three
 * new keys. The browser suite (`e2e/script-editor.spec.ts`) proves the build
 * against Postgres itself; this pins the cases a browser cannot reach cheaply.
 */

const VIDEO = "00000000-0000-4000-8000-000000000001";

const hook = (text: string, chosen: unknown, id = text || "h") => ({ id, text, chosen });

describe("buildScriptFromTemplate — what move_video writes", () => {
  it("splices the chosen hook into the seeded template", () => {
    const built = buildScriptFromTemplate(SCRIPT_TEMPLATE, [
      hook("Not this one", false, "a"),
      hook("You are sleeping wrong.", true, "b"),
    ]);
    expect(built).toBe(SCRIPT_TEMPLATE.replace("{{hook}}", "You are sleeping wrong."));
    expect(built.startsWith("## Hook (verbatim)\n\nYou are sleeping wrong.\n")).toBe(true);
    // The template's trailing newline is part of what move_video writes.
    expect(built.endsWith("\n")).toBe(true);
  });

  it("writes an empty Hook section when no hook is chosen — coalesce(…, '')", () => {
    expect(buildScriptFromTemplate("A {{hook}} B", [hook("x", false)])).toBe("A  B");
    expect(buildScriptFromTemplate("A {{hook}} B", [])).toBe("A  B");
    expect(buildScriptFromTemplate("A {{hook}} B", null)).toBe("A  B");
    expect(buildScriptFromTemplate("A {{hook}} B", "not a list")).toBe("A  B");
  });

  it("replaces every placeholder, like Postgres replace()", () => {
    expect(buildScriptFromTemplate("{{hook}}\n---\n{{hook}}", [hook("Hi", true)])).toBe(
      "Hi\n---\nHi",
    );
  });

  it("treats the hook as plain text — no $& or $1 patterns", () => {
    // `String.replaceAll` with a string replacement would expand these.
    const text = "Make $$$ from $& and $1 in $' a week";
    expect(buildScriptFromTemplate("> {{hook}} <", [hook(text, true)])).toBe(
      `> ${text} <`,
    );
  });

  it("leaves a template with no placeholder as it is", () => {
    expect(buildScriptFromTemplate("Just my shape.\n", [hook("Hi", true)])).toBe(
      "Just my shape.\n",
    );
  });

  it("takes the first chosen hook in array order, as `limit 1` does", () => {
    // The app never saves two chosen hooks (zod refuses it), but the SQL has an
    // answer for a hand-written row and this must give the same one.
    expect(
      chosenHookText([hook("one", false, "a"), hook("two", true, "b"), hook("three", true, "c")]),
    ).toBe("two");
  });

  it("reads `chosen` with Postgres' boolean input rules", () => {
    expect(chosenHookText([hook("yes", "y")])).toBe("yes");
    expect(chosenHookText([hook("t", " TRUE ")])).toBe("t");
    expect(chosenHookText([hook("one", 1)])).toBe("one");
    expect(chosenHookText([hook("no", "no"), hook("zero", 0)])).toBeNull();
  });

  it("skips entries that are not objects, as `->>` does", () => {
    expect(chosenHookText(["loose string", 7, hook("real", true)])).toBe("real");
  });
});

describe("scriptForColumn — stored as written", () => {
  it("keeps whitespace, including the trailing newline being typed", () => {
    expect(scriptForColumn("  Line one\n\n")).toBe("  Line one\n\n");
  });

  it("is null when nothing would draw", () => {
    expect(scriptForColumn("")).toBeNull();
    expect(scriptForColumn(" \n\t\n")).toBeNull();
    expect(scriptForColumn("​\n")).toBeNull();
    expect(scriptForColumn(null)).toBeNull();
  });

  it("removes only U+0000, which Postgres refuses", () => {
    expect(scriptForColumn("a\u0000b‍c")).toBe("ab‍c");
  });
});

describe("scriptIsEditable — from Scripting onward", () => {
  it("is closed before Scripting and open from it", () => {
    expect(scriptIsEditable("idea")).toBe(false);
    expect(scriptIsEditable("packaging")).toBe(false);
    for (const kind of [
      "scripting",
      "filming",
      "editing",
      "publish_prep",
      "scheduled",
      "published",
      "repurposed",
    ] as const) {
      expect(scriptIsEditable(kind), kind).toBe(true);
    }
  });

  it("stays open on an inert stage, which has no place in the order", () => {
    expect(scriptIsEditable(null)).toBe(true);
  });
});

describe("the patch vocabulary's script keys", () => {
  const parse = (fields: Record<string, unknown>) =>
    VideoPatchSchema.safeParse({ videoId: VIDEO, ...fields });

  it("sends the script untrimmed, and blank as null", () => {
    const kept = parse({ script: "## Hook\n\nWord for word.\n" });
    expect(kept.success && kept.data.script).toBe("## Hook\n\nWord for word.\n");

    const blank = parse({ script: "   \n" });
    expect(blank.success).toBe(true);
    expect(blank.success && blank.data.script).toBeNull();

    const cleared = parse({ script: null });
    expect(cleared.success && cleared.data.script).toBeNull();
  });

  it("caps the script generously and says so", () => {
    expect(parse({ script: "x".repeat(MAX_SCRIPT_LENGTH) }).success).toBe(true);
    const over = parse({ script: "x".repeat(MAX_SCRIPT_LENGTH + 1) });
    expect(over.success).toBe(false);
    expect(!over.success && over.error.issues[0].message).toMatch(/capped at 100,000/);
    // Long enough for a long script: a 3,000-word script is ~18k characters.
    expect(MAX_SCRIPT_LENGTH).toBeGreaterThanOrEqual(50_000);
  });

  it("takes the three structures, and '' or null as not chosen", () => {
    for (const structure of SCRIPT_STRUCTURES) {
      const parsed = parse({ scriptStructure: structure });
      expect(parsed.success && parsed.data.scriptStructure).toBe(structure);
    }
    const unset = parse({ scriptStructure: "" });
    expect(unset.success && unset.data.scriptStructure).toBeNull();
    const cleared = parse({ scriptStructure: null });
    expect(cleared.success && cleared.data.scriptStructure).toBeNull();
    expect(parse({ scriptStructure: "five_act" }).success).toBe(false);
    expect(isScriptStructure("three_part")).toBe(true);
    expect(isScriptStructure("3-part")).toBe(false);
  });

  it("holds the same three structures as the database's CHECK", () => {
    const sql = readFileSync("supabase/migrations/0001_init.sql", "utf8");
    const check = /script_structure text check \(script_structure in \(([^)]*)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    const values = check![1].split(",").map((value) => value.trim().replace(/'/g, ""));
    expect(values).toEqual([...SCRIPT_STRUCTURES]);
  });

  it("trims the end-screen target like every one-line field, and caps it", () => {
    const parsed = parse({ endScreenTarget: "  How I sleep 9 hours  " });
    expect(parsed.success && parsed.data.endScreenTarget).toBe("How I sleep 9 hours");
    const blank = parse({ endScreenTarget: "  " });
    expect(blank.success && blank.data.endScreenTarget).toBeNull();
    expect(
      parse({ endScreenTarget: "x".repeat(MAX_END_SCREEN_TARGET_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it("counts a script-only patch as a patch", () => {
    expect(parse({ endScreenTarget: null }).success).toBe(true);
    expect(parse({}).success).toBe(false);
  });
});

describe("countWords", () => {
  it("counts words, not markdown punctuation", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("## Hook (verbatim)\n\n-\n- one two\n→ [named video]")).toBe(6);
  });
});
