import { notFound } from "next/navigation";

import { AppHeader } from "@/components/app-header";
import { Board } from "@/components/board/board";
import {
  PUBLISHED_CARD_TTL_DAYS,
  type BoardCard,
  type BoardStage,
} from "@/components/board/types";
import { isStageKind, type StageKind } from "@/lib/defaults";
import { signedUrlsFor } from "@/lib/storage";
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

  // One user, hundreds of rows (PLAN.md's own sizing), so the board reads the
  // channel's non-archived videos in one go and does its grouping in memory.
  // The bound is a guard against a runaway account, not a pagination scheme.
  const { data: videoRows, error: videosError } = await supabase
    .from("videos")
    // One literal, on one line: supabase-js types the result from the select
    // string, and a concatenation is no longer a literal type to read.
    // prettier-ignore
    .select("id, title, stage_id, stage_entered_at, created_at, updated_at, target_publish_date, thumbnail_concept_path, packaging_skipped_at, waiting_on, published_at")
    .eq("channel_id", channel.id)
    .is("archived_at", null)
    .limit(2000);

  if (videosError) {
    throw new Error(
      `Could not load the videos for ${slug}: ${videosError.message}`,
    );
  }

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
      thumbnailConceptPath: video.thumbnail_concept_path,
      thumbnailConceptUrl: video.thumbnail_concept_path
        ? (sketchUrls.get(video.thumbnail_concept_path) ?? null)
        : null,
      packagingSkipped: video.packaging_skipped_at !== null,
      waitingOn: video.waiting_on,
      recencyMs: Date.parse(video.updated_at ?? video.created_at),
    });
  }

  // The Filming batch badge counts across ALL channels: one creator, one
  // camera, one Saturday. Two selects rather than an embed, because `videos`
  // has two FKs to `stages` and PostgREST cannot guess which one is meant.
  const { data: filmingStages } = await supabase
    .from("stages")
    .select("id, channel_id")
    .eq("kind", "filming")
    .eq("is_enabled", true);

  const otherChannelFilmingStageIds = (filmingStages ?? [])
    .filter((stage) => stage.channel_id !== channel.id)
    .map((stage) => stage.id);

  let filmingInOtherChannels = 0;
  if (otherChannelFilmingStageIds.length > 0) {
    const { count } = await supabase
      .from("videos")
      .select("id", { count: "exact", head: true })
      .in("stage_id", otherChannelFilmingStageIds)
      .is("archived_at", null);
    filmingInOtherChannels = count ?? 0;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader currentSlug={slug} />

      <main className="flex flex-1 flex-col gap-4 px-4 py-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-semibold tracking-tight">
            {channel.name}
          </h1>
          <p className="text-xs text-muted">
            Drag a card between columns, or select one with{" "}
            <kbd className="font-sans">j</kbd>/<kbd className="font-sans">k</kbd>{" "}
            and move it with <kbd className="font-sans">[</kbd>/
            <kbd className="font-sans">]</kbd>. Every card also carries its own
            move buttons.
          </p>
        </div>

        {stages.length === 0 ? (
          <p className="text-sm text-muted">
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
            filmingInOtherChannels={filmingInOtherChannels}
          />
        )}
      </main>
    </div>
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
function formatTargetDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(parsed);
}
