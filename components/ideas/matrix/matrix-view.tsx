import { Matrix, MatrixLegend } from "./matrix";
import { CellPanel } from "./cell-panel";
import { NoVerticals } from "./no-verticals";
import { readTimeZone } from "@/lib/time-zone-data";
import {
  buildTally,
  cellAt,
  monthWindow,
  type MatrixBucket,
  type MatrixVideo,
} from "./tally";
import { readPaged } from "@/lib/paged";
import type { createClient } from "@/lib/supabase/server";
import { readClock } from "@/lib/request-clock";

/**
 * `/c/[slug]/ideas?view=matrix` — the content-bucket matrix.
 *
 * BRIEF.md: *"each channel defines 3–5 verticals (topic pillars) and 8–12
 * horizontals (formats). An idea can be tagged with one of each. Matrix view
 * where each empty cell is a prompt for a new idea."* The last clause is the
 * feature: a grid that only reported counts would have drawn the same numbers
 * and missed it entirely, which is why the empty cell is the component with the
 * most care in it (`capture-cell.tsx`) and the populated one is a count and a
 * link.
 *
 * ## What it counts, and why it is not only ideas
 *
 * Every non-archived video in the channel, at whatever stage — not only the
 * ones still in the Idea stage that `components/ideas/list/**` calls the bank.
 *
 * The reason is the question the matrix is for: *where am I over-invested, and
 * where have I never published*. A pillar with six published videos and no
 * ideas left is the most invested pillar on the channel; counting only unstarted
 * ideas would draw it as empty and invite a seventh. Archived rows are excluded
 * for the mirror-image reason — a shelved idea is not an investment.
 *
 * The consequence, stated so nobody has to discover it: the number in a cell is
 * **not** the number of rows the idea-bank list shows for the same two buckets,
 * because that list is the Idea stage alone. Three things keep that from
 * reading as a disagreement rather than a difference of scope:
 *
 * - each cell says "3 videos" rather than "3 ideas", and its drill-down names
 *   the stage each one is in;
 * - the drill-down also says how many of them are still in the bank, and links
 *   there with both bucket filters already set
 *   (`components/ideas/list/url.ts` builds the address);
 * - and *which* videos are in a bucket is decided by one function for both
 *   pages — `bucketOn` in `lib/buckets.ts`, which `tally.ts` and the bank's
 *   `filtering.ts` both call. `components/ideas/agreement.test.ts` runs one
 *   fixture through both and asserts they name the same rows.
 *
 * ## The reads
 *
 * Four, all RLS-scoped, none of them a join. `videos` has two foreign keys to
 * `stages` (the tenant one and the channel one), so a PostgREST embed for the
 * stage name would be ambiguous — the board's file makes the same note and
 * takes the same way out.
 */
export async function MatrixView({
  supabase,
  channel,
  cell,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  channel: { id: string; name: string; slug: string };
  /** `?cell=<verticalId>:<horizontalId>` — which cell's list is open. */
  cell: string | null;
}) {
  const { data: bucketRows, error: bucketsError } = await supabase
    .from("buckets")
    .select("id, axis, name, position, monthly_quota")
    .eq("channel_id", channel.id)
    .order("position", { ascending: true });

  if (bucketsError) {
    throw new Error(
      `Could not load the buckets for ${channel.slug}: ${bucketsError.message}`,
    );
  }

  const verticals: MatrixBucket[] = [];
  const horizontals: MatrixBucket[] = [];
  for (const bucket of bucketRows) {
    const entry: MatrixBucket = {
      id: bucket.id,
      name: bucket.name,
      position: bucket.position,
      monthlyQuota: bucket.monthly_quota,
    };
    if (bucket.axis === "vertical") verticals.push(entry);
    else if (bucket.axis === "horizontal") horizontals.push(entry);
  }

  const { data: stageRows, error: stagesError } = await supabase
    .from("stages")
    .select("id, name, kind")
    .eq("channel_id", channel.id);

  if (stagesError) {
    throw new Error(
      `Could not load the stages for ${channel.slug}: ${stagesError.message}`,
    );
  }
  const stageNames = new Map(stageRows.map((stage) => [stage.id, stage.name]));

  /*
    Which stage is the bank.

    `kind` and not the name, for the reason every other branch in this app keys
    on `kind`: Idea can be renamed in settings, and a page that looked for the
    word would stop agreeing with `/c/[slug]/ideas` the moment somebody did.
    A channel whose Idea stage has been disabled still has a bank — the list
    route makes the same point at more length — so `is_enabled` is not consulted
    here either.
  */
  const ideaStageId =
    stageRows.find((stage) => stage.kind === "idea")?.id ?? null;

  /*
    Paged, not `.limit(n)`.

    A `.limit(2000)` here read as a bound and was not one: PostgREST caps every
    read at `db-max-rows` (1000, pinned identically by the dev stack), silently
    — a 200, a thousand rows, `content-range: 0-999/*`. Every cell count, every
    row and column total, the weight bars and the quota meters are counts over
    these rows, so a truncated read would draw a whole grid of numbers that are
    each the truth about the newest thousand videos while claiming to be the
    truth about the channel. `lib/paged.ts` reads all of them.
  */
  const videoRows = await readPaged(`videos for ${channel.slug}`, (from, to) =>
    supabase
      .from("videos")
      // One literal on one line: supabase-js types the result from the select
      // string, and a concatenation stops being a literal type to read.
      // prettier-ignore
      .select("id, title, stage_id, vertical_id, horizontal_id, target_publish_date, published_at, created_at")
      .eq("channel_id", channel.id)
      .is("archived_at", null)
      // Newest first, with `id` as the tiebreak: paging over an order that is
      // not total can repeat one row and skip another.
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to),
  );

  const videos: MatrixVideo[] = videoRows.map((video) => ({
    id: video.id,
    title: video.title,
    verticalId: video.vertical_id,
    horizontalId: video.horizontal_id,
    targetPublishDate: video.target_publish_date,
    publishedAt: video.published_at,
    stageName: stageNames.get(video.stage_id) ?? null,
    // Archived rows never reach here (the query excludes them), which is the
    // other half of what the bank means by "in the bank".
    inBank: ideaStageId !== null && video.stage_id === ideaStageId,
  }));

  /*
    The page's one clock read. This is an async Server Component on a dynamic
    route (it reads cookies through `requireUser` upstream), so it runs once per
    request: the month in the heading, the month the quota bars count and the
    month named in the legend are all the same month by construction.
  */
  const now = await readClock();
  // "This month" is the month of the user's today (M10), read once.
  const { zone } = await readTimeZone();

  const tally = buildTally({
    verticals,
    horizontals,
    videos,
    month: monthWindow(now, zone),
  });

  const header = (
    <div className="flex flex-col gap-1">
      <h1 className="font-display text-[22px] leading-tight font-semibold tracking-tight">
        {channel.name} — the matrix
      </h1>
      <p className="max-w-prose text-[13px] text-muted">
        Topic pillars down, formats across. An empty cell is an idea you have
        not had yet.
      </p>
    </div>
  );

  // No pillars (the seed leaves them empty on purpose) — or no formats, if they
  // have been deleted. Either way there is no grid to draw, and drawing one
  // anyway is the thing this branch exists to refuse.
  if (verticals.length === 0 || horizontals.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <NoVerticals
          channelSlug={channel.slug}
          verticals={tally.verticals}
          horizontals={tally.horizontals}
          monthLabel={tally.month.label}
        />
      </div>
    );
  }

  const open = readCell(cell, verticals, horizontals);

  return (
    <div className="flex flex-col gap-5">
      {header}

      <Matrix
        channel={channel}
        tally={tally}
        openKey={open === null ? null : `${open.vertical.id}:${open.horizontal.id}`}
      />

      <MatrixLegend monthLabel={tally.month.label} />

      {/*
        The arithmetic the grid cannot show. A video with a pillar and no format
        (or neither) sits in no cell, so the cells do not add up to the bank —
        and a page whose numbers do not add up, without saying why, is a page
        that gets mistrusted. It is also, quietly, a prompt: those are the
        videos one click away from being on the grid.
      */}
      {tally.offGrid > 0 ? (
        <p data-testid="matrix-off-grid" data-count={tally.offGrid} className="text-[12px] text-muted">
          <span className="font-mono">{tally.offGrid}</span>{" "}
          {tally.offGrid === 1 ? "video is" : "videos are"} not on the grid:{" "}
          {tally.offGrid === 1 ? "it is" : "they are"} missing a pillar, a
          format, or both. The{" "}
          <span className="font-mono">{tally.onGrid}</span> in the cells above{" "}
          {tally.onGrid === 1 ? "carries" : "carry"} one of each.
        </p>
      ) : null}

      {open ? (
        <CellPanel
          channelSlug={channel.slug}
          vertical={open.vertical}
          horizontal={open.horizontal}
          cell={cellAt(tally, open.vertical.id, open.horizontal.id)}
        />
      ) : null}
    </div>
  );
}

/**
 * `?cell=` as a pair of buckets, or nothing.
 *
 * A parameter out of a URL is a string somebody can type, so it is resolved
 * against the buckets this channel actually has on the axes they actually
 * belong to. A stale or invented pair opens no panel rather than rendering an
 * empty one titled with two ids.
 */
function readCell(
  value: string | null,
  verticals: readonly MatrixBucket[],
  horizontals: readonly MatrixBucket[],
): { vertical: MatrixBucket; horizontal: MatrixBucket } | null {
  if (!value) return null;
  const [verticalId, horizontalId] = value.split(":");
  const vertical = verticals.find((bucket) => bucket.id === verticalId);
  const horizontal = horizontals.find((bucket) => bucket.id === horizontalId);
  if (!vertical || !horizontal) return null;
  return { vertical, horizontal };
}
