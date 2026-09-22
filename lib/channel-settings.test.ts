import { describe, expect, it } from "vitest";

import {
  ExpectedCtrSchema,
  HOOK_PLACEHOLDER,
  MAX_STALE_DAYS,
  MAX_WIP_THRESHOLD,
  SETTING_NOTES,
  ScriptTemplateSchema,
  VoiceGuideSchema,
  hasHookPlaceholder,
  numberText,
  parseExpectedCtr,
  parseStaleDays,
  parseWipThreshold,
  settingNotes,
} from "./channel-settings";
import { SCRIPT_TEMPLATE } from "./defaults";
import { EXPECTATION_SAMPLE, MIN_MEDIAN_SAMPLE } from "./next-action";

describe("the two texts", () => {
  it("keeps a paragraph's newlines and indentation, and only trims the end", () => {
    const guide = "Direct.\n\n  - never 'in this video'\n  - short sentences\n\nWarm, not chummy.\n\n";
    expect(VoiceGuideSchema.parse(guide)).toBe(
      "Direct.\n\n  - never 'in this video'\n  - short sentences\n\nWarm, not chummy.",
    );
    expect(ScriptTemplateSchema.parse(SCRIPT_TEMPLATE)).toBe(SCRIPT_TEMPLATE.replace(/\s+$/, ""));
  });

  it("normalises Windows line endings so a round trip is byte-stable", () => {
    expect(VoiceGuideSchema.parse("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("reads an empty voice guide as null, and refuses an empty script template", () => {
    expect(VoiceGuideSchema.parse("")).toBeNull();
    expect(VoiceGuideSchema.parse("  \n ")).toBeNull();
    const blank = ScriptTemplateSchema.safeParse("  \n\n ");
    expect(blank.success).toBe(false);
    if (!blank.success) expect(blank.error.issues[0].message).toMatch(/cannot be empty/);
  });

  it("knows whether the hook placeholder is present, which is a warning not a rule", () => {
    expect(HOOK_PLACEHOLDER).toBe("{{hook}}");
    expect(hasHookPlaceholder(SCRIPT_TEMPLATE)).toBe(true);
    expect(hasHookPlaceholder("## Hook\n\n## Body")).toBe(false);
    // Allowed: the template is the user's own shape.
    expect(ScriptTemplateSchema.safeParse("## Body only").success).toBe(true);
  });
});

describe("the three numbers", () => {
  it("wip threshold: whole videos, one or more", () => {
    expect(parseWipThreshold("5")).toEqual({ ok: true, value: 5 });
    expect(parseWipThreshold(" 1 ")).toEqual({ ok: true, value: 1 });
    expect(parseWipThreshold("0").ok).toBe(false);
    expect(parseWipThreshold("-3").ok).toBe(false);
    expect(parseWipThreshold("2.5").ok).toBe(false);
    expect(parseWipThreshold("").ok).toBe(false);
    expect(parseWipThreshold(String(MAX_WIP_THRESHOLD + 1)).ok).toBe(false);
  });

  it("stale days: whole days, one to a year", () => {
    expect(parseStaleDays("7")).toEqual({ ok: true, value: 7 });
    expect(parseStaleDays("0").ok).toBe(false);
    expect(parseStaleDays(String(MAX_STALE_DAYS)).ok).toBe(true);
    expect(parseStaleDays(String(MAX_STALE_DAYS + 1)).ok).toBe(false);
    expect(parseStaleDays("").ok).toBe(false);
  });

  it("expected CTR: a percentage to two decimals, empty for the median, never zero", () => {
    expect(parseExpectedCtr("")).toEqual({ ok: true, value: null });
    expect(parseExpectedCtr("4.5")).toEqual({ ok: true, value: 4.5 });
    expect(parseExpectedCtr("4.5%")).toEqual({ ok: true, value: 4.5 });
    expect(parseExpectedCtr("4.567")).toEqual({ ok: true, value: 4.57 });
    expect(parseExpectedCtr("100")).toEqual({ ok: true, value: 100 });
    expect(parseExpectedCtr("100.01").ok).toBe(false);
    const zero = parseExpectedCtr("0");
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error).toMatch(/never be missed/);
    expect(parseExpectedCtr("-1").ok).toBe(false);
    expect(parseExpectedCtr("four").ok).toBe(false);
    expect(ExpectedCtrSchema.parse(0.01)).toBe(0.01);
  });

  it("prints a number plainly and null as nothing", () => {
    expect(numberText(4.5)).toBe("4.5");
    expect(numberText(7)).toBe("7");
    expect(numberText(null)).toBe("");
  });
});

describe("the notes", () => {
  it("name the channel's own stages, and fall back to the seed's words", () => {
    const renamed = settingNotes({ scripting: "Draft", packaging: "Grue", scheduled: "Queued" });
    expect(renamed.scriptTemplate).toContain("enters Draft");
    expect(renamed.scriptTemplate).toContain("past Draft");
    expect(renamed.wipThreshold).toContain("Grue through Queued");
    expect(renamed.wipThreshold).toContain("Idea, Published and Repurposed never warn");
    expect(SETTING_NOTES.scriptTemplate).toContain("enters Scripting");
    expect(SETTING_NOTES.wipThreshold).toContain("Packaging through Scheduled");
  });

  it("quote the sample sizes the swap prompt actually uses", () => {
    expect(SETTING_NOTES.expectedCtr).toContain(`last ${EXPECTATION_SAMPLE} published`);
    expect(SETTING_NOTES.expectedCtr).toContain(`at least ${MIN_MEDIAN_SAMPLE}`);
    expect(SETTING_NOTES.scriptTemplate).toContain(HOOK_PLACEHOLDER);
    expect(SETTING_NOTES.wipThreshold).toMatch(/Packaging through Scheduled/);
    expect(SETTING_NOTES.voiceGuide).toMatch(/M8/);
  });
});
