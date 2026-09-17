import Link from "next/link";
import { notFound } from "next/navigation";

import { AppHeader } from "@/components/app-header";
import { cacheBusted, signedUrlsFor } from "@/lib/storage";
import { requireUser } from "@/lib/supabase/require-user";

import { ConceptSketch } from "./concept-sketch";
import { TitleField } from "./title-field";

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
    .select("id, title, channel_id, stage_id, updated_at, thumbnail_concept_path")
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
  const [{ data: channel }, { data: stage }, sketchUrls] = await Promise.all([
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

          <TitleField videoId={video.id} initialTitle={video.title} />
        </div>

        <ConceptSketch
          videoId={video.id}
          userId={user.id}
          title={video.title}
          url={sketchUrl}
          hasSketch={video.thumbnail_concept_path !== null}
        />

        <p className="border-t border-border pt-4 text-xs text-muted">
          This page is the M1 stub: a working title and the concept sketch. The
          packaging block (title candidates, hooks, the gate indicator and the
          skip flow) is M2; the stage checklist and the script are M3; thumbnail
          roles and the post-publish block are M4.
        </p>
      </main>
    </div>
  );
}
