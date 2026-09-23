import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { Board } from "@/components/board/board";
import { CaptureLink } from "@/components/capture/capture-dialog";
import { settingsPath } from "@/components/settings/settings-nav";
import { PRIMARY_ACTION, StatePanel } from "@/components/state-panel";
import { checklistRatios } from "@/components/checklist/ratios";
import {
  PUBLISHED_CARD_TTL_DAYS,
  type BoardCard,
  type BoardStage,
} from "@/components/board/types";
import { formatDateColumn, todayColumn } from "@/lib/calendar-dates";
import { readTimeZone } from "@/lib/time-zone-data";
import { isStageKind, type StageKind } from "@/lib/defaults";
import { readFilmingVideos } from "@/lib/filming-data";
import { cacheBusted, signedUrlsFor } from "@/lib/storage";
import { readPaged } from "@/lib/paged";
import { requireUser } from "@/lib/supabase/require-user";
import { channelPageTitle } from "@/lib/page-title";
import { readClock } from "@/lib/request-clock";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return { title: await channelPageTitle(slug, "board") };
}

/**
 * The kanban board for one channel.
 *
 * This file does the reading, the filtering and the clock arithmetic; the
 * client component below it does positions, drag and drop and the keyboard.
 * Splitting it there is deliberate:
 *
 * - **The clock stays on the server.** "Days in stage" and the formatted target
 *   date are both computed here and passed down as a number and a string, so
 *   they are identical on both sides of hydration. Computing them in the
 *   component is a mismatch and a re-render away from being wrong.
 * - **Every query is RLS-scoped and join-free.** `videos` has two foreign keys
 *   to `stages` (the tenant one and the channel one), so a PostgREST embed
 *   would be ambiguous; the cross-channel Filming count is therefore two plain
 *   selects instead of one clever one.
 *
 * Columns are ordered by `position`, because `position` *is* display order.
 * Behaviour — the gate, `[`/`]`, "the next stage" — compares `CORE_KIND_ORDER`
 * instead, and never this.
 */
export default async function BoardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { supabase } = await requireUser();

  // RLS scopes this to the signed-in user, so a slug belonging to someone else
  // is indistinguishable from one that does not exist. Both are a 404.
  const { data: channel } = await supabase
    .from("channels")
    .select("id, name, slug, wip_threshold, stale_days")
    .eq("slug", slug)
    .maybeSingle();

  if (!channel) {
    notFound();
  }

  const { data: stageRows, error: stagesError } = await supabase
    .from("stages")
    .select("id, name, kind, position")
    .eq("channel_id", channel.id)
    .eq("is_enabled", true)
    .order("position", { ascending: true });

  if (stagesError) {
    throw new Error(
      `Could not load the stages for ${slug}: ${stagesError.message}`,
    );
  }

  const stages: BoardStage[] = stageRows.map((stage) => ({
    id: stage.id,
    name: stage.name,
    kind: isStageKind(stage.kind) ? stage.kind : null,
    position: stage.position,
  }));

  const kindByStageId = new Map<string, StageKind | null>(
    stages.map((stage) => [stage.id, stage.kind]),
  );

  /*
    One user, hundreds of rows (PLAN.md's own sizing), so the board reads the
    channel's non-archived videos and does its grouping in memory.

    This used to end `.limit(2000)` and to call that bound a guard. It was
    neither: PostgREST caps every read at `db-max-rows` — 1000 — without saying
    so, and the column counts in the headers (the bottleneck signal BRIEF.md
    asks for) are counts over whatever came back. Corrected by the M5 review,
    which found the same `.limit(2000)` copied into both of M5's reads;
    `lib/paged.ts` now reads every row for all of them.
  */
  const videoRows = await readPaged(`videos for ${slug}`, (from, to) =>
    supabase
      .from("videos")
      // One literal, on one line: supabase-js types the result from the select
      // string, and a concatenation is no longer a literal type to read.
      // prettier-ignore
      .select("id, title, stage_id, stage_entered_at, created_at, updated_at, target_publish_date, thumbnail_concept_path, packaging_skipped_at, waiting_on, published_at, filming_day_id")
      .eq("channel_id", channel.id)
      .is("archived_at", null)
      // A total order, because paging without one can repeat and skip rows.
      .order("id", { ascending: true })
      .range(from, to),
  );

  // The board's clock. `react-hooks/purity` flags `Date.now()` in a component
  // because a client component that reads it re-renders into a different
  // answer; this is an async Server Component on a dynamic route (it reads
  // cookies through `requireUser`), so it runs exactly once per request and
  // "now" is the request's own time. Every clock-dependent value the client
  // gets — days in stage, the 30-day cut-off — is derived from this one read,
  // so the whole board agrees with itself.
  const now = await readClock();
  // And the user's zone, once, for the one calendar-day question the board
  // asks: which day is today (the filming badge's "from today on", the
  // target-date labels). Days in stage and the 30-day cut-off are durations
  // and do not use it.
  const { zone } = await readTimeZone();

  // Concept sketches live in a private bucket, so the card needs a signed URL
  // per path. Signed in ONE request for the whole board (PLAN.md: *server
  // components batch `createSignedUrls(paths, 3600)`*) — a board can hold a
  // hundred cards, and a hundred `createSignedUrl` calls would be a hundred
  // round trips on the page this product is used from most. A path the batch
  // could not sign simply gets no URL, and the card falls back to its empty
  // frame.
  const sketchUrls = await signedUrlsFor(
    supabase,
    videoRows.map((video) => video.thumbnail_concept_path),
  );

  const cards: BoardCard[] = [];
  for (const video of videoRows) {
    // A video in a disabled stage has no column to sit in. It is not lost —
    // settings refuses to disable a stage that still holds non-archived videos
    // — but if one is ever there, dropping it is better than inventing a home.
    if (!kindByStageId.has(video.stage_id)) continue;

    const kind = kindByStageId.get(video.stage_id) ?? null;

    // PLAN.md: Published/Repurposed hide their cards 30 days after
    // `published_at`. The finished work is still on /ideas and /calendar; the
    // board is about what is moving.
    if (
      (kind === "published" || kind === "repurposed") &&
      video.published_at !== null &&
      now - Date.parse(video.published_at) >
        PUBLISHED_CARD_TTL_DAYS * 86_400_000
    ) {
      continue;
    }

    cards.push({
      id: video.id,
      title: video.title,
      stageId: video.stage_id,
      stageEnteredAt: video.stage_entered_at,
      daysInStage: wholeDaysSince(video.stage_entered_at, now),
      targetPublishDate: video.target_publish_date,
      targetPublishLabel: formatTargetDate(video.target_publish_date),
      channelId: channel.id,
      filmingDayId: video.filming_day_id,
      // Filled in below, for the same reason the checklist ratio is: the day
      // labels are one grouped read over the whole set of cards, not one
      // lookup per card.
      filmingDayLabel: null,
      thumbnailConceptPath: video.thumbnail_concept_path,
      // `updated_at` versions the URL: the path is stable by design, so
      // without it a replaced sketch can be served from the browser cache.
      thumbnailConceptUrl: video.thumbnail_concept_path
        ? cacheBusted(
            sketchUrls.get(video.thumbnail_concept_path),
            video.updated_at,
          )
        : null,
      // Filled in below, once the whole set of cards is known: the ratio read
      // is grouped by stage, so it cannot be done a card at a time.
      checklist: null,
      packagingSkipped: video.packaging_skipped_at !== null,
      waitingOn: video.waiting_on,
      recencyMs: Date.parse(video.updated_at ?? video.created_at),
    });
  }

  /*
    The `done/total` on each card, for the stage each card is actually in.

    After the loop rather than inside it: the read is grouped by stage so that
    one query covers a whole column, and a card that the 30-day rule dropped
    above should not be counted at all. A video the read could not stand behind
    is left null and the card renders no ratio — see
    `components/checklist/ratios.ts`.
  */
  const ratios = await checklistRatios(
    supabase,
    cards.map((card) => ({ videoId: card.id, stageId: card.stageId })),
  );
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    cards[index] = { ...card, checklist: ratios.get(card.id) ?? null };
  }

  /*
    Which filming day each card is already on, in words.

    One small query over the distinct ids the cards carry, skipped entirely when
    none of them is booked. It exists because the Filming badge's dialog has to
    be able to say "already on Sat 1 May" beside a candidate rather than ticking
    it — M6's review found that ticking it moved the video off the shoot it was
    already on and emptied that day. Formatted here, on the server, for the rule
    `FilmingVideo.filmingDayLabel` states.
  */
  const bookedDayIds = [
    ...new Set(
      cards
        .map((card) => card.filmingDayId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (bookedDayIds.length > 0) {
    const { data: bookedDays } = await supabase
      .from("filming_days")
      .select("id, on_date")
      .in("id", bookedDayIds);

    const dayLabels = new Map(
      (bookedDays ?? []).map((day) => [
        day.id,
        formatDateColumn(day.on_date, "weekday") ?? day.on_date,
      ]),
    );

    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index];
      if (card.filmingDayId === null) continue;
      cards[index] = {
        ...card,
        filmingDayLabel: dayLabels.get(card.filmingDayId) ?? null,
      };
    }
  }

  /*
    The Filming batch badge counts across ALL channels: one creator, one
    camera, one Saturday.

    Since M6 it is a *list* and not a count, because the badge is now the button
    that opens the schedule dialog and that dialog pre-selects exactly the
    videos the badge counted. `readFilmingVideos()` (`lib/filming-data.ts`) is
    the one definition of "in Filming" — an enabled stage of kind `filming`, not
    archived, any channel — so the number on the badge and the videos the dialog
    pre-selects cannot drift apart. This channel's own cards are
    added on the client from what is on screen, so a card dragged in a moment
    ago is included without a refetch; this list is deliberately the *other*
    channels only, and the two cannot overlap.
  */
  const filmingElsewhere = (await readFilmingVideos()).filter(
    (video) => video.channelId !== channel.id,
  );

  return (
    <AppShell currentSlug={slug} section="board">
      <div className="flex flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-[22px] leading-tight font-semibold tracking-tight">
            {channel.name}
          </h1>
          {/* The keys themselves are listed once, in the sidebar, from the
              live shortcut registry — repeating them here is how the two get
              to disagree. */}
          <p className="text-[12px] text-muted">
            <span className="thumb:hidden">
              Drag a card between columns, or use the move buttons on a card.
              The keys in the sidebar do the same thing.
            </span>
            {/*
              M9: said on the board itself, where a thumb is the pointer. A
              kanban of nine 216px columns is a desktop view and this does not
              pretend otherwise — but it is not a broken one on a phone: the
              strip scrolls sideways inside itself, and the ← → on every card
              is the same `move_video` a drag is. Dragging is what does not
              travel (touch does not start an HTML5 drag), so the sentence that
              offers it is swapped for the one that works. (M10: the way
              across the columns on a phone is now the row of stages above
              them, which needs no sentence.)
            */}
            <span className="hidden thumb:inline">
              ← and → on a card move it to the stage beside it. Dragging
              cards needs a mouse.
            </span>
          </p>
        </div>

        {/*
          M9: a board with no cards on it at all — a channel created a moment
          ago, or one whose every video has been archived. Nine empty columns
          say nothing about how anything gets onto them, and the only ways in
          were a key and a sidebar button nobody has been told about. The
          columns still draw below it, because they are the answer to "what is
          this page": the stages a video will move through.
        */}
        {stages.length > 0 && cards.length === 0 ? (
          <StatePanel
            testId="board-empty"
            title={`${channel.name}’s board is empty`}
            actions={
              <CaptureLink
                channels={[{ id: channel.id, name: channel.name, slug: channel.slug }]}
                channelId={channel.id}
                testId="board-empty-capture"
                className={PRIMARY_ACTION}
              >
                Capture an idea
              </CaptureLink>
            }
          >
            <p>
              Every video moves left to right through these columns, from an
              idea to a published URL. To start one, capture a title —
              packaging, the script and the rest come later, one column at a
              time.
            </p>
          </StatePanel>
        ) : null}

        {stages.length === 0 ? (
          <StatePanel
            testId="board-no-stages"
            tone="problem"
            title="Every stage is switched off"
            actions={
              <Link href={settingsPath("stages", channel.slug)} className={PRIMARY_ACTION}>
                Open stage settings
              </Link>
            }
          >
            <p>
              A board draws one column per enabled stage, and this channel has
              none. Switch the stages you use back on and the board returns
              with its videos where they were.
            </p>
          </StatePanel>
        ) : (
          <Board
            channelName={channel.name}
            channelSlug={channel.slug}
            stages={stages}
            cards={cards}
            wipThreshold={channel.wip_threshold}
            staleDays={channel.stale_days}
            filmingElsewhere={filmingElsewhere}
            today={todayColumn(now, zone)}
            now={now}
          />
        )}
      </div>
    </AppShell>
  );
}

/**
 * Whole days between `iso` and `now`, floored, never negative.
 *
 * A **duration** — elapsed 24-hour periods — not the number of midnights
 * crossed, so it needs no zone: "3 days in stage" means 72 hours or more.
 */
function wholeDaysSince(iso: string, now: number): number {
  const entered = Date.parse(iso);
  if (Number.isNaN(entered)) return 0;
  return Math.max(0, Math.floor((now - entered) / 86_400_000));
}

/**
 * A target date as a card prints it: `3 Mar`.
 *
 * M6 note: this used to parse `${value}T00:00:00Z` and build its own
 * `Intl.DateTimeFormat`, which made the board a third interpretation of a
 * `date` column alongside the calendar and the matrix — same intent, same
 * options, separately maintained. It is `formatDateColumn(_, "short")` now,
 * which is that formatter, cached, with the invalid-day rejection the helper
 * already does.
 */
function formatTargetDate(value: string | null): string | null {
  return formatDateColumn(value, "short");
}
