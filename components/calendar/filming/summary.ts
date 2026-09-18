import { compareDateColumns } from "@/lib/calendar-dates";
import { kindOrder, type StageKind } from "@/lib/defaults";

/**
 * What a filming day is *now* — the answer to PLAN.md's M6 review note:
 *
 * > *a filming day whose video left Filming still renders sanely.*
 *
 * ## The case this file exists for
 *
 * A video linked to Saturday's shoot is in Filming on Friday, is filmed on
 * Saturday, and is in Editing on Sunday. **That is the success case**, not an
 * error and not an inconsistency, and it is what every filming day looks like a
 * week after it happened. Two tempting implementations get it wrong:
 *
 * - *Drop the videos that are no longer in Filming.* Last month's shoot then
 *   renders as an empty day, which is a lie about a day on which four videos
 *   were filmed.
 * - *Render the link as though nothing had changed.* The day then says "4 to
 *   shoot" for ever, which is stale and, worse, indistinguishable from a day
 *   that genuinely did not happen.
 *
 * So the link is kept and the **current stage of each video is what is drawn**.
 * A day is a record of what was shot, and a video's stage is the fact that says
 * whether it was.
 *
 * ## Colour means something
 *
 * One situation here needs attention and gets it: a day that has **passed**
 * with videos still sitting in Filming. That is the batch day that did not
 * happen, and it is the only state on the calendar that is asking for a
 * decision. Everything else — upcoming days, finished days, a day whose videos
 * have all moved on — is furniture, and draws in the quiet tone. A calendar is
 * the easiest place in an app to end up with a bag of highlighters.
 *
 * Pure, and unit-tested in `summary.test.ts`: it takes the day, the videos and
 * today, and reads no clock of its own.
 */

/** Where one video on a filming day has got to. */
export type FilmingVideoStatus =
  /** In Filming now: this is what the day is for. */
  | "to_shoot"
  /** Past Filming: shot, and the day did its job. */
  | "moved_on"
  /** Before Filming — scripting, packaging, still an idea. */
  | "not_ready"
  /** Archived since. Still on the day, because it was still filmed. */
  | "archived"
  /** In a stage with no `kind` — a custom stage from settings (M7). */
  | "elsewhere";

/** The one thing every caller needs to know about a video on a day. */
export interface DayVideo {
  readonly stageKind: StageKind | null;
  readonly archived: boolean;
}

/**
 * Where a video sits relative to the shoot.
 *
 * Compared through `kindOrder` over `CORE_KIND_ORDER`, never through
 * `stages.position`: position is display order and settings can change it, and
 * "has this been filmed yet" is a question about the pipeline, not about the
 * board's layout. This is the same rule the TTH gate and `[`/`]` follow.
 */
export function statusOf(video: DayVideo): FilmingVideoStatus {
  // Checked first: an archived video's stage is whatever it was when it was
  // archived, and "archived" is the more useful fact about it.
  if (video.archived) return "archived";
  if (video.stageKind === null) return "elsewhere";

  const delta = kindOrder(video.stageKind) - kindOrder("filming");
  if (delta === 0) return "to_shoot";
  return delta > 0 ? "moved_on" : "not_ready";
}

export interface FilmingDaySummary {
  readonly total: number;
  readonly toShoot: number;
  readonly movedOn: number;
  readonly notReady: number;
  readonly archived: number;
  readonly elsewhere: number;
  /** The day is strictly before today. */
  readonly past: boolean;
  /** One line describing the day as it stands. */
  readonly headline: string;
  /**
   * `attention` for exactly one case — a day that has passed with videos still
   * in Filming. See the note above.
   */
  readonly tone: "quiet" | "attention";
}

/**
 * The day, in one sentence and six numbers.
 *
 * `today` is passed in rather than read: the server computes it once per
 * request (`todayColumn(Date.now())`) so the summary is identical on both sides
 * of hydration, and the unit suite can stand on either side of midnight.
 */
export function summarise(
  videos: readonly DayVideo[],
  { onDate, today }: { onDate: string; today: string },
): FilmingDaySummary {
  const counts = {
    to_shoot: 0,
    moved_on: 0,
    not_ready: 0,
    archived: 0,
    elsewhere: 0,
  } satisfies Record<FilmingVideoStatus, number>;

  for (const video of videos) counts[statusOf(video)] += 1;

  const total = videos.length;
  const past = compareDateColumns(onDate, today) < 0;
  const pending = counts.to_shoot + counts.not_ready;

  return {
    total,
    toShoot: counts.to_shoot,
    movedOn: counts.moved_on,
    notReady: counts.not_ready,
    archived: counts.archived,
    elsewhere: counts.elsewhere,
    past,
    headline: headlineFor({ total, past, counts }),
    // The one case that is asking for a decision: the day has gone and the
    // videos it was booked for have not been filmed.
    tone: past && pending > 0 ? "attention" : "quiet",
  };
}

function headlineFor({
  total,
  past,
  counts,
}: {
  total: number;
  past: boolean;
  counts: Record<FilmingVideoStatus, number>;
}): string {
  if (total === 0) {
    return past
      ? "No videos were attached to this day."
      : "No videos attached yet.";
  }

  const videos = total === 1 ? "1 video" : `${total} videos`;
  const pending = counts.to_shoot + counts.not_ready;

  if (past) {
    if (pending === 0) {
      // The ordinary end state of every day that happened.
      return counts.archived === total
        ? `${videos}, since archived.`
        : `${videos}, filmed and moved on.`;
    }
    if (pending === total) {
      return `${videos} still waiting to be filmed. Did this day happen?`;
    }
    return `${counts.moved_on + counts.archived} of ${total} moved on; ${pending} still waiting to be filmed.`;
  }

  if (counts.to_shoot === total) {
    return `${videos} to shoot.`;
  }
  if (pending === 0) {
    return `${videos}, already past Filming.`;
  }

  const parts: string[] = [];
  if (counts.to_shoot > 0) parts.push(`${counts.to_shoot} to shoot`);
  if (counts.not_ready > 0) parts.push(`${counts.not_ready} not ready yet`);
  if (counts.moved_on > 0) parts.push(`${counts.moved_on} already moved on`);
  if (counts.archived > 0) parts.push(`${counts.archived} archived`);
  return `${videos}: ${parts.join(", ")}.`;
}

/** The words each status is drawn with, next to a video's own stage name. */
export const STATUS_LABEL: Record<FilmingVideoStatus, string> = {
  to_shoot: "to shoot",
  moved_on: "moved on",
  not_ready: "not ready",
  archived: "archived",
  elsewhere: "elsewhere",
};
