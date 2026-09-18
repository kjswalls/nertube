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
import { GATE_ANCHOR, readHooks, readTitleCandidates } from "@/lib/packaging";
import {
  cacheBusted,
  isThumbnailRole,
  signedUrlsFor,
  THUMBNAIL_ROLES,
  type ThumbnailRole,
} from "@/lib/storage";
import type { BucketChoices, BucketOption } from "@/lib/buckets";
import { readExpectation } from "@/lib/expectation";
import { formatPublishDate } from "@/lib/next-action";
import { requireUser } from "@/lib/supabase/require-user";

import { AssistPill } from "@/components/preview/assist-pill";
import { TitleTruncationWarning } from "@/components/preview/truncation-warning";
import { YouTubePreview } from "@/components/preview/youtube-preview";
import {
  ThumbnailsSection,
  type ThumbnailVariantView,
} from "@/components/thumbnails/thumbnails-section";
import type { SwapEntry } from "@/components/thumbnails/swap-log";
import { ROLE_LABEL } from "@/components/thumbnails/roles";
import { PostPublishBlock } from "@/components/post-publish/post-publish-block";
import { ScriptSection } from "@/components/video-sections/script-section";
import {
  parseSection,
  SECTION_PARAM,
  stageKindOf,
  type SectionFacts,
} from "@/components/video-sections/sections";
import { VideoSections } from "@/components/video-sections/video-sections";
import { FilingBlock } from "@/components/ideas/assign/filing-block";
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
    .select("id, title, channel_id, stage_id, updated_at, thumbnail_concept_path, thumbnail_concept, title_candidates, hooks, packaging_skipped_at, packaging_skip_reason, script, target_publish_date, youtube_url, published_at, notes, waiting_on, waiting_since, archived_at, vertical_id, horizontal_id, tags, thumb_wild_card_path, thumb_moderate_path, thumb_safe_path, shipped_role, first24_impressions, first24_ctr, first24_views, new_viewers_note, metrics_logged_at, swap_dismissed_at")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load that video: ${error.message}`);
  }
  if (!video) {
    notFound();
  }

  /*
    The three thumbnail variants, as paths on the row.

    Three columns rather than a child table, which is PLAN.md's decision and
    the reason the section can never be asked "which of these two is the safe
    one": there is one safe slot and it is a column.
  */
  const variantPaths: Readonly<Record<ThumbnailRole, string | null>> = {
    wild_card: video.thumb_wild_card_path,
    moderate: video.thumb_moderate_path,
    safe: video.thumb_safe_path,
  };

  // Two plain selects rather than embeds: `videos` reaches both tables through
  // composite foreign keys, and the board page next door already takes the same
  // line for the same reason. They do not depend on each other, so they run
  // together.
  const [
    { data: channel },
    { data: stage },
    { data: stageRows },
    { data: checklistRows },
    { data: swapRows },
    { data: bucketRows },
    { data: tagRows },
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
    /*
      The swap log, newest first.

      Append-only by grant, not by convention: `0001_init.sql` revokes UPDATE
      and DELETE on `thumbnail_swaps` from `authenticated` altogether, so this
      read has no editing counterpart anywhere in the app.
    */
    supabase
      .from("thumbnail_swaps")
      .select("id, swapped_at, from_role, to_role, reason")
      .eq("video_id", id)
      .order("swapped_at", { ascending: false }),
    /*
      The channel's content buckets, both axes, in position order.

      Read here rather than fetched by the picker (which is what capture's
      modal does, and for the opposite reason): this page is already reading
      the row that names two of them, in the same request, so a second round
      trip would only widen the window in which the menus disagree with the
      columns.

      The picker is handed these split by axis, and that split is the whole of
      why it cannot express an invalid choice — see `lib/buckets.ts`.
    */
    supabase
      .from("buckets")
      .select("id, axis, name, position")
      .eq("channel_id", video.channel_id)
      .order("position", { ascending: true }),
    /*
      Every tag this channel's videos already carry.

      The tag editor offers them so the vocabulary converges instead of
      sprawling (BRIEF.md wants tags so an idea can be *found again*, which is a
      property of the whole bank). It is one column over one channel's rows —
      PLAN.md's sizing is one user and hundreds of rows — counted in memory
      below rather than by a `group by`, because PostgREST has no `unnest` and a
      SQL function for a chip row would be a migration nobody needs.
    */
    supabase
      .from("videos")
      .select("tags")
      .eq("channel_id", video.channel_id)
      .limit(2000),
    // Four paths in one request: the concept sketch and the three variants.
    // `createSignedUrls` is batched for exactly this reason — see the helper.
    signedUrlsFor(supabase, [
      video.thumbnail_concept_path,
      variantPaths.wild_card,
      variantPaths.moderate,
      variantPaths.safe,
    ]),
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

  /*
    The three variants as the section wants them.

    `hasAsset` travels separately from `url` on purpose. `url === null` means
    two different things — nothing was ever uploaded, or there is an object and
    the app could not sign a URL for it — and telling the second "no image yet"
    is a lie the person cannot act on. M3's reviewers caught exactly that on the
    concept sketch; the fix is the same shape here.
  */
  const variants: ThumbnailVariantView[] = THUMBNAIL_ROLES.map((role) => {
    const path = variantPaths[role];
    return {
      role,
      hasAsset: path !== null,
      url: path ? cacheBusted(sketchUrls.get(path), video.updated_at) : null,
    };
  });

  const swaps: SwapEntry[] = (swapRows ?? []).map((row) => ({
    id: row.id,
    swappedAt: row.swapped_at,
    fromRole: row.from_role,
    toRole: row.to_role,
    reason: row.reason,
  }));

  const shippedRole = isThumbnailRole(video.shipped_role) ? video.shipped_role : null;

  /*
    The post-publish block's own reads.

    Separate from the batch above because they depend on which channel the
    video is in and on which stage the Repurposed lane is, and because the
    expectation is two queries of its own (`lib/expectation.ts`). This is a
    detail page for one video; the extra round trip buys a block that can say
    *why* a number is below expectation rather than only that it is.

    The Repurposed stage is read **without** the `is_enabled` filter the stage
    select uses: this is the switch for that flag, so it has to be able to see
    the lane when it is off.
  */
  const [expectation, { data: repurposedStage }] = await Promise.all([
    readExpectation(supabase, video.channel_id),
    supabase
      .from("stages")
      .select("id, name, is_enabled")
      .eq("channel_id", video.channel_id)
      .eq("kind", "repurposed")
      .maybeSingle(),
  ]);

  /*
    What is sitting in the Repurposed lane, so the switch is already disabled
    with a reason underneath it rather than refusing after a click. Archived
    videos do not count — PLAN.md review item 10 — because they are already off
    the board and out of `/now`.
  */
  const { count: repurposedOccupied } = repurposedStage
    ? await supabase
        .from("videos")
        .select("id", { count: "exact", head: true })
        .eq("stage_id", repurposedStage.id)
        .is("archived_at", null)
    : { count: 0 };

  /*
    Has a swap been logged since the numbers were? The same question `/now`'s
    rule 3 asks (`swappedSince`), asked of the log this page has already read.
    `swaps` is newest first, so the first row is the most recent.
  */
  const swappedSinceMetrics =
    video.metrics_logged_at !== null &&
    swaps.length > 0 &&
    Date.parse(swaps[0].swappedAt) >= Date.parse(video.metrics_logged_at);

  /*
    The buckets, split by axis.

    Two lists and not one with an `axis` field: a picker that is handed one
    list has to filter it, and a picker that filters is a picker that can filter
    wrongly. This is the only place the split happens.
  */
  const bucketChoices: BucketChoices = {
    verticals: (bucketRows ?? [])
      .filter((bucket) => bucket.axis === "vertical")
      .map((bucket): BucketOption => ({ id: bucket.id, name: bucket.name })),
    horizontals: (bucketRows ?? [])
      .filter((bucket) => bucket.axis === "horizontal")
      .map((bucket): BucketOption => ({ id: bucket.id, name: bucket.name })),
  };

  /*
    The channel's tag vocabulary, most-used first.

    Most-used first because the suggestion row is short and the tags worth
    converging on are the ones already doing the work. Counted
    case-insensitively — `Tutorial` and `tutorial` are one tag, which is what
    `TagListSchema` says when either is written — and shown in the spelling that
    is most common, because that is the one the bank's filter chips draw.
  */
  const tagCounts = new Map<string, { label: string; count: number }>();
  for (const row of tagRows ?? []) {
    for (const tag of row.tags ?? []) {
      const key = tag.toLocaleLowerCase();
      const seen = tagCounts.get(key);
      if (seen) seen.count += 1;
      else tagCounts.set(key, { label: tag, count: 1 });
    }
  }
  const tagVocabulary = [...tagCounts.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .map((entry) => entry.label);

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
    variantsReady: variants.filter((variant) => variant.hasAsset).length,
    thumbnailShipped: shippedRole !== null,
    metricsLogged: video.metrics_logged_at !== null,
    // Both answers count: keeping the thumbnail and changing it are decisions
    // about the same question.
    swapDecided: video.swap_dismissed_at !== null || swappedSinceMetrics,
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

  /*
    Is the target date here yet?

    The same arithmetic `lib/next-action.ts` rule 5 makes, against the same
    single clock read: `target_publish_date` is a zoneless `date`, so the
    comparison is with the start of that day in UTC and the day itself counts
    as due. Computed on the server for the usual reason — a client component
    reading the clock while rendering is a hydration mismatch waiting to
    happen.
  */
  const targetStart =
    video.target_publish_date === null
      ? null
      : Date.parse(`${video.target_publish_date}T00:00:00Z`);
  const dueToConfirm =
    targetStart === null || Number.isNaN(targetStart) ? true : now >= targetStart;

  const header = (
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
          version of the same string is the editable field below it, and two
          visible copies of one title would just disagree while it is being
          typed. */}
      <h1 className="sr-only">{displayTitle}</h1>
    </div>
  );

  return (
    <AppShell currentSlug={channel?.slug}>
      <div className="flex w-full flex-1 flex-col">
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
            /* The channel/stage line and the page heading. They live above the
               tabs but inside this component, because it is what decides how
               wide the page column is — see its `header` prop. */
            header={header}
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
                 so do the warning and the three inert assists.

                 Every one of those slot elements carries a `key`, which looks
                 odd on something that is not in a list and is not decoration.
                 React validates these as list entries — a client component's
                 element-valued props, created here in a *server* component, are
                 handed to `PackagingBlock` and end up in a children position it
                 checks for keys — and the result was a development warning on
                 every video whose title the feed would cut, and again after a
                 move: *Each child in a list should have a unique "key" prop.
                 Check the render method of `PackagingBlock`. It was passed a
                 child from VideoDetailPage.* Bisected, not guessed: removing a
                 slot silenced it, and so does a key on that slot, one slot at a
                 time. Keys are cheap and the warning is the kind that trains a
                 reader to ignore real missing keys, so they stay. */
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
                        key="concept-sketch"
                        videoId={video.id}
                        userId={user.id}
                        title={video.title}
                        url={sketchUrl}
                        hasSketch={video.thumbnail_concept_path !== null}
                      />
                    }
                    titleWarning={
                      <TitleTruncationWarning
                        key="title-truncation-warning"
                        savedTitle={video.title}
                        savedCandidates={candidates}
                      />
                    }
                    assist={{
                      candidates: (
                        <AssistPill
                          key="assist-candidates"
                          verb="Generate 20"
                          what="Asks for ten to twenty title candidates in this channel's voice, each with a reason."
                        />
                      ),
                      concept: (
                        <AssistPill
                          key="assist-concept"
                          verb="Suggest concepts"
                          what="Proposes thumbnail concepts for the chosen title."
                        />
                      ),
                      hooks: (
                        <AssistPill
                          key="assist-hooks"
                          verb="Draft a third"
                          what="Writes the hooks you have not written yet, up to three."
                        />
                      ),
                    }}
                  />

                  {/* The idea-bank fields, on the tab a bare `/videos/[id]`
                    opens at: where this video sits in its channel's matrix and
                    how it will be found again. See
                    `components/ideas/assign/filing-block.tsx` for why they are
                    here rather than under Schedule. */}
                  <FilingBlock
                    videoId={video.id}
                    choices={bucketChoices}
                    verticalId={video.vertical_id}
                    horizontalId={video.horizontal_id}
                    tags={video.tags ?? []}
                    vocabulary={tagVocabulary}
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

              /*
                The assets, and the concept they are executions of.

                The section opens by quoting the *written* concept from
                Packaging, read-only, with a link back to it — BRIEF.md
                principle 2 is that the concept and the files are two fields at
                two stages, and the one place they are most likely to be
                conflated is the screen where the files are uploaded.
              */
              thumbnails: (
                <ThumbnailsSection
                  videoId={video.id}
                  userId={user.id}
                  title={video.title}
                  channelName={channel?.name ?? "Your channel"}
                  concept={video.thumbnail_concept}
                  conceptHref={`/videos/${video.id}#${GATE_ANCHOR.thumbnail_concept}`}
                  variants={variants}
                  shippedRole={shippedRole}
                  swaps={swaps}
                  assist={
                    <AssistPill
                      verb="Critique at tile size"
                      what="Judges each variant against the concept at 360px, the way a viewer sees it."
                    />
                  }
                />
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

              /*
                The post-publish loop, in the order it happens: go live, write
                the first twenty-four hours down, decide about the thumbnail,
                then repurpose. Manual entry and one question — PLAN.md calls
                this block "simple, manual entry", and analytics are out of
                scope for v1 on purpose.
              */
              publish: (
                <PostPublishBlock
                  videoId={video.id}
                  stageKind={sectionFacts.stageKind}
                  publishedAt={video.published_at}
                  publishedLabel={formatPublished(video.published_at)}
                  youtubeUrl={video.youtube_url}
                  targetPublishDate={video.target_publish_date}
                  targetLabel={
                    video.target_publish_date
                      ? formatPublishDate(video.target_publish_date)
                      : null
                  }
                  dueToConfirm={dueToConfirm}
                  metrics={{
                    impressions: video.first24_impressions,
                    // `numeric(5,2)` can arrive as a string; one place decides.
                    ctr:
                      video.first24_ctr === null
                        ? null
                        : Number(video.first24_ctr),
                    views: video.first24_views,
                    newViewersNote: video.new_viewers_note,
                  }}
                  metricsLoggedAt={video.metrics_logged_at}
                  swapDismissedAt={video.swap_dismissed_at}
                  expectation={expectation}
                  shippedRole={shippedRole}
                  swappedSinceMetrics={swappedSinceMetrics}
                  repurposed={
                    repurposedStage
                      ? {
                          id: repurposedStage.id,
                          name: repurposedStage.name,
                          isEnabled: repurposedStage.is_enabled,
                        }
                      : null
                  }
                  repurposedOccupied={repurposedOccupied ?? 0}
                />
              ),
            }}
            /*
              The right rail, and the one section that fills it.

              The preview belongs *beside* the packaging block rather than
              under it: its job is to show the clamp moving as the title is
              typed, and a preview below the fold shows that to nobody. The
              rail is sticky, so it stays there while the candidate list and
              the hooks are scrolled through.

              Under 1480px there is not room for a 452px rail next to a
              readable measure, and shrinking YouTube's own pixel sizes to fit
              is the one thing this component must not do — so below that width
              the rail stacks under the panel at full size, which is exactly
              where it was before. See `components/video-sections/video-sections.tsx`.
            */
            rails={{
              packaging: (
                <YouTubePreview
                  channelName={channel?.name ?? "Your channel"}
                  sketchUrl={sketchUrl}
                  // Separately from the URL, and for the reason
                  // `ConceptSketch` above takes it separately: `sketchUrl` is
                  // null both when there is no sketch and when signing one
                  // failed, and telling the second "no concept sketch yet" is a
                  // lie the person cannot act on.
                  hasSketch={video.thumbnail_concept_path !== null}
                  savedTitle={video.title}
                  // The preview draws the *concept*; the shipped image files
                  // are one tab along, and the rendering has to say which of
                  // the two it is holding — BRIEF.md principle 2.
                  thumbnailsHref={`/videos/${video.id}?section=thumbnails`}
                  shippedLabel={
                    shippedRole === null ? null : ROLE_LABEL[shippedRole]
                  }
                />
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
