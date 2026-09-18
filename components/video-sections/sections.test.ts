import { describe, expect, it } from "vitest";

import {
  DEFAULT_SECTION,
  parseSection,
  sectionHref,
  sectionReadiness,
  VIDEO_SECTIONS,
  type SectionFacts,
} from "./sections";

/**
 * The tabs' arithmetic, without a browser.
 *
 * What is worth pinning here is the part a screenshot cannot check: that a tab
 * never claims something the row does not say. A lock that appears on a video
 * which *has* reached the stage, or a 3/3 on a video with no chosen hook, is a
 * page lying quietly — and it is the kind of thing that survives a visual
 * review for months.
 */

const FRESH: SectionFacts = {
  stageKind: "idea",
  titleFilled: true,
  conceptFilled: false,
  chosenHooks: 0,
  packagingSkipped: false,
  scriptFilled: false,
  targetDateSet: false,
  published: false,
};

describe("parseSection", () => {
  it("reads every section it advertises", () => {
    for (const section of VIDEO_SECTIONS) {
      expect(parseSection(section.id)).toBe(section.id);
    }
  });

  it("falls back to the gate rather than failing", () => {
    expect(parseSection(undefined)).toBe(DEFAULT_SECTION);
    expect(parseSection("")).toBe(DEFAULT_SECTION);
    expect(parseSection("Script")).toBe(DEFAULT_SECTION);
    expect(parseSection("../etc/passwd")).toBe(DEFAULT_SECTION);
  });

  it("takes the first of a repeated parameter", () => {
    expect(parseSection(["script", "publish"])).toBe("script");
  });
});

describe("sectionHref", () => {
  it("leaves the default section as the bare URL", () => {
    expect(sectionHref("/videos/abc", DEFAULT_SECTION)).toBe("/videos/abc");
  });

  it("names every other one", () => {
    expect(sectionHref("/videos/abc", "script")).toBe("/videos/abc?section=script");
  });
});

describe("sectionReadiness", () => {
  it("counts the gate's three fields, and only those", () => {
    expect(sectionReadiness(FRESH).packaging).toMatchObject({
      kind: "ratio",
      done: 1,
      total: 3,
    });

    const all = sectionReadiness({
      ...FRESH,
      conceptFilled: true,
      chosenHooks: 1,
    });
    expect(all.packaging.kind).toBe("done");
  });

  it("does not count two chosen hooks as one", () => {
    // `move_video` refuses anything but exactly one, so a tab reading 3/3 here
    // would promise a move the database is about to refuse.
    const two = sectionReadiness({
      ...FRESH,
      conceptFilled: true,
      chosenHooks: 2,
    });
    expect(two.packaging).toMatchObject({ kind: "ratio", done: 2, total: 3 });
  });

  it("says nothing loud about a deliberately skipped gate", () => {
    const skipped = sectionReadiness({ ...FRESH, packagingSkipped: true });
    expect(skipped.packaging.kind).toBe("quiet");
  });

  it("locks the script until the video has reached Scripting", () => {
    expect(sectionReadiness(FRESH).script.kind).toBe("locked");
    expect(sectionReadiness({ ...FRESH, stageKind: "packaging" }).script.kind).toBe(
      "locked",
    );
    expect(sectionReadiness({ ...FRESH, stageKind: "scripting" }).script.kind).toBe(
      "quiet",
    );
    expect(
      sectionReadiness({ ...FRESH, stageKind: "editing", scriptFilled: true }).script
        .kind,
    ).toBe("done");
  });

  it("never locks a tab on a video sitting in an inert stage", () => {
    // A user-added stage has `kind = null` and no place in `CORE_KIND_ORDER`,
    // so nothing can be said about what it has passed. Saying it anyway would
    // be a guess dressed as a fact.
    const inert = sectionReadiness({ ...FRESH, stageKind: null });
    expect(inert.script.kind).not.toBe("locked");
  });

  it("keeps Thumbnails and Publish locked while they are not built", () => {
    const late = sectionReadiness({
      ...FRESH,
      stageKind: "published",
      published: true,
    });
    expect(late.thumbnails.kind).toBe("locked");
    expect(late.publish.kind).toBe("locked");
    // And the lock says which milestone, not just "no".
    expect(late.thumbnails.why).toContain("M4");
    expect(late.publish.why).toContain("M4");
  });

  it("ticks Schedule once a target date exists", () => {
    expect(sectionReadiness(FRESH).schedule.kind).toBe("quiet");
    expect(sectionReadiness({ ...FRESH, targetDateSet: true }).schedule.kind).toBe(
      "done",
    );
  });

  it("has an answer for every tab it renders", () => {
    const readiness = sectionReadiness(FRESH);
    for (const section of VIDEO_SECTIONS) {
      expect(readiness[section.id].why).toBeTruthy();
    }
  });
});
