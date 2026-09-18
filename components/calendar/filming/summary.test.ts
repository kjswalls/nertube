import { describe, expect, it } from "vitest";

import { statusOf, summarise, type DayVideo } from "./summary";

/**
 * The rule that keeps a past filming day truthful.
 *
 * The case worth naming, because it is the one PLAN.md's M6 review note is
 * about: a video linked to Saturday's shoot is in Editing by Sunday. Nothing
 * has gone wrong, the day did its job, and the day has to say so — not "1 to
 * shoot" for ever, and not nothing at all.
 */

const video = (
  stageKind: DayVideo["stageKind"],
  archived = false,
): DayVideo => ({ stageKind, archived });

describe("statusOf", () => {
  it("reads the stage against Filming, not against the board's order", () => {
    expect(statusOf(video("filming"))).toBe("to_shoot");
    expect(statusOf(video("editing"))).toBe("moved_on");
    expect(statusOf(video("published"))).toBe("moved_on");
    expect(statusOf(video("scripting"))).toBe("not_ready");
    expect(statusOf(video("idea"))).toBe("not_ready");
  });

  it("puts archived first, whatever stage the row still names", () => {
    expect(statusOf(video("filming", true))).toBe("archived");
    expect(statusOf(video("published", true))).toBe("archived");
  });

  it("does not guess about a custom stage", () => {
    // A stage added in settings (M7) has `kind = null` and is inert.
    expect(statusOf(video(null))).toBe("elsewhere");
  });
});

describe("summarise", () => {
  const today = "2026-03-14";

  it("counts an upcoming day by what it is for", () => {
    const summary = summarise([video("filming"), video("filming")], {
      onDate: "2026-03-21",
      today,
    });
    expect(summary).toMatchObject({
      total: 2,
      toShoot: 2,
      movedOn: 0,
      past: false,
      tone: "quiet",
    });
    expect(summary.headline).toBe("2 videos to shoot.");
  });

  it("says a day with nothing on it has nothing on it", () => {
    expect(summarise([], { onDate: "2026-03-21", today }).headline).toBe(
      "No videos attached yet.",
    );
    expect(summarise([], { onDate: "2026-03-07", today }).headline).toBe(
      "No videos were attached to this day.",
    );
  });

  it("reports a past day whose videos moved on as done, quietly", () => {
    const summary = summarise([video("editing"), video("publish_prep")], {
      onDate: "2026-03-07",
      today,
    });
    expect(summary).toMatchObject({ total: 2, movedOn: 2, past: true });
    expect(summary.headline).toBe("2 videos, filmed and moved on.");
    // The normal end state of every shoot: no colour, nothing to decide.
    expect(summary.tone).toBe("quiet");
  });

  it("asks about a past day whose videos never left Filming", () => {
    const summary = summarise([video("filming"), video("filming")], {
      onDate: "2026-03-07",
      today,
    });
    expect(summary.headline).toBe(
      "2 videos still waiting to be filmed. Did this day happen?",
    );
    // The one state on the calendar that is asking for a decision.
    expect(summary.tone).toBe("attention");
  });

  it("splits a past day that half happened", () => {
    const summary = summarise(
      [video("editing"), video("filming"), video("published")],
      { onDate: "2026-03-07", today },
    );
    expect(summary.headline).toBe(
      "2 of 3 moved on; 1 still waiting to be filmed.",
    );
    expect(summary.tone).toBe("attention");
  });

  it("counts a video that went backwards as still waiting", () => {
    // Scripting after the shoot: it is not filmed, whatever the day says.
    const summary = summarise([video("scripting")], {
      onDate: "2026-03-07",
      today,
    });
    expect(summary).toMatchObject({ notReady: 1, toShoot: 0, tone: "attention" });
  });

  it("keeps an archived video on the day and says so", () => {
    const summary = summarise([video("editing", true), video("filming")], {
      onDate: "2026-03-21",
      today,
    });
    expect(summary).toMatchObject({ archived: 1, toShoot: 1 });
    expect(summary.headline).toBe("2 videos: 1 to shoot, 1 archived.");

    const allGone = summarise([video("published", true)], {
      onDate: "2026-03-07",
      today,
    });
    expect(allGone.headline).toBe("1 video, since archived.");
    expect(allGone.tone).toBe("quiet");
  });

  it("treats today as not past", () => {
    // The day of the shoot itself must not nag about not having happened.
    const summary = summarise([video("filming")], { onDate: today, today });
    expect(summary.past).toBe(false);
    expect(summary.tone).toBe("quiet");
    expect(summary.headline).toBe("1 video to shoot.");
  });

  it("compares dates as calendar days, across a month end", () => {
    expect(
      summarise([video("filming")], { onDate: "2026-02-28", today: "2026-03-01" })
        .past,
    ).toBe(true);
    expect(
      summarise([video("filming")], { onDate: "2026-03-01", today: "2026-02-28" })
        .past,
    ).toBe(false);
  });

  it("lists a mixed upcoming day in the order the words are read", () => {
    const summary = summarise(
      [video("filming"), video("scripting"), video("editing")],
      { onDate: "2026-03-21", today },
    );
    expect(summary.headline).toBe(
      "3 videos: 1 to shoot, 1 not ready yet, 1 already moved on.",
    );
    expect(summary.tone).toBe("quiet");
  });
});
