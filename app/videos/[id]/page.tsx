import Link from "next/link";
import { notFound } from "next/navigation";

import { AppHeader } from "@/components/app-header";
import { cacheBusted, signedUrlsFor } from "@/lib/storage";
import { requireUser } from "@/lib/supabase/require-user";

import { FlowFields, type FlowStage } from "@/components/video-detail/flow-fields";
import { formatAge } from "@/components/video-detail/age";
import { PackagingBlock } from "@/components/packaging/packaging-block";

import { ConceptSketch } from "./concept-sketch";

export const metadata = { title: "Video · NerTube" };

/** `videos.id` is a uuid; anything else cannot name a row. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/videos/[id]` — the M1 detail stub.
 *
 * PLAN.md gives M1 exactly two things here: *title + concept-sketch upload
 * (browser → Storage, `recordUpload`) + signed-URL thumb on the card*. The
 * packaging block that this page is eventually mostly made of — title
 * candidates, the hook list, the live gate indicator, the skip flow — is M2 and
 * is deliberately absent rather than half-present. The note at the bottom says
 * so on the page, because a page that is quietly missing its main feature reads
 * as broken.
 *
 * ## Why another user's video is a 404
 *
 * Every read here goes through the request's RLS-scoped client, so a video
 * belonging to someone else returns no row — indistinguishable from an id that
 * was never issued. Both end at `notFound()`. There is no branch that knows the
 * difference, which is the point: a 403 that says "this exists, but not for
 * you" confirms the id to whoever guessed it.
 */
export default async function VideoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { supabase, user } = await requireUser();

  // Checked before the query rather than after: PostgREST answers a malformed
  // uuid with a 400, which would surface as a 500 page instead of a 404.
  if (!UUID.test(id)) {
    notFound();
  }

  const { data: video, error } = await supabase
    .from("videos")
    // prettier-ignore
    .select("id, title, channel_id, stage_id, updated_at, thumbnail_concept_path, thumbnail_concept, title_candidates, hooks, packaging_skipped_at, packaging_skip_reason, target_publish_date, youtube_url, published_at, notes, waiting_on, waiting_since, archived_at")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load that video: ${error.message}`);
  }
  if (!video) {
    notFound();
  }

  // Two plain selects rather than embeds: `videos` reaches both tables through
  // composite foreign keys, and the board page next door already takes the same
  // line for the same reason. They do not depend on each other, so they run
  // together.
  const [{ data: channel }, { data: stage }, { data: stageRows }, sketchUrls] =
    await Promise.all([
    supabase
      .from("channels")
      .select("name, slug")
      .eq("id", video.channel_id)
      .maybeSingle(),
    supabase
      .from("stages")
      .select("name, kind")
      .eq("id", video.stage_id)
      .maybeSingle(),
    // The stage select's options: this channel's enabled stages, in the board's
    // column order. `position` is display order and this is a display list —
    // behaviour (the gate, "the next stage") compares CORE_KIND_ORDER instead,
    // and that comparison happens inside `move_video`, not here.
    supabase
      .from("stages")
      .select("id, name, position")
      .eq("channel_id", video.channel_id)
      .eq("is_enabled", true)
      .order("position", { ascending: true }),
    // One path, but through the batching helper the board uses — so there is
    // one signing code path in the app and not two that can drift.
    signedUrlsFor(supabase, [video.thumbnail_concept_path]),
  ]);

  // `updated_at` versions the URL. The object path is stable on purpose, so
  // without a version a replaced sketch would keep being served out of the
  // browser cache — see `cacheBusted`.
  const sketchUrl = video.thumbnail_concept_path
    ? cacheBusted(sketchUrls.get(video.thumbnail_concept_path), video.updated_at)
    : null;

  const displayTitle = video.title.trim() === "" ? "Untitled" : video.title;

  /*
    The flow block's server-side reads.

    The clock is read once, here, for the same reason the board reads it once:
    this is an async Server Component on a dynamic route, so "now" is the
    request's own time and every label derived from it agrees with every other.
    A client component that called `Date.now()` while rendering would produce
    one string on the server and a different one in the browser a moment later,
    which is a hydration mismatch.
  */
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();

  const flowStages: FlowStage[] = (stageRows ?? []).map((row) => ({
    id: row.id,
    name: row.name,
  }));

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader currentSlug={channel?.slug} />

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-4 py-6">
        <div className="flex flex-col gap-2">
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
            {channel ? (
              <Link
                href={`/c/${channel.slug}/board`}
                className="underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-foreground/40"
              >
                ← {channel.name} board
              </Link>
            ) : null}
            <span
              data-testid="stage-name"
              className="rounded-full border border-border px-2 py-0.5"
            >
              <span className="sr-only">Stage: </span>
              {stage?.name ?? "No stage"}
            </span>
          </p>

          {/* The heading a screen reader announces for the page. The visible
              version of the same string is the editable field below it, and
              two visible copies of one title would just disagree while it is
              being typed. */}
          <h1 className="sr-only">{displayTitle}</h1>

        </div>

        {/* M2's packaging half. The working title lives inside the block rather
            than above it: choosing a title candidate writes the candidate list
            and `videos.title` in one save, and two inputs bound to one column
            on one page is a race, not a convenience. This replaces M1's
            `TitleField` stub, which did the narrow version of the same job. */}
        <PackagingBlock
          videoId={video.id}
          initial={{
            title: video.title,
            thumbnailConcept: video.thumbnail_concept,
            titleCandidates: video.title_candidates,
            hooks: video.hooks,
            packagingSkippedAt: video.packaging_skipped_at,
            packagingSkipReason: video.packaging_skip_reason,
          }}
        />

        <ConceptSketch
          videoId={video.id}
          userId={user.id}
          title={video.title}
          url={sketchUrl}
          hasSketch={video.thumbnail_concept_path !== null}
        />

        {/* M2's flow half. The packaging block is a separate section of this
            page; the two share the route and nothing else. */}
        <FlowFields
          videoId={video.id}
          channelSlug={channel?.slug ?? ""}
          stages={flowStages}
          currentStageId={video.stage_id}
          currentStageName={stage?.name ?? "No stage"}
          targetPublishDate={video.target_publish_date ?? ""}
          youtubeUrl={video.youtube_url ?? ""}
          notes={video.notes ?? ""}
          waitingOn={video.waiting_on ?? ""}
          waitingSince={video.waiting_since}
          waitingAgeLabel={formatAge(video.waiting_since, now)}
          archivedAt={video.archived_at}
          publishedAt={video.published_at}
          publishedLabel={formatPublished(video.published_at)}
        />

        <p className="border-t border-border pt-4 text-xs text-muted">
          The stage checklist and the script are M3; thumbnail roles and the
          post-publish block are M4.
        </p>
      </main>
    </div>
  );
}

/**
 * `published_at` as a date, in UTC with a fixed locale so the server and the
 * browser cannot disagree about which day it was — the same treatment the board
 * gives `target_publish_date`.
 */
function formatPublished(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}
