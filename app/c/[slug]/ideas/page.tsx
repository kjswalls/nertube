import { notFound } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { IdeaList } from "@/components/ideas/list/idea-list";
import type { Idea, IdeaBucket } from "@/components/ideas/list/types";
import { MatrixView } from "@/components/ideas/matrix/matrix-view";
import { IdeasViewSwitch } from "@/components/ideas/matrix/view-switch";
import { formatAge } from "@/components/video-detail/age";
import { requireUser } from "@/lib/supabase/require-user";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return { title: `${slug} · ideas · NerTube` };
}

/**
 * `/c/[slug]/ideas` — the idea bank for one channel.
 *
 * An idea IS a video in the Idea stage, so this page is one query against
 * `videos` with `stage_id` pinned to the channel's Idea stage. There is no
 * separate table, no join to fake one, and nothing here can show a row the
 * board would not also call an idea.
 *
 * ## What the server does and what the browser does
 *
 * The server reads and does the clock arithmetic; the browser filters. That
 * split is the same one the board makes, and for the same two reasons: an age
 * computed in a client component renders differently on the two sides of
 * hydration, and a filter that costs a round trip is a filter nobody uses while
 * typing. PLAN.md's own sizing is *one user, hundreds of rows*, so the whole
 * bank is sent once and narrowed in memory.
 *
 * ## Two clocks, deliberately
 *
 * The order is `created_at` — newest **captured** first, which is what a bank
 * is expected to look like. The age is `stage_entered_at`, which is what "how
 * long it has been sitting" actually means: for a captured idea the two stamps
 * are the same moment, and for a video that was pushed back down to Idea the
 * second one is the honest answer while the first one is still the right sort
 * key. Both are on the row — the age reads on the chip and the capture date is
 * its tooltip.
 *
 * ## Archived rows are read, not filtered out
 *
 * The query deliberately does **not** end in `.is("archived_at", null)`. An
 * archived idea is dismissed, not deleted, and the list's "Show archived"
 * toggle has to be able to bring it back without a second round trip. Scope is
 * decided in `components/ideas/list/filtering.ts`, where it is unit-tested.
 */
export default async function IdeasPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  /*
    The seam the matrix lands on. `?view=matrix` is PLAN.md's own spelling —
    one route, two ways of looking at the same buckets — and the switch is a
    single branch after the channel lookup, so the bank's reads are not paid
    for by a request that wanted the grid. `components/ideas/matrix/**` owns
    everything past that branch; `?cell=` is the matrix's own parameter and is
    handed straight through.
  */
  searchParams: Promise<{ view?: string | string[]; cell?: string | string[] }>;
}) {
  const { slug } = await params;
  const { view, cell } = await searchParams;
  const { supabase } = await requireUser();

  // RLS scopes this to the signed-in user, so somebody else's slug is
  // indistinguishable from one that was never issued. Both are a 404.
  const { data: channel } = await supabase
    .from("channels")
    .select("id, name, slug")
    .eq("slug", slug)
    .maybeSingle();

  if (!channel) {
    notFound();
  }

  if (first(view) === "matrix") {
    return (
      <AppShell currentSlug={slug} section="ideas" gutter="reading">
        <div className="flex flex-col gap-4">
          <IdeasViewSwitch channelSlug={channel.slug} current="matrix" />
          <MatrixView
            supabase={supabase}
            channel={channel}
            cell={first(cell) ?? null}
          />
        </div>
      </AppShell>
    );
  }

  const { data: stageRows, error: stagesError } = await supabase
    .from("stages")
    .select("id, name, kind, is_enabled")
    .eq("channel_id", channel.id);

  if (stagesError) {
    throw new Error(
      `Could not load the stages for ${slug}: ${stagesError.message}`,
    );
  }

  /*
    The Idea stage, enabled or not.

    A channel that has switched its Idea column off still has a bank — the
    videos are in that stage whatever the board draws — and a bank that emptied
    itself because of a display setting would be the worst possible way to
    discover the setting. Core stages cannot be deleted (the delete policy is
    limited to `kind is null`), so this is present unless the database has been
    edited by hand.
  */
  const ideaStage = stageRows.find((stage) => stage.kind === "idea") ?? null;

  /*
    Where Promote sends a row. `move_video` refuses a disabled stage, so a
    channel with Packaging switched off gets a button that says why rather than
    one that fails on click.
  */
  const packagingStage =
    stageRows.find((stage) => stage.kind === "packaging") ?? null;

  const promoteStage: { id: string; name: string } | { id: null; reason: string } =
    packagingStage === null
      ? { id: null, reason: "This channel has no Packaging stage to promote into." }
      : packagingStage.is_enabled
        ? { id: packagingStage.id, name: packagingStage.name }
        : {
            id: null,
            reason: `${packagingStage.name} is switched off for this channel, so there is nowhere to promote to. Turn it back on in settings.`,
          };

  const { data: bucketRows, error: bucketsError } = await supabase
    .from("buckets")
    .select("id, axis, name, position")
    .eq("channel_id", channel.id)
    .order("position", { ascending: true });

  if (bucketsError) {
    throw new Error(
      `Could not load the buckets for ${slug}: ${bucketsError.message}`,
    );
  }

  const verticals: IdeaBucket[] = [];
  const horizontals: IdeaBucket[] = [];
  const bucketName = new Map<string, string>();
  for (const bucket of bucketRows) {
    bucketName.set(bucket.id, bucket.name);
    if (bucket.axis === "vertical") {
      verticals.push({ id: bucket.id, name: bucket.name });
    } else if (bucket.axis === "horizontal") {
      horizontals.push({ id: bucket.id, name: bucket.name });
    }
  }

  let ideas: Idea[] = [];

  if (ideaStage) {
    const { data: videoRows, error: videosError } = await supabase
      .from("videos")
      // One literal on one line: supabase-js types the result from the select
      // string, and a concatenation stops being a literal type to read.
      // prettier-ignore
      .select("id, title, one_line_hook, tags, vertical_id, horizontal_id, created_at, stage_entered_at, archived_at")
      .eq("channel_id", channel.id)
      .eq("stage_id", ideaStage.id)
      .order("created_at", { ascending: false })
      .limit(2000);

    if (videosError) {
      throw new Error(
        `Could not load the ideas for ${slug}: ${videosError.message}`,
      );
    }

    /*
      The page's one clock read. This is an async Server Component on a dynamic
      route (it reads cookies through `requireUser`), so it runs once per
      request and every age on the page is measured from the same instant.
    */
    // eslint-disable-next-line react-hooks/purity
    const now = Date.now();

    ideas = videoRows.map((video) => ({
      id: video.id,
      title: video.title,
      oneLineHook: video.one_line_hook,
      tags: video.tags,
      verticalId: video.vertical_id,
      horizontalId: video.horizontal_id,
      verticalName:
        video.vertical_id === null
          ? null
          : (bucketName.get(video.vertical_id) ?? null),
      horizontalName:
        video.horizontal_id === null
          ? null
          : (bucketName.get(video.horizontal_id) ?? null),
      ageLabel: formatAge(video.stage_entered_at, now),
      capturedLabel: formatCaptureDate(video.created_at),
      archivedAt: video.archived_at,
      capturedMs: Date.parse(video.created_at),
    }));
  }

  return (
    <AppShell currentSlug={slug} section="ideas" gutter="reading">
      <div className="mb-4">
        <IdeasViewSwitch channelSlug={channel.slug} current="list" />
      </div>
      <IdeaList
        channelName={channel.name}
        channelSlug={channel.slug}
        ideas={ideas}
        verticals={verticals}
        horizontals={horizontals}
        promoteStage={promoteStage}
      />
    </AppShell>
  );
}

/**
 * A query parameter as one value. Next hands back `string | string[]`, and
 * `?view=matrix&view=list` is a URL somebody can type.
 */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `created_at` as a date, in UTC with a fixed locale, so the server's string
 * and the browser's are the same string.
 */
function formatCaptureDate(value: string): string | null {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}
