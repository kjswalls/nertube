import { describe, expect, it } from "vitest";

import { BucketNameSchema, bucketNameTaken } from "./bucket-settings";
import { ScriptTemplateSchema, VoiceGuideSchema } from "./channel-settings";
import { ChecklistItemTextSchema } from "./checklist";
import { nameTaken } from "./ordering";
import { StageNameSchema } from "./stage-settings";
import { cleanLabel, cleanProse, isBlank, sameLabel, stripInvisible } from "./text";

/**
 * The review sent a zero-width space through every "needs a name" rule and
 * every one accepted it. These pin the one helper and the four schemas that
 * import it, with the same probes the SQL suite fires at `has_visible_text()`.
 */

const INVISIBLE = ["​", "﻿", "⁠", "​​", "  ​  ", " ﻿"];

describe("lib/text", () => {
  it("strips the format characters that draw nothing, and the NUL byte", () => {
    expect(stripInvisible("Mo​ney")).toBe("Money");
    expect(stripInvisible("﻿x⁠y\u0000")).toBe("xy");
    expect(cleanLabel("  Money​  ")).toBe("Money");
  });

  it("calls a text blank when nothing in it would draw", () => {
    for (const probe of INVISIBLE) expect(isBlank(probe)).toBe(true);
    expect(isBlank("")).toBe(true);
    expect(isBlank("   \n\t")).toBe(true);
    expect(isBlank("x")).toBe(false);
    expect(isBlank("​x")).toBe(false);
  });

  it("compares labels as they read", () => {
    expect(sameLabel("Money", "money​")).toBe(true);
    expect(sameLabel(" MONEY ", "money")).toBe(true);
    expect(sameLabel("Money", "Monei")).toBe(false);
  });

  it("leaves prose alone except for the NUL byte", () => {
    const guide = "Warm.‍\n\n  - short sentences­\n";
    expect(cleanProse(guide)).toBe(guide);
    expect(cleanProse("vo\u0000ice")).toBe("voice");
    // A lone surrogate becomes U+FFFD, which is what the database stores for
    // it; a real pair is untouched (M10 review).
    expect(cleanProse("Lone \uD83D surrogate")).toBe("Lone \uFFFD surrogate");
    expect(cleanProse("tail \uDE00")).toBe("tail \uFFFD");
    expect(cleanProse("pair \uD83D\uDE00 ok")).toBe("pair \uD83D\uDE00 ok");
  });
});

describe("the four schemas", () => {
  it("refuse an invisible stage name, and store a visible one without its ghosts", () => {
    for (const probe of INVISIBLE) expect(StageNameSchema.safeParse(probe).success).toBe(false);
    expect(StageNameSchema.parse("Filming​")).toBe("Filming");
    expect(StageNameSchema.safeParse("Scr\u0000ipting").success).toBe(true);
    expect(StageNameSchema.parse("Scr\u0000ipting")).toBe("Scripting");
  });

  it("refuse an invisible bucket name, and see through one to its twin", () => {
    for (const probe of INVISIBLE) expect(BucketNameSchema.safeParse(probe).success).toBe(false);
    expect(BucketNameSchema.parse("Money​")).toBe("Money");
    expect(bucketNameTaken("Money​", [{ name: "Money" }])).toBe(true);
    expect(nameTaken("﻿editing", [{ name: "Editing" }])).toBe(true);
  });

  it("refuse an invisible checklist row", () => {
    for (const probe of INVISIBLE) expect(ChecklistItemTextSchema.safeParse(probe).success).toBe(false);
    expect(ChecklistItemTextSchema.parse("Ti\u0000tle​")).toBe("Title");
  });

  it("refuse an invisible script template, read an invisible voice guide as none, and keep real prose intact", () => {
    for (const probe of INVISIBLE) {
      expect(ScriptTemplateSchema.safeParse(probe).success).toBe(false);
      expect(VoiceGuideSchema.parse(probe)).toBeNull();
    }
    // A joiner inside the text is content, not a ghost: kept.
    expect(ScriptTemplateSchema.parse("## Hook 👨‍👩‍👧\n")).toBe("## Hook 👨‍👩‍👧");
    expect(VoiceGuideSchema.parse("vo\u0000ice")).toBe("voice");
  });
});
