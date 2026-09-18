import { compareDateColumns } from "@/lib/calendar-dates";
import type {
  CalendarEvent,
  PublishEvent,
  PublishState,
} from "@/components/calendar/grid/types";

/**
 * How many events one day cell may draw, and what happens to the rest.
 *
 * ## The rule, and why it is this one
 *
 * A month grid has a fixed amount of vertical space per row, and a week in
 * which one day holds nine videos must not make that week nine rows tall — the
 * point of a calendar is the shape of the month, and a cell that grows without
 * limit destroys it. Every serious calendar solves this the same way and so
 * does this one:
 *
 * - **Three chips is the ceiling.** Three fits in a cell at the row height the
 *   grid wants without the month needing a scrollbar.
 * - **When there are more than three, only two are drawn**, and the third line
 *   becomes "+N more". Drawing three *and* a link would make the busy cell
 *   taller than the ceiling it was supposed to respect, which is the bug this
 *   rule exists to prevent.
 * - The link is a real link to `?day=`, so the hidden events are reachable by
 *   keyboard, reachable without JavaScript, and linkable on their own.
 *
 * ## The order
 *
 * A filming day first, then videos. A filming day is the block of time the
 * whole day is *about* (BRIEF.md principle 4), so it is never the thing that
 * gets hidden behind "+2 more": if it is on the day, it is on screen. Videos
 * then sort by state — late first, because that is the one thing on this page
 * that needs attention — and by title within that, so the order is stable
 * between renders and between the grid and the day panel.
 */
export const MAX_CHIPS_PER_DAY = 3;

export interface PackedDay {
  /** What the cell draws, in order. Never longer than `MAX_CHIPS_PER_DAY`. */
  readonly shown: readonly CalendarEvent[];
  /** How many are not drawn. `0` when everything fits. */
  readonly hidden: number;
  /** Everything on the day, ordered — what the day panel lists. */
  readonly all: readonly CalendarEvent[];
}

export function packDay(events: readonly CalendarEvent[]): PackedDay {
  const all = [...events].sort(compareEvents);
  if (all.length <= MAX_CHIPS_PER_DAY) {
    return { shown: all, hidden: 0, all };
  }
  const shown = all.slice(0, MAX_CHIPS_PER_DAY - 1);
  return { shown, hidden: all.length - shown.length, all };
}

/** Group events by the date column they fall on. */
export function byDate(
  events: readonly CalendarEvent[],
): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const day = map.get(event.date);
    if (day) day.push(event);
    else map.set(event.date, [event]);
  }
  return map;
}

/** Late first, then the rest of the pipeline, then what is already done. */
const STATE_ORDER: Record<PublishState, number> = {
  late: 0,
  planned: 1,
  scheduled: 2,
  published: 3,
};

function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  if (a.kind !== b.kind) return a.kind === "filming" ? -1 : 1;
  if (a.kind === "filming" || b.kind === "filming") {
    return compareDateColumns(a.date, b.date);
  }

  const left = a as PublishEvent;
  const right = b as PublishEvent;
  const byState = STATE_ORDER[left.state] - STATE_ORDER[right.state];
  if (byState !== 0) return byState;
  return left.title.localeCompare(right.title, "en-GB");
}

/**
 * Which state a video is in relative to its own target date.
 *
 * Pure, and given "today" rather than reading the clock, so it can be tested on
 * both sides of a date and so the whole page agrees about what today is.
 *
 * "Late" is deliberately narrow: a date in the past with the video neither
 * scheduled nor live. A *scheduled* video whose date has passed is not late —
 * YouTube published it and `/now` is already asking the owner to confirm the
 * URL — and a published one certainly is not. Everything else ahead of its date
 * is simply planned; how far along it is, is what the stage name beside it
 * says.
 */
export function publishStateOf({
  date,
  today,
  stageKind,
  publishedAt,
}: {
  date: string;
  today: string;
  stageKind: string | null;
  publishedAt: string | null;
}): PublishState {
  if (stageKind === "published" || stageKind === "repurposed") return "published";
  if (publishedAt !== null) return "published";
  if (stageKind === "scheduled") return "scheduled";
  return compareDateColumns(date, today) < 0 ? "late" : "planned";
}
