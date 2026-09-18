import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { ChecklistStrip } from "@/components/checklist/checklist-strip";
import {
  CHECKLIST_COLUMNS,
  readChecklistItem,
  sortItems,
  type ChecklistItem,
  type EvidenceFacts,
} from "@/lib/checklist";
import { compareKinds } from "@/lib/defaults";
import { readHooks, readTitleCandidates } from "@/lib/packaging";
import { cacheBusted, signedUrlsFor } from "@/lib/storage";
import { requireUser } from "@/lib/supabase/require-user";

import { AssistPill } from "@/components/preview/assist-pill";
import { TitleTruncationWarning } from "@/components/preview/truncation-warning";
import { YouTubePreview } from "@/components/preview/youtube-preview";
import { NotYet } from "@/components/video-sections/not-yet";
import { ScriptSection } from "@/components/video-sections/script-section";
import {
  parseSection,
  SECTION_PARAM,
  stageKindOf,
  type SectionFacts,
} from "@/components/video-sections/sections";
import { VideoSections } from "@/components/video-sections/video-sections";
import { FlowFields, type FlowStage } from "@/components/video-detail/flow-fields";
import { formatAge } from "@/components/video-detail/age";
import { PackagingBlock } from "@/components/packaging/packaging-block";
import { VideoVersionProvider } from "@/components/video-version";

import { ConceptSketch } from "./concept-sketch";

export const metadata = { title: "Video · NerTube" };

/** `videos.id` is a uuid; anything else cannot name a row. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/videos/[id]` — the video detail page.
 *
 * ## The order of it
 *
 * The page is five sections — Packaging, Script, Thumbnails, Schedule, Publish
 * — and **Packaging is the first tab and the one a bare URL opens at**. BRIEF.md
 * principle 1 is that the title, the thumbnail concept and the hook are decided
 * *before* the script and the shoot, and a page that opened on dates and notes
 * would quietly say the opposite. The flow fields — stage, target date, waiting
 * on, URL, notes, archive — are the Schedule section, a tab along.
 *
 * Two things sit outside the sections, above them, because they belong to the
 * video rather than to any one part of it: the channel and stage line, and the
 * checklist strip. The strip in particular answers "what do I actually do to
 * this next", which is a question you have while looking at any section, so it
 * must not move when the section changes.
 *
 * Which section is showing, how the URL says so and why switching never costs
 * an unsaved edit are all `components/video-sections/video-sections.tsx`.
 *
 * The concept **sketch** M1 built is not a section of its own any more. It is
 * rendered inside the packaging block, beside the *written* concept, because
 * the two are a pair: a description of a thumbnail and a reference picture of
 * it. Apart, they read as two fields either of which might satisfy the gate,
 * which is exactly the misreading M1's review caught. Together, under one
 * heading, the written one is plainly the field and the picture is plainly the
 * reference.
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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /**
   * `?section=` — which section this URL opens at. Parsed here, on the server,
   * so that a pasted link renders the right section in its *first* HTML rather
   * than switching to it after hydration. The browser owns the value from
   * there; see `components/video-sections/video-sections.tsx`.
   */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const section = parseSection(query[SECTION_PARAM]);
  const { supabase, user } = await requireUser();

  // Checked before the query rather than after: PostgREST answers a malformed
  // uuid with a 400, which would surface as a 500 page instead of a 404.
  if (!UUID.test(id)) {
    notFound();
  }

  const { data: video, error } = await supabase
    .from("videos")
    // prettier-ignore
    .select("id, title, channel_id, stage_id, updated_at, thumbnail_concept_path, thumbnail_concept, title_candidates, hooks, packaging_skipped_at, packaging_skip_reason, script, target_publish_date, youtube_url, published_at, notes, waiting_on, waiting_since, archived_at")
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
  const [
    { data: channel },
    { data: stage },
    { data: stageRows },
    { data: checklistRows },
    sketchUrls,
  ] = await Promise.all([
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
    /*
      The current stage's checklist, and only the current stage's.

      `checklist_items` accumulates a row per stage the video has ever
      entered — that is the point of the snapshot — so a query without the
      `stage_id` filter would hand the strip every list this video has ever
      had and make its ratio the sum of them. `move_video` copies the
      templates in on first entry; nothing here creates a row.
    */
    supabase
      .from("checklist_items")
      .select(CHECKLIST_COLUMNS)
      .eq("video_id", id)
      .eq("stage_id", video.stage_id)
      .order("position", { ascending: true }),
    // One path, but through the batching helper the board uses — so there is
    // one signing code path in the app and not two that can drift.
    signedUrlsFor(supabase, [video.thumbnail_concept_path]),
  ]);

  // `updated_at` versions the URL. The object path is stable on purpose, so
  // without a version a replaced sketch would keep being served out of the
  // browser cache — see `cacheBusted`.
  const sketchUrl = video.thumbnail_concept_path
    ? cacheBusted(
        sketchUrls.get(video.thumbnail_concept_path),
        video.updated_at,
      )
    : null;

  const displayTitle = video.title.trim() === "" ? "Untitled" : video.title;

  const checklist: ChecklistItem[] = sortItems(
    (checklistRows ?? []).map(readChecklistItem),
  );

  /*
    What the checklist rows can be measured against.

    Counted here, from the row, rather than inside the strip: these are the same
    three numbers the packaging block renders in its own controls, and two
    components counting the same jsonb array two ways is how a row ends up
    claiming four candidates beside an editor showing three. The readers are the
    lenient ones in `lib/packaging.ts`, so a hand-written array still counts.
  */
  const candidates = readTitleCandidates(video.title_candidates);
  const hooks = readHooks(video.hooks);

  const facts: EvidenceFacts = {
    titleLength: video.title.trim().length,
    candidateCount: candidates.length,
    hookCount: hooks.length,
  };

  /*
    What the five section tabs say about themselves.

    Read from the row here and re-derived from the live draft in the nav — one
    function, `sectionReadiness`, so the tab cannot say "1/3" about a form that
    visibly has all three. Everything else on the row is only written by a save
    and a re-render, so the server's answer is the whole answer.
  */
  const sectionFacts: SectionFacts = {
    stageKind: stageKindOf(stage?.kind),
    titleFilled: video.title.trim() !== "",
    conceptFilled: (video.thumbnail_concept ?? "").trim() !== "",
    chosenHooks: hooks.filter((hook) => hook.chosen).length,
    packagingSkipped: video.packaging_skipped_at !== null,
    scriptFilled: (video.script ?? "").trim() !== "",
    targetDateSet: video.target_publish_date !== null,
    published: video.published_at !== null,
  };

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
    <AppShell currentSlug={channel?.slug}>
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8">
        <div className="flex flex-col gap-2">
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
            {channel ? (
              <Link
                href={`/c/${channel.slug}/board`}
                className="underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
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

        {/*
          The sections, and everything inside them.

          One client shell owns which one is showing, the URL that names it and
          the fact that all five stay mounted — that last one is what makes
          switching sections free of consequences for a half-typed field. The
          panels themselves are rendered here, on the server, and handed over as
          elements.
        */}
        <VideoVersionProvider updatedAt={video.updated_at}>
          <VideoSections
            pathname={`/videos/${video.id}`}
            initial={section}
            facts={sectionFacts}
            /*
              The checklist, in the one place it lives on this page: under the
              tabs and above every section, because the question it answers —
              what is the next thing I actually do to this video — is the
              question you have while looking at any of them.

              Keyed by the stage: a move re-renders this route with a different
              `stage_id` and a different list, and the strip holds its own
              optimistic copy of the rows. Remounting is how that copy is
              replaced wholesale rather than merged with a list it has nothing
              to do with.
            */
            underTabs={
              <ChecklistStrip
                key={video.stage_id}
                videoId={video.id}
                stageId={video.stage_id}
                stageName={stage?.name ?? "This stage"}
                initial={checklist}
                facts={facts}
              />
            }
            panels={{
              /* The gate. The working title lives inside the block rather than
                 above it: choosing a title candidate writes the candidate list
                 and `videos.title` in one save, and two inputs bound to one
                 column on one page is a race, not a convenience. The sketch
                 goes in as a slot, next to the written concept it illustrates;
                 so do the warning and the three inert assists. */
              packaging: (
                <>
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
                    sketch={
                      <ConceptSketch
                        videoId={video.id}
                        userId={user.id}
                        title={video.title}
                        url={sketchUrl}
                        hasSketch={video.thumbnail_concept_path !== null}
                      />
                    }
                    titleWarning={
                      <TitleTruncationWarning
                        savedTitle={video.title}
                        savedCandidates={candidates}
                      />
                    }
                    assist={{
                      candidates: (
                        <AssistPill
                          verb="Generate 20"
                          what="Asks for ten to twenty title candidates in this channel's voice, each with a reason."
                        />
                      ),
                      concept: (
                        <AssistPill
                          verb="Suggest concepts"
                          what="Proposes thumbnail concepts for the chosen title."
                        />
                      ),
                      hooks: (
                        <AssistPill
                          verb="Draft a third"
                          what="Writes the hooks you have not written yet, up to three."
                        />
                      ),
                    }}
                  />

                  {/* The point of the packaging section: what the title and
                      the sketch look like where they will be seen. */}
                  <YouTubePreview
                    channelName={channel?.name ?? "Your channel"}
                    sketchUrl={sketchUrl}
                    savedTitle={video.title}
                  />
                </>
              ),

              script: (
                <ScriptSection
                  script={video.script}
                  reachedScripting={
                    sectionFacts.stageKind !== null &&
                    compareKinds(sectionFacts.stageKind, "scripting") >= 0
                  }
                  stageName={stage?.name ?? "this stage"}
                />
              ),

              thumbnails: (
                <NotYet title="Thumbnails" milestone="M4">
                  <p>
                    Three role slots — wild card, moderate, safe — with one
                    shipped, the swap dialog and its append-only log. The
                    database side of all of it exists already:{" "}
                    <code className="font-mono">swap_thumbnail</code>, the{" "}
                    <code className="font-mono">thumbnail_swaps</code> table and
                    the CHECK that refuses a shipped role without an asset.
                  </p>
                  <p>
                    Until then the one image a video has is the{" "}
                    <strong className="font-medium">concept sketch</strong> in
                    Packaging, which is a reference picture and never the
                    shipped thumbnail.
                  </p>
                </NotYet>
              ),

              /* Everything about the video's flow rather than its packaging:
                 the stage, the target date, what it is waiting on, the URL,
                 notes and the archive. */
              schedule: (
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
              ),

              publish: (
                <NotYet title="Publish" milestone="M4">
                  <p>
                    The first 24 hours: impressions and click-through rate as
                    one pair (neither is readable without the other), views, the
                    note about new viewers, and the &ldquo;swap the
                    thumbnail?&rdquo; prompt measured against this channel&rsquo;s
                    expectation.
                  </p>
                  <p>
                    The live URL and the target date are on{" "}
                    <strong className="font-medium">Schedule</strong> meanwhile,
                    and <code className="font-mono">/now</code> already raises
                    the 24-hour check when a published video has no metrics
                    logged.
                  </p>
                </NotYet>
              ),
            }}
          />
        </VideoVersionProvider>
      </div>
    </AppShell>
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
