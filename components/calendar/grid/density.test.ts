import { describe, expect, it } from "vitest";

import {
  byDate,
  MAX_CHIPS_PER_DAY,
  packDay,
  publishStateOf,
} from "@/components/calendar/grid/density";
import type { CalendarEvent } from "@/components/calendar/grid/types";

/** A publish event with everything but the interesting bits defaulted. */
function video(
  title: string,
  extra: Partial<Extract<CalendarEvent, { kind: "publish" }>> = {},
): CalendarEvent {
  return {
    kind: "publish",
    date: "2026-09-15",
    videoId: title,
    title,
    channelId: "c1",
    stageName: "Editing",
    state: "planned",
    ...extra,
  };
}

function filmingDay(id = "f1", videoCount = 3): CalendarEvent {
  return {
    kind: "filming",
    date: "2026-09-15",
    filmingDayId: id,
    notes: null,
    videoCount,
    tone: "quiet",
    headline: `${videoCount} videos to shoot.`,
    pending: videoCount,
  };
}

describe("packDay", () => {
  it("draws everything when everything fits", () => {
    const day = packDay([video("a"), video("b"), video("c")]);
    expect(day.shown).toHaveLength(3);
    expect(day.hidden).toBe(0);
  });

  it("never draws more than the ceiling, however many there are", () => {
    for (const count of [4, 5, 9, 40]) {
      const day = packDay(
        Array.from({ length: count }, (_, index) => video(`v${index}`)),
      );
      expect(day.shown.length).toBeLessThanOrEqual(MAX_CHIPS_PER_DAY);
      // The overflow line is itself a row, so a full cell draws one fewer chip.
      expect(day.shown).toHaveLength(MAX_CHIPS_PER_DAY - 1);
      expect(day.hidden).toBe(count - (MAX_CHIPS_PER_DAY - 1));
      expect(day.shown.length + day.hidden).toBe(count);
      expect(day.all).toHaveLength(count);
    }
  });

  it("keeps a filming day on screen even in a crowded cell", () => {
    const day = packDay([
      video("a"),
      video("b"),
      video("c"),
      video("d"),
      filmingDay(),
    ]);
    expect(day.shown[0].kind).toBe("filming");
    expect(day.hidden).toBe(3);
  });

  it("puts what is late first, then sorts by title", () => {
    const day = packDay([
      video("zebra", { state: "planned" }),
      video("apple", { state: "published" }),
      video("mango", { state: "late" }),
      video("beta", { state: "planned" }),
    ]);
    expect(day.all.map((event) => (event as { title: string }).title)).toEqual([
      "mango",
      "beta",
      "zebra",
      "apple",
    ]);
  });

  it("is empty for an empty day", () => {
    expect(packDay([])).toEqual({ shown: [], hidden: 0, all: [] });
  });
});

describe("byDate", () => {
  it("groups without losing anything", () => {
    const grouped = byDate([
      video("a", { date: "2026-09-01" }),
      video("b", { date: "2026-09-02" }),
      video("c", { date: "2026-09-01" }),
    ]);
    expect([...grouped.keys()].sort()).toEqual(["2026-09-01", "2026-09-02"]);
    expect(grouped.get("2026-09-01")).toHaveLength(2);
  });
});

describe("publishStateOf", () => {
  const today = "2026-09-15";

  it("calls a past date with nothing shipped late", () => {
    expect(
      publishStateOf({
        date: "2026-09-14",
        today,
        stageKind: "editing",
        publishedAt: null,
      }),
    ).toBe("late");
  });

  it("does not call today late", () => {
    expect(
      publishStateOf({
        date: today,
        today,
        stageKind: "editing",
        publishedAt: null,
      }),
    ).toBe("planned");
  });

  it("never calls a scheduled or published video late", () => {
    expect(
      publishStateOf({
        date: "2026-01-01",
        today,
        stageKind: "scheduled",
        publishedAt: null,
      }),
    ).toBe("scheduled");
    expect(
      publishStateOf({
        date: "2026-01-01",
        today,
        stageKind: "published",
        publishedAt: "2026-01-01T09:00:00Z",
      }),
    ).toBe("published");
    // Repurposed is past Published, and a video does not become late again.
    expect(
      publishStateOf({
        date: "2026-01-01",
        today,
        stageKind: "repurposed",
        publishedAt: "2026-01-01T09:00:00Z",
      }),
    ).toBe("published");
    // A stamp without the stage — the stamp is the fact.
    expect(
      publishStateOf({
        date: "2026-01-01",
        today,
        stageKind: "publish_prep",
        publishedAt: "2026-01-02T09:00:00Z",
      }),
    ).toBe("published");
  });

  it("calls a future date planned whatever stage it is in", () => {
    expect(
      publishStateOf({
        date: "2026-12-01",
        today,
        stageKind: "idea",
        publishedAt: null,
      }),
    ).toBe("planned");
  });
});
