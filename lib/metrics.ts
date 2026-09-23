import { z } from "zod";
import { cleanProse } from "./text";

/**
 * The first twenty-four hours: what the numbers may be, and how they read.
 *
 * ## Why this is a module and not the top of `app/actions/metrics.ts`
 *
 * Because two surfaces log these numbers — the `/now` row and the video page's
 * Publish section — and PLAN.md's post-publish line is *one component renders
 * impressions and CTR as a pair; `logMetrics` rejects one without the other*.
 * "One component" and "one action" both need the same limits: the input's
 * `max`, the note's `maxLength`, the message shown when a half-filled pair is
 * refused. A `"use server"` file may only export async functions, so a constant
 * that a component needs cannot live there — and a constant copied into the
 * component is how the box starts accepting a number the action then refuses.
 *
 * So the rules are here, once. `app/actions/metrics.ts` is the only writer that
 * goes through them, exactly as `lib/video-fields.ts` is the only vocabulary
 * `updateVideo` speaks.
 *
 * ## The one rule this file really has
 *
 * **Impressions and click-through are one value.** Written down four times now:
 *
 * - BRIEF.md, video detail page: *"Always display impressions and CTR together,
 *   never CTR alone."*
 * - PLAN.md, post-publish: *"`logMetrics` rejects one without the other."*
 * - `0001_init.sql`: `constraint videos_ctr_needs_impressions check
 *   ((first24_impressions is null) = (first24_ctr is null))`.
 * - `components/post-publish/metrics-pair.tsx`, which has no prop that could
 *   render one without the other.
 *
 * A rate without a denominator is not a measurement: 3.1% of ninety
 * impressions and 3.1% of ninety thousand are different facts, and the whole
 * post-publish loop — swap the thumbnail fast, or leave it alone — is a
 * decision made on that difference.
 *
 * The CHECK is the guard. The schema below is not a second guard pretending to
 * be one: it exists so the refusal arrives in the browser as a sentence about
 * impressions instead of as a Postgres constraint name after a round trip.
 * `metricsRefusal()` at the bottom is what happens when something gets past it
 * anyway.
 */

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/** Bigger than any channel this tool is for, and small enough to catch a paste. */
export const MAX_IMPRESSIONS = 1_000_000_000;

/**
 * The new-viewers note is a sentence — "half of these were not subscribed" —
 * not a report. The column is unbounded `text`; this is the field's manners.
 */
export const MAX_NEW_VIEWERS_NOTE = 1_000;

/* -------------------------------------------------------------------------- */
/* The numbers                                                                 */
/* -------------------------------------------------------------------------- */

/** A count of people, in the same shape for both columns that hold one. */
function count(what: string) {
  return z
    .number()
    .int(`${what} is a whole number.`)
    .min(0, `${what} cannot be negative.`)
    .max(MAX_IMPRESSIONS, `That is not a ${what.toLowerCase()} count.`);
}

export const ImpressionsSchema = count("Impressions");

/**
 * `numeric(5,2)` between 0 and 100 — the column's own CHECK, in the browser.
 *
 * A CTR is typed as a percentage because that is how YouTube Studio shows it:
 * `4.8`, not `0.048`. Nothing here multiplies or divides, so the two can never
 * drift apart.
 */
export const CtrSchema = z
  .number()
  .min(0, "CTR is a percentage between 0 and 100.")
  .max(100, "CTR is a percentage between 0 and 100 — Studio shows 4.8, not 0.048.")
  // Two decimals is what the column stores; rounding here rather than letting
  // Postgres do it means what comes back is what was sent.
  .transform((value) => Math.round(value * 100) / 100);

/** Views: genuinely optional, and the only part of the triplet that is. */
export const ViewsSchema = count("Views").nullable();

/** `""` is not a note. NULL is. */
export const NewViewersNoteSchema = z
  .union([z.string(), z.null()])
  .transform((value) => (value === null ? null : cleanProse(value).trim()))
  .transform((value) => (value === "" ? null : value))
  .refine((value) => value === null || value.length <= MAX_NEW_VIEWERS_NOTE, {
    message: `Keep the new-viewers note to ${MAX_NEW_VIEWERS_NOTE} characters — it is a sentence, not a report.`,
  });

/**
 * The one schema `logMetrics` parses.
 *
 * `impressions` and `ctr` are both required and neither is nullable, which is
 * the pair rule expressed in the type: there is no parse of this object that
 * produces one without the other. `views` and `newViewersNote` may be absent
 * (leave the column alone) or null (clear it).
 */
export const LogMetricsSchema = z.object({
  videoId: z.uuid(),
  impressions: ImpressionsSchema,
  ctr: CtrSchema,
  views: ViewsSchema.optional(),
  newViewersNote: NewViewersNoteSchema.optional(),
  /**
   * The `updated_at` the page computed this save against, or `null` for a row
   * that has never been written. Absent means "write unconditionally", which is
   * what `/now` means: it holds no editors over the rest of the row.
   *
   * Same mechanism as `updateVideo` — see `components/video-version.tsx`.
   */
  expectedUpdatedAt: z.union([z.string(), z.null()]).optional(),
});

export type LogMetricsInput = z.input<typeof LogMetricsSchema>;

/**
 * What the browser says when the pair is half-filled.
 *
 * One sentence, in one place, because the component says it before sending and
 * the action says it if something sends anyway.
 */
export const PAIR_REQUIRED =
  "Both numbers, or neither — a click-through with no impressions is not a measurement.";

/* -------------------------------------------------------------------------- */
/* What the database says, in words                                            */
/* -------------------------------------------------------------------------- */

/**
 * A Postgres refusal, as a sentence someone can act on.
 *
 * The CHECKs on `videos` are the guard for these columns — not the schema
 * above, which exists to keep the round trip from being the first thing that
 * says no. When one of them fires anyway it means a write reached the row by a
 * path the form does not own, and the honest thing is to name the rule rather
 * than to print a constraint name.
 */
export function metricsRefusal(message: string): string {
  if (message.includes("videos_ctr_needs_impressions")) return PAIR_REQUIRED;
  if (message.includes("first24_ctr")) {
    return "The database refused that click-through: it is a percentage between 0 and 100.";
  }
  if (message.includes("first24_impressions") || message.includes("first24_views")) {
    return "The database refused that count: impressions and views cannot be negative.";
  }
  return `Those numbers did not save: ${message}`;
}

/* -------------------------------------------------------------------------- */
/* How a measured number reads                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Impressions, grouped. Fixed locale on purpose: these strings are produced on
 * the server and hydrated in the browser, and `Intl` with no locale follows
 * whichever one the runtime happens to have.
 */
export function formatImpressions(value: number): string {
  return new Intl.NumberFormat("en-GB").format(Math.round(value));
}

/** A CTR as this app writes it: at most two decimals, no trailing zeros. */
export function formatCtr(value: number): string {
  return `${Number(value.toFixed(2))}`;
}

/* -------------------------------------------------------------------------- */
/* The swap verdict                                                            */
/* -------------------------------------------------------------------------- */

/** Where an expectation came from — the wording of the prompt depends on it. */
export type ExpectationSource =
  /** `channels.expected_ctr`, set deliberately in settings. */
  | "channel"
  /** The median first-24 CTR of this channel's last ten published videos. */
  | "median";

export interface Expectation {
  /** The number to compare against, or null when there is nothing to compare to. */
  readonly value: number | null;
  readonly source: ExpectationSource | null;
  /** How many past videos the median was taken over. 0 when it was not. */
  readonly sampleSize: number;
}

/** No expectation at all — a new channel, with nothing to judge a video by. */
export const NO_EXPECTATION: Expectation = {
  value: null,
  source: null,
  sampleSize: 0,
};

export type SwapVerdict =
  /** Below expectation. The prompt is urgent. */
  | { readonly kind: "below"; readonly expectation: number; readonly shortfall: number }
  /** At or above. The prompt still renders — it just is not shouting. */
  | { readonly kind: "met"; readonly expectation: number }
  /**
   * There is no expectation, so there is no verdict.
   *
   * PLAN.md: *`expectation = coalesce(channel.expected_ctr, median first24_ctr
   * of the channel's last 10 published)`; none → rule skipped*. Inventing a
   * number here (4%, say) would have the tool nagging about a video nobody can
   * judge yet, in the one place where acting fast on a wrong signal costs a
   * thumbnail swap.
   */
  | { readonly kind: "unknown" };

/**
 * Is this video underperforming?
 *
 * The comparison is `<`, the same one `lib/next-action.ts` rule 3 makes, so the
 * `/now` row and the page's prompt can never disagree about one video.
 */
export function swapVerdict(
  ctr: number | null,
  expectation: number | null,
): SwapVerdict {
  if (ctr === null || expectation === null || !Number.isFinite(expectation)) {
    return { kind: "unknown" };
  }
  return ctr < expectation
    ? {
        kind: "below",
        expectation,
        shortfall: Math.round((expectation - ctr) * 100) / 100,
      }
    : { kind: "met", expectation };
}
