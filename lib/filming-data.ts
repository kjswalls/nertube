import { cache } from "react";

import type { StageKind } from "@/lib/defaults";
import { isStageKind } from "@/lib/defaults";
import { compareDateColumns } from "@/lib/calendar-dates";
import { readPaged } from "@/lib/paged";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * Reading filming days, and reading what is sitting in Filming.
 *
 * Two questions, one file, because they are the same question asked from two
 * ends: *what is waiting for a block of time*, and *which blocks of time have
 * been booked*. The board asks the first to decide whether to show its badge,
 * the calendar asks both, and the video page asks a narrow version of the
 * second. Answering them in one place is what stops the badge counting one set
 * of videos and the dialog it opens pre-selecting another.
 *
 * ## "In Filming" has one definition
 *
 * A non-archived video whose stage is an **enabled stage of kind `filming`**,
 * in any channel. `kind`, never the stage's name and never its position: a
 * channel can rename Filming to "Shoot" in settings (M7) and everything here
 * has to keep working, which is the rule PLAN.md states for the gate and the
 * badges alike.
 *
 * Across all channels, because there is one creator and one camera — the same
 * reason `filming_days` has no `channel_id`.
 *
 * ## Why these are plain reads and not embeds
 *
 * `videos` has two foreign keys to `stages` (the tenant one and the channel
 * one) and a composite one to `filming_days`, so a PostgREST embed over any of
 * them is either ambiguous or has to name a constraint by its generated name.
 * Two or three plain selects say the same thing, cannot be ambiguous, and are
 * already the pattern `app/c/[slug]/board/page.tsx` uses for the cross-channel
 * count.
 *
 * Everything is RLS-scoped: no query here filters by `user_id`, because the
 * policies do, and a second copy of the ownership rule in a `.eq()` is a second
 * place for it to be wrong.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** A video as a filming day renders it, or as the schedule dialog lists it. */
export interface FilmingVideo {
  readonly id: string;
  readonly title: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly channelSlug: string;
  /** The stage it is in *now* — the thing that makes a past day truthful. */
  readonly stageKind: StageKind | null;
  readonly stageName: string;
  /** Archived videos stay on the day they were filmed on; they just say so. */
  readonly archived: boolean;
  /** `YYYY-MM-DD` or null — drawn beside the title on the day it is filmed for. */
  readonly targetPublishDate: string | null;
}

/** A scheduled batch day, with everything it covers. */
export interface FilmingDay {
  readonly id: string;
  /** `YYYY-MM-DD`. A calendar day, never an instant — see `lib/calendar-dates.ts`. */
  readonly onDate: string;
  readonly notes: string | null;
  readonly videos: readonly FilmingVideo[];
}

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                               */
/* -------------------------------------------------------------------------- */

interface Lookups {
  readonly channels: Map<string, { name: string; slug: string }>;
  readonly stages: Map<string, { kind: StageKind | null; name: string }>;
}

/**
 * The channel and stage names every row here has to be dressed in.
 *
 * `cache()`d per request: the calendar asks for filming days and for what is
 * waiting in Filming, and both need the same two small tables. One user has a
 * handful of channels and nine stages each, so reading them whole is cheaper
 * than the `in (...)` filters that would otherwise be built twice.
 */
const readLookups = cache(async (): Promise<Lookups> => {
  const { supabase } = await requireUser();

  const [{ data: channels }, { data: stages }] = await Promise.all([
    supabase.from("channels").select("id, name, slug"),
    supabase.from("stages").select("id, name, kind"),
  ]);

  return {
    channels: new Map(
      (channels ?? []).map((channel) => [
        channel.id,
        { name: channel.name, slug: channel.slug },
      ]),
    ),
    stages: new Map(
      (stages ?? []).map((stage) => [
        stage.id,
        { kind: isStageKind(stage.kind) ? stage.kind : null, name: stage.name },
      ]),
    ),
  };
});

/** One video row, dressed with the names its channel and stage carry. */
interface VideoRow {
  id: string;
  title: string;
  channel_id: string;
  stage_id: string;
  archived_at: string | null;
  target_publish_date: string | null;
}

function dress(row: VideoRow, lookups: Lookups): FilmingVideo {
  const channel = lookups.channels.get(row.channel_id);
  const stage = lookups.stages.get(row.stage_id);
  return {
    id: row.id,
    // An idea captured with no title cannot happen (capture refuses a blank
    // one), but a row written by hand can, and a nameless line in a list is
    // worse than a placeholder that says so.
    title: row.title.trim() === "" ? "Untitled" : row.title,
    channelId: row.channel_id,
    channelName: channel?.name ?? "—",
    channelSlug: channel?.slug ?? "",
    stageKind: stage?.kind ?? null,
    stageName: stage?.name ?? "—",
    archived: row.archived_at !== null,
    targetPublishDate: row.target_publish_date,
  };
}

const VIDEO_COLUMNS =
  "id, title, channel_id, stage_id, archived_at, target_publish_date";

/* -------------------------------------------------------------------------- */
/* What is waiting for a block of time                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every non-archived video sitting in Filming, in any channel.
 *
 * This is the set the board's badge counts and the set the schedule dialog
 * pre-selects, and it is one function so those two can never disagree — which
 * they would the moment somebody counted with `head: true` here and listed with
 * a slightly different filter there.
 *
 * Ordered by title so the dialog's checkbox list is stable between renders;
 * the board sorts its own cards by target date and does not use this order.
 */
export const readFilmingVideos = cache(async (): Promise<FilmingVideo[]> => {
  const { supabase } = await requireUser();
  const lookups = await readLookups();

  const stageIds = [...lookups.stages.entries()]
    .filter(([, stage]) => stage.kind === "filming")
    .map(([id]) => id);

  if (stageIds.length === 0) return [];

  // `readLookups` reads every stage, enabled or not, because a day's videos
  // have to be nameable whatever stage they are in. "In Filming" is the
  // narrower question, so the enabled check is here.
  const { data: enabled } = await supabase
    .from("stages")
    .select("id")
    .in("id", stageIds)
    .eq("is_enabled", true);

  const enabledIds = (enabled ?? []).map((stage) => stage.id);
  if (enabledIds.length === 0) return [];

  const rows = await readPaged<VideoRow>("videos in Filming", (from, to) =>
    supabase
      .from("videos")
      .select(VIDEO_COLUMNS)
      .in("stage_id", enabledIds)
      .is("archived_at", null)
      .order("id", { ascending: true })
      .range(from, to),
  );

  return rows
    .map((row) => dress(row, lookups))
    .sort((a, b) => a.title.localeCompare(b.title, "en"));
});

/* -------------------------------------------------------------------------- */
/* The days themselves                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The filming days whose date falls in `[from, to]`, with the videos each one
 * covers — **whatever stage those videos are in now**.
 *
 * That last clause is the milestone's own review note (PLAN.md M6: *a filming
 * day whose video left Filming still renders sanely*). A video linked to a
 * Saturday moves to Editing on Sunday, and that is the *normal* case: the day
 * is a record of what was shot, not a live queue. So the read does not filter
 * by stage at all, and it does not drop archived videos either — it reports the
 * stage each video is in and lets `components/calendar/filming/summary.ts` say
 * what that means. A day whose videos have all moved on renders as a day whose
 * videos have all moved on, which is the truth; filtering them out would render
 * it as an empty day, which is not.
 *
 * Two reads, always — the second one is skipped when there are no days.
 */
export async function readFilmingDays(
  from: string,
  to: string,
): Promise<FilmingDay[]> {
  const { supabase } = await requireUser();

  const { data: days, error } = await supabase
    .from("filming_days")
    .select("id, on_date, notes")
    .gte("on_date", from)
    .lte("on_date", to)
    .order("on_date", { ascending: true });

  if (error) {
    throw new Error(`Could not read the filming days: ${error.message}`);
  }
  if (!days || days.length === 0) return [];

  const lookups = await readLookups();

  const rows = await readPaged<VideoRow & { filming_day_id: string | null }>(
    "videos on filming days",
    (start, end) =>
      supabase
        .from("videos")
        .select(`${VIDEO_COLUMNS}, filming_day_id`)
        .in(
          "filming_day_id",
          days.map((day) => day.id),
        )
        .order("id", { ascending: true })
        .range(start, end),
  );

  // Grouped in memory: the alternative is one query per day, and a month has
  // at most a handful of days on it.
  const byDay = new Map<string, FilmingVideo[]>();
  for (const row of rows) {
    const dayId = row.filming_day_id;
    if (!dayId) continue;
    const list = byDay.get(dayId) ?? [];
    list.push(dress(row, lookups));
    byDay.set(dayId, list);
  }

  return days
    .map((day) => ({
      id: day.id,
      onDate: day.on_date,
      notes: day.notes,
      videos: (byDay.get(day.id) ?? []).sort((a, b) =>
        a.title.localeCompare(b.title, "en"),
      ),
    }))
    .sort((a, b) => compareDateColumns(a.onDate, b.onDate));
}

/**
 * The days a video could be attached to from its own page: everything from
 * `from` onwards, plus the one it is already on even when that is in the past.
 *
 * A video linked to last Saturday's shoot has to be able to show which day it
 * is on, and a list that began at today would render "on a day" with nothing to
 * name it.
 */
export async function readLinkableFilmingDays(
  from: string,
  currentDayId: string | null,
): Promise<{ id: string; onDate: string; notes: string | null }[]> {
  const { supabase } = await requireUser();

  const { data: upcoming } = await supabase
    .from("filming_days")
    .select("id, on_date, notes")
    .gte("on_date", from)
    .order("on_date", { ascending: true })
    .limit(30);

  const days = (upcoming ?? []).map((day) => ({
    id: day.id,
    onDate: day.on_date,
    notes: day.notes,
  }));

  if (currentDayId && !days.some((day) => day.id === currentDayId)) {
    const { data: current } = await supabase
      .from("filming_days")
      .select("id, on_date, notes")
      .eq("id", currentDayId)
      .maybeSingle();

    if (current) {
      days.unshift({
        id: current.id,
        onDate: current.on_date,
        notes: current.notes,
      });
    }
  }

  return days;
}

/**
 * How many filming days are scheduled from `today` onwards — the number the
 * sidebar's Calendar row draws.
 *
 * `null`, never a throw and never a zero, for the reason `lib/ideas-data.ts`
 * gives at length: the shell renders on every signed-in route, and a transient
 * failure here must not take the board down with it. Zero is a claim; `null` is
 * the absence of one.
 */
export const countUpcomingFilmingDays = cache(
  async (today: string): Promise<number | null> => {
    try {
      const { supabase } = await requireUser();
      const { count, error } = await supabase
        .from("filming_days")
        .select("id", { count: "exact", head: true })
        .gte("on_date", today);

      if (error) return null;
      return count ?? null;
    } catch {
      return null;
    }
  },
);
