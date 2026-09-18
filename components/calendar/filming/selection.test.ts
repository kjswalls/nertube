import { describe, expect, it } from "vitest";

import { defaultSelection } from "./selection";
import { MAX_FILMING_DAY_VIDEOS, type FilmingCandidate } from "./types";

/**
 * The rule that decides what one press of "Schedule the day" does.
 *
 * It is unit-tested rather than left to the browser suite because the failure
 * it guards against is silent data loss: a ticked video that is already on a
 * filming day is re-pointed at the new one, and the shoot it came off is left
 * empty with nothing on any screen saying so.
 */

function candidate(
  id: string,
  filmingDayId: string | null = null,
): FilmingCandidate {
  return {
    id,
    title: id,
    channelId: "channel",
    channelName: "Channel",
    channelSlug: "channel",
    stageKind: "filming",
    stageName: "Filming",
    archived: false,
    targetPublishDate: null,
    targetPublishLabel: null,
    filmingDayId,
    filmingDayLabel: filmingDayId === null ? null : "Sat 1 May",
  };
}

describe("defaultSelection", () => {
  it("ticks everything that is waiting for a camera", () => {
    const selected = defaultSelection([
      candidate("a"),
      candidate("b"),
      candidate("c"),
    ]);
    expect([...selected].sort()).toEqual(["a", "b", "c"]);
  });

  it("leaves a video that is already on a day unticked", () => {
    const selected = defaultSelection([
      candidate("unbooked"),
      candidate("booked", "day-1"),
    ]);
    expect(selected.has("unbooked")).toBe(true);
    expect(selected.has("booked")).toBe(false);
  });

  it("ticks nothing at all when every candidate is already booked", () => {
    // The state the board's badge reaches you in after you have just booked
    // them: it keeps counting the pile, so pressing it again is the obvious
    // next action, and the obvious next action must move nothing.
    const selected = defaultSelection([
      candidate("a", "day-1"),
      candidate("b", "day-1"),
      candidate("c", "day-2"),
    ]);
    expect(selected.size).toBe(0);
  });

  it("never ticks more than the server will accept", () => {
    const many = Array.from({ length: MAX_FILMING_DAY_VIDEOS + 7 }, (_, index) =>
      candidate(`v${index}`),
    );
    const selected = defaultSelection(many);
    expect(selected.size).toBe(MAX_FILMING_DAY_VIDEOS);
    // The first N of the list, which is ordered by title — the same N on every
    // render rather than an arbitrary subset.
    expect(selected.has("v0")).toBe(true);
    expect(selected.has(`v${MAX_FILMING_DAY_VIDEOS}`)).toBe(false);
  });

  it("counts only the unbooked ones towards the cap", () => {
    const booked = Array.from({ length: 30 }, (_, index) =>
      candidate(`b${index}`, "day-1"),
    );
    const waiting = Array.from({ length: 30 }, (_, index) =>
      candidate(`w${index}`),
    );
    expect(defaultSelection([...booked, ...waiting]).size).toBe(30);
  });

  it("has nothing to tick when nothing is in Filming", () => {
    expect(defaultSelection([]).size).toBe(0);
  });
});
