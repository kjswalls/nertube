import { notFound } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { Board } from "@/components/board/board";
import { checklistRatios } from "@/components/checklist/ratios";
import {
  PUBLISHED_CARD_TTL_DAYS,
  type BoardCard,
  type BoardStage,
} from "@/components/board/types";
import { formatDateColumn, todayColumn } from "@/lib/calendar-dates";
import { isStageKind, type StageKind } from "@/lib/defaults";
import { readFilmingVideos } from "@/lib/filming-data";
import { cacheBusted, signedUrlsFor } from "@/lib/storage";
import { readPaged } from "@/lib/paged";
import { requireUser } from "@/lib/supabase/require-user";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return { title: `${slug} · board · NerTube` };
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
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

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
      filmingDayId: video.filming_day_id,
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
            Drag a card between columns, or use the move buttons on a card. The
            keys in the sidebar do the same thing.
          </p>
        </div>

        {stages.length === 0 ? (
          <p className="text-[13px] text-muted">
            This channel has no enabled stages. Turn one back on in settings.
          </p>
        ) : (
          <Board
            channelName={channel.name}
            channelSlug={channel.slug}
            stages={stages}
            cards={cards}
            wipThreshold={channel.wip_threshold}
            staleDays={channel.stale_days}
            filmingElsewhere={filmingElsewhere}
            today={todayColumn(now)}
            now={now}
          />
        )}
      </div>
    </AppShell>
  );
}

/** Whole days between `iso` and `now`, floored, never negative. */
function wholeDaysSince(iso: string, now: number): number {
  const entered = Date.parse(iso);
  if (Number.isNaN(entered)) return 0;
  return Math.max(0, Math.floor((now - entered) / 86_400_000));
}

/**
 * `target_publish_date` is a plain `YYYY-MM-DD` — a calendar date with no time
 * and no zone. Formatted in UTC with a fixed locale so the server and the
 * browser cannot disagree about which day it is.
 */
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
