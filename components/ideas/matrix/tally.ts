/**
 * The arithmetic behind the content-bucket matrix, with no database and no JSX
 * in it.
 *
 * Everything the grid draws is derived here: which video sits in which cell,
 * how many of them have ever been published, how heavy a cell is relative to
 * the heaviest one, and — the number with a definition worth protecting —
 * how much of a bucket's monthly quota this month has actually committed to.
 *
 * It is pure so that the two things most likely to be wrong can be tested
 * without a browser:
 *
 * 1. **"The current month"** is a calendar question asked of a `date` column,
 *    and the obvious implementations are wrong in ways that only show up on the
 *    first or the last day of a month, in a timezone nobody testing lives in.
 * 2. **The quota count** is not the cell count and not the bucket total.
 *    PLAN.md defines it exactly once — *"videos with `target_publish_date` in
 *    the current month per bucket"* — and that sentence is implemented here,
 *    once, rather than in the component that draws the bar.
 */

/* -------------------------------------------------------------------------- */
/* The month                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The half-open window `[start, next)` over `YYYY-MM-DD` strings, plus a label
 * for the heading.
 *
 * ## Why strings, and why UTC
 *
 * `videos.target_publish_date` is a Postgres `date`: a calendar day with no
 * time and no zone, which supabase-js hands back as `"2026-09-30"`. Parsing it
 * into a `Date` to compare it with `new Date()` is where the bugs are — the
 * parse lands at midnight *UTC*, the comparison happens in the server's local
 * zone, and the last day of the month stops counting somewhere west of
 * Greenwich. Comparing the strings lexicographically is exact, because
 * zero-padded ISO dates sort as dates.
 *
 * UTC is then the one arbitrary choice left, and it is the same one the board
 * already makes when it formats a target date (`timeZone: "UTC"`), so the
 * matrix and the card cannot disagree about which month a date is in.
 */
export interface MonthWindow {
  /** First day of the month, inclusive: `YYYY-MM-01`. */
  readonly start: string;
  /** First day of the *next* month, exclusive. */
  readonly next: string;
  /** "September 2026", for the heading that says what is being counted. */
  readonly label: string;
}

export function monthWindow(now: number): MonthWindow {
  const at = new Date(now);
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();

  const pad = (value: number) => String(value).padStart(2, "0");
  const start = `${year}-${pad(month + 1)}-01`;
  // `Date.UTC(2026, 12, 1)` is January 2027 — the rollover is the constructor's
  // job, not this function's.
  const nextAt = new Date(Date.UTC(year, month + 1, 1));
  const next = `${nextAt.getUTCFullYear()}-${pad(nextAt.getUTCMonth() + 1)}-01`;

  return {
    start,
    next,
    label: new Intl.DateTimeFormat("en-GB", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(Date.UTC(year, month, 1)),
  };
}

/** Is this `YYYY-MM-DD` inside the window? `null` (no target date) never is. */
export function inMonth(date: string | null, month: MonthWindow): boolean {
  if (date === null) return false;
  return date >= month.start && date < month.next;
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

/** A bucket on one axis, as the grid needs it. */
export interface MatrixBucket {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  /** `buckets.monthly_quota`; null means this bucket has no target at all. */
  readonly monthlyQuota: number | null;
}

/**
 * A video, reduced to what the matrix is about.
 *
 * Archived videos are filtered out by the reader before they get here: a shelved
 * idea is not an investment in a pillar, and counting one would make "where am I
 * over-invested" answer with work that is not happening.
 */
export interface MatrixVideo {
  readonly id: string;
  readonly title: string;
  readonly verticalId: string | null;
  readonly horizontalId: string | null;
  readonly targetPublishDate: string | null;
  /** Set by `move_video` on first entry to Published; null while unpublished. */
  readonly publishedAt: string | null;
  /** The name of the stage it is sitting in, for the drill-down list. */
  readonly stageName: string | null;
}

/* -------------------------------------------------------------------------- */
/* Outputs                                                                     */
/* -------------------------------------------------------------------------- */

export interface CellTally {
  readonly verticalId: string;
  readonly horizontalId: string;
  readonly count: number;
  /** How many of them have been published. Zero is the interesting number. */
  readonly published: number;
  /** The videos themselves, newest-looking order left to the caller's query. */
  readonly videos: readonly MatrixVideo[];
}

export interface BucketTally {
  readonly bucket: MatrixBucket;
  /**
   * Every non-archived video carrying this bucket, whatever it carries on the
   * other axis. This is the over-investment number, and it is deliberately
   * **not** the sum of the row's cells: a video with a pillar and no format is
   * an investment in that pillar and sits in no cell. `offGrid` below says how
   * many such videos there are, so the two numbers never have to be guessed at.
   */
  readonly total: number;
  /**
   * PLAN.md's quota count: videos in this bucket whose `target_publish_date`
   * falls in the current month. Present whether or not there is a quota — a
   * bucket with no quota still gets to say how much of this month it is.
   */
  readonly thisMonth: number;
}

export interface MatrixTally {
  readonly month: MonthWindow;
  readonly verticals: readonly BucketTally[];
  readonly horizontals: readonly BucketTally[];
  /** Keyed by `cellKey(verticalId, horizontalId)`; absent means empty. */
  readonly cells: ReadonlyMap<string, CellTally>;
  /** The heaviest cell, so a bar can be drawn relative to something real. */
  readonly heaviest: number;
  /** Videos sitting in a cell — the grid's own total. */
  readonly onGrid: number;
  /** Videos missing a pillar, a format, or both. They sit in no cell. */
  readonly offGrid: number;
}

/** The one spelling of a cell's identity. Used as a map key and in the URL. */
export function cellKey(verticalId: string, horizontalId: string): string {
  return `${verticalId}:${horizontalId}`;
}

/* -------------------------------------------------------------------------- */
/* The tally                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Count everything the grid draws, in one pass over the videos.
 *
 * A video whose `vertical_id` names a bucket this channel does not have cannot
 * happen — the three-column composite FK in `0001_init.sql` binds each id to
 * this channel *and* to the right axis — but the tally still only credits ids
 * it was given, so a stale read can make a cell disappear and never invent one.
 */
export function buildTally(input: {
  verticals: readonly MatrixBucket[];
  horizontals: readonly MatrixBucket[];
  videos: readonly MatrixVideo[];
  month: MonthWindow;
}): MatrixTally {
  const { month } = input;
  const verticalIds = new Set(input.verticals.map((bucket) => bucket.id));
  const horizontalIds = new Set(input.horizontals.map((bucket) => bucket.id));

  const cells = new Map<
    string,
    { verticalId: string; horizontalId: string; count: number; published: number; videos: MatrixVideo[] }
  >();
  const bucketTotals = new Map<string, number>();
  const bucketThisMonth = new Map<string, number>();

  let onGrid = 0;
  let offGrid = 0;

  const credit = (map: Map<string, number>, id: string) => {
    map.set(id, (map.get(id) ?? 0) + 1);
  };

  for (const video of input.videos) {
    const vertical =
      video.verticalId !== null && verticalIds.has(video.verticalId)
        ? video.verticalId
        : null;
    const horizontal =
      video.horizontalId !== null && horizontalIds.has(video.horizontalId)
        ? video.horizontalId
        : null;

    // The per-bucket numbers are per bucket, not per cell: a video with a
    // pillar and no format still counts towards that pillar's quota, which is
    // what "2 book reviews this month" means to the person who set it.
    const dueThisMonth = inMonth(video.targetPublishDate, month);
    if (vertical !== null) {
      credit(bucketTotals, vertical);
      if (dueThisMonth) credit(bucketThisMonth, vertical);
    }
    if (horizontal !== null) {
      credit(bucketTotals, horizontal);
      if (dueThisMonth) credit(bucketThisMonth, horizontal);
    }

    if (vertical === null || horizontal === null) {
      offGrid += 1;
      continue;
    }

    onGrid += 1;
    const key = cellKey(vertical, horizontal);
    let cell = cells.get(key);
    if (!cell) {
      cell = { verticalId: vertical, horizontalId: horizontal, count: 0, published: 0, videos: [] };
      cells.set(key, cell);
    }
    cell.count += 1;
    if (video.publishedAt !== null) cell.published += 1;
    cell.videos.push(video);
  }

  let heaviest = 0;
  for (const cell of cells.values()) {
    if (cell.count > heaviest) heaviest = cell.count;
  }

  const tallyOf = (bucket: MatrixBucket): BucketTally => ({
    bucket,
    total: bucketTotals.get(bucket.id) ?? 0,
    thisMonth: bucketThisMonth.get(bucket.id) ?? 0,
  });

  return {
    month,
    verticals: input.verticals.map(tallyOf),
    horizontals: input.horizontals.map(tallyOf),
    cells,
    heaviest,
    onGrid,
    offGrid,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading the tally                                                           */
/* -------------------------------------------------------------------------- */

/** The cell at an intersection, or a zero one. Never undefined at a call site. */
export function cellAt(
  tally: MatrixTally,
  verticalId: string,
  horizontalId: string,
): CellTally {
  return (
    tally.cells.get(cellKey(verticalId, horizontalId)) ?? {
      verticalId,
      horizontalId,
      count: 0,
      published: 0,
      videos: [],
    }
  );
}

/**
 * How wide the weight bar in a cell is, as a percentage of the heaviest cell.
 *
 * The bar is the part of "see where you are over-invested" that is not a
 * number: a row of `4 1 0 2 0 0 1 0` reads as digits, one per cell, and the eye
 * has to do the comparing. A length does the comparing for it — and a length is
 * not a hue, which is the constraint BRIEF.md puts on every signal in this app.
 *
 * Anything present gets at least a visible sliver, so "one" never renders as
 * "none".
 */
export function weightPercent(count: number, heaviest: number): number {
  if (count <= 0 || heaviest <= 0) return 0;
  return Math.max(12, Math.round((count / heaviest) * 100));
}

/**
 * How full a quota bar is, clamped to 100.
 *
 * Over-quota is still a full bar: the bar says "this month is committed", and
 * the words beside it say by how much. A bar that overflowed its track would be
 * the only element in the product that draws outside its own box.
 */
export function quotaPercent(count: number, quota: number): number {
  if (quota <= 0) return 0;
  return Math.min(100, Math.round((count / quota) * 100));
}
