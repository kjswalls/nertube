import { cache } from "react";

import type { FilmingDayDetail } from "@/components/calendar/grid/day-panel";
import type { NearestMonth } from "@/components/calendar/grid/empty-month";
import { publishStateOf } from "@/components/calendar/grid/density";
import { tagsFor } from "@/components/calendar/grid/channels";
import type {
  CalendarChannel,
  CalendarEvent,
} from "@/components/calendar/grid/types";
import {
  addDays,
  firstOfMonth,
  lastOfMonth,
  monthKey,
  monthOf,
  parseMonthKey,
  type DateColumn,
} from "@/lib/calendar-dates";
import { readPaged } from "@/lib/paged";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * Everything `/calendar` draws for one month, read in one place.
 *
 * ## Flat selects, no embeds
 *
 * `videos` has two foreign keys to `stages` — the tenant one and the channel
 * one — so a PostgREST embed cannot tell which is meant; the board found this
 * first and `lib/now-data.ts` documents it. Four flat selects with the joining
 * done in memory is both unambiguous and, at PLAN.md's sizing (one user,
 * hundreds of rows), faster than the alternative.
 *
 * ## Why the window is the month and not the visible grid
 *
 * The grid draws a few days of the months either side so that its weeks are
 * whole. Those cells deliberately carry **no events**, and this read is
 * deliberately bounded by the month rather than by the grid, for one reason:
 * every number on the page — the heading's summary, the sidebar's badge, "the
 * nearest month with anything in it" — counts the same set. A chip visible on
 * a trailing cell would be a video the grid showed and the heading did not
 * count, which is exactly the class of disagreement M5's reviewers spent a day
 * on.
 *
 * ## Archived videos are not here at all
 *
 * `archived_at` means "this should vanish from views without being deleted",
 * and a shelved video is not part of a publishing rhythm. The board already
 * filters the same way.
 */
export interface CalendarMonthData {
  readonly channels: readonly CalendarChannel[];
  /** Publish and filming events, all inside the month. */
  readonly events: readonly CalendarEvent[];
  /** Keyed by `filming_days.id`, for the day panel's expansion. */
  readonly filming: ReadonlyMap<string, FilmingDayDetail>;
  /** How many videos and how many filming days, for the heading. */
  readonly counts: { readonly videos: number; readonly filmingDays: number };
}

export async function readCalendarMonth(
  month: string,
  today: DateColumn,
): Promise<CalendarMonthData> {
  const parsed = parseMonthKey(month);
  if (parsed === null) {
    throw new Error(`${JSON.stringify(month)} is not a month.`);
  }
  const start = firstOfMonth(parsed);
  const end = lastOfMonth(parsed);

  const { supabase } = await requireUser();

  const { data: channelRows, error: channelsError } = await supabase
    .from("channels")
    .select("id, name, slug")
    // Creation order, the same order the sidebar numbers `1..9` in, so a
    // channel's tag and stripe do not move when another one is created.
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (channelsError) {
    throw new Error(`Could not load the channels: ${channelsError.message}`);
  }

  const channels = tagsFor(channelRows ?? []);

  const { data: stageRows, error: stagesError } = await supabase
    .from("stages")
    .select("id, name, kind");

  if (stagesError) {
    throw new Error(`Could not load the stages: ${stagesError.message}`);
  }

  const stages = new Map(
    (stageRows ?? []).map((stage) => [
      stage.id,
      { name: stage.name, kind: stage.kind },
    ]),
  );

  /*
    Paged rather than `.limit()`ed, for the reason `lib/paged.ts` exists: a
    `.limit()` above PostgREST's `db-max-rows` is not a bound, and a month that
    silently lost its last rows would be a calendar quietly missing a video.
    A month holds a handful of rows in practice; this costs one request.
  */
  const videoRows = await readPaged(`videos targeted at ${month}`, (from, to) =>
    supabase
      .from("videos")
      // prettier-ignore
      .select("id, title, channel_id, stage_id, target_publish_date, published_at")
      .gte("target_publish_date", start)
      .lte("target_publish_date", end)
      .is("archived_at", null)
      .order("target_publish_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );

  const events: CalendarEvent[] = [];
  for (const video of videoRows) {
    const date = video.target_publish_date;
    if (date === null) continue;
    const stage = video.stage_id ? stages.get(video.stage_id) : undefined;
    events.push({
      kind: "publish",
      date,
      videoId: video.id,
      title: video.title.trim() === "" ? "Untitled" : video.title,
      channelId: video.channel_id,
      stageName: stage?.name ?? null,
      state: publishStateOf({
        date,
        today,
        stageKind: stage?.kind ?? null,
        publishedAt: video.published_at,
      }),
    });
  }

  /*
    Filming days: user-level and cross-channel by design (one creator, one
    camera), so this is not scoped by channel and must not be.
  */
  const { data: filmingRows, error: filmingError } = await supabase
    .from("filming_days")
    .select("id, on_date, notes")
    .gte("on_date", start)
    .lte("on_date", end)
    .order("on_date", { ascending: true });

  if (filmingError) {
    throw new Error(`Could not load the filming days: ${filmingError.message}`);
  }

  const filming = new Map<string, FilmingDayDetail>();
  const filmingDays = filmingRows ?? [];

  if (filmingDays.length > 0) {
    /*
      The videos linked to those days, read by their *current* state.

      A video that has moved on from Filming keeps its link — `filming_day_id`
      is a fact about when it was shot, not about where it is now — so this
      deliberately does not filter by stage. PLAN.md's own M6 review item is
      "a filming day whose video left Filming still renders sanely": it renders
      with the stage it is in today beside it.
    */
    const linked = await readPaged(`videos linked to a filming day`, (from, to) =>
      supabase
        .from("videos")
        .select("id, title, channel_id, stage_id, filming_day_id")
        .in(
          "filming_day_id",
          filmingDays.map((day) => day.id),
        )
        .is("archived_at", null)
        .order("title", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to),
    );

    for (const day of filmingDays) {
      filming.set(day.id, {
        filmingDayId: day.id,
        notes: day.notes,
        videos: linked
          .filter((video) => video.filming_day_id === day.id)
          .map((video) => ({
            id: video.id,
            title: video.title.trim() === "" ? "Untitled" : video.title,
            channelId: video.channel_id,
            stageName: video.stage_id
              ? (stages.get(video.stage_id)?.name ?? null)
              : null,
          })),
      });
    }

    for (const day of filmingDays) {
      events.push({
        kind: "filming",
        date: day.on_date,
        filmingDayId: day.id,
        notes: day.notes,
        videoCount: filming.get(day.id)?.videos.length ?? 0,
      });
    }
  }

  return {
    channels,
    events,
    filming,
    counts: { videos: videoRows.length, filmingDays: filmingDays.length },
  };
}

/**
 * The nearest month either side of an empty one that has a target date in it.
 *
 * Two reads, and only when the month on screen is empty — the empty state is
 * the only thing that asks. One row each, ordered from the edge outwards, so
 * this is an index seek and not a scan of the account.
 */
export async function nearestMonths(month: string): Promise<{
  previous: NearestMonth | null;
  next: NearestMonth | null;
}> {
  const parsed = parseMonthKey(month);
  if (parsed === null) return { previous: null, next: null };

  const { supabase } = await requireUser();
  const before = addDays(firstOfMonth(parsed), -1);
  const after = addDays(lastOfMonth(parsed), 1);

  const [previous, next] = await Promise.all([
    before === null ? null : nearestIn(supabase, before, "before"),
    after === null ? null : nearestIn(supabase, after, "after"),
  ]);

  return { previous, next };
}

async function nearestIn(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  edge: DateColumn,
  direction: "before" | "after",
): Promise<NearestMonth | null> {
  const query = supabase
    .from("videos")
    .select("target_publish_date")
    .is("archived_at", null)
    .limit(1);

  const { data } =
    direction === "before"
      ? await query
          .lte("target_publish_date", edge)
          .order("target_publish_date", { ascending: false })
      : await query
          .gte("target_publish_date", edge)
          .order("target_publish_date", { ascending: true });

  const found = data?.[0]?.target_publish_date ?? null;
  if (found === null) return null;

  const parsed = monthOf(found);
  if (parsed === null) return null;
  const key = monthKey(parsed);

  const { count } = await supabase
    .from("videos")
    .select("id", { count: "exact", head: true })
    .gte("target_publish_date", firstOfMonth(parsed))
    .lte("target_publish_date", lastOfMonth(parsed))
    .is("archived_at", null);

  return { month: key, count: count ?? 0 };
}

/**
 * How many videos are going out in the month containing `now` — the number the
 * sidebar draws beside Calendar.
 *
 * ## Why this definition and not another
 *
 * The same argument `lib/ideas-data.ts` makes for the Ideas badge: the number
 * beside a link has to be a number the page it opens agrees with. `/calendar`
 * opens on the current month, and the first thing it says is how many videos
 * are targeted at it — so that is what this counts, over the same window
 * (`firstOfMonth`..`lastOfMonth` through the one date helper) and the same
 * exclusion (archived rows are not part of a rhythm).
 *
 * Filming days are deliberately *not* added in. They are a different event
 * type, counted separately on the page, and a badge that silently summed two
 * kinds would be a number with no name.
 *
 * `null`, never a throw and never a zero: `AppShell` renders on every signed-in
 * route, and a transient failure here must not take the board down with it.
 * Zero is a claim; `null` is the absence of one.
 */
export const countTargetsIn = cache(
  async (month: string): Promise<number | null> => {
    const parsed = parseMonthKey(month);
    if (parsed === null) return null;

    try {
      const { supabase } = await requireUser();
      const { count, error } = await supabase
        .from("videos")
        .select("id", { count: "exact", head: true })
        .gte("target_publish_date", firstOfMonth(parsed))
        .lte("target_publish_date", lastOfMonth(parsed))
        .is("archived_at", null);

      if (error) return null;
      return count ?? null;
    } catch {
      return null;
    }
  },
);
