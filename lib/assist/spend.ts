import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  firstOfMonth,
  formatDateColumn,
  formatMonth,
  monthInstants,
  shiftMonth,
  type TimeZone,
} from "@/lib/calendar-dates";
import type { Database } from "@/lib/database.types";
import type { AssistKind, CapReached } from "./types";

/**
 * What a real API call costs, and the monthly ceiling on it (M11).
 *
 * Three jobs, one module:
 *
 * 1. **Price a response.** {@link measureCall} turns the `usage` block of a
 *    Messages API response into token counts and a cost in integer
 *    micro-dollars, per the table below. `lib/assist/anthropic.ts` calls it on
 *    every response that comes back — answered, refused, or unreadable — and
 *    hands the result to whoever asked to be told (`onUsage`).
 * 2. **Read the month.** {@link readBudget} asks the database for this
 *    calendar month's spend (in the user's zone, via `lib/calendar-dates.ts`)
 *    and the cap, in one round trip (`assist_budget`, migration 0011).
 * 3. **Decide and say.** {@link isOverCap} and {@link capRefusalMessage}: the
 *    check the server action runs before every real call, and the sentence a
 *    refused call shows.
 *
 * `server-only` because it names models and prices, and PLAN.md's bundle check
 * (M8) greps `.next/static` for `claude-opus`: nothing a browser loads may
 * carry this table. Settings renders the numbers this produces, on the server.
 *
 * ## What is not counted
 *
 * The fixtures (`fake.ts`) and a reply pasted back from claude.ai cost this
 * account nothing, so neither records anything and neither is ever refused by
 * the cap. Only `anthropic.ts` produces a {@link MeasuredCall}.
 */

/* -------------------------------------------------------------------------- */
/* The price table                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Dollars per million tokens, input and output, as signed off for M11 (and
 * matching the bundled `claude-api` skill's model table, cached 2026-06-24).
 *
 * A dollar per million tokens is exactly a micro-dollar per token, which is
 * why the arithmetic below needs no division until the very end.
 */
export const PRICES_PER_MILLION: Readonly<
  Record<string, { readonly input: number; readonly output: number }>
> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 5, output: 25 },
};

/**
 * Writing to the prompt cache costs 1.25x an input token, reading from it
 * 0.1x — as hundredths, so every product stays an integer.
 *
 * Both are the signed-off flat multipliers. Two things are knowingly
 * conservative about them, and both err towards *over*-counting, which is the
 * safe direction for a ceiling: the skill lists Opus 5.5's cache read at
 * $0.20 (0.05x) and Fable 5.1's at $0.25 (0.025x), and a one-hour cache write
 * is 2x rather than 1.25x. None of it matters today — the app sends no
 * `cache_control` — but a cached call would read as slightly dearer than it
 * was billed, never cheaper.
 */
const HUNDREDTHS = { input: 100, cacheWrite: 125, cacheRead: 10, output: 100 } as const;

/**
 * The entry an unknown model is priced at: the most expensive one, never
 * zero. A model this table has never heard of — a new fallback target, a
 * renamed id — must not become a free call the cap cannot see.
 */
export const MOST_EXPENSIVE = Object.values(PRICES_PER_MILLION).reduce((worst, price) =>
  price.output > worst.output || (price.output === worst.output && price.input > worst.input)
    ? price
    : worst,
);

/** The price of one model, and whether it had to be assumed. */
export function priceFor(model: string): {
  readonly input: number;
  readonly output: number;
  readonly assumed: boolean;
} {
  const known = Object.hasOwn(PRICES_PER_MILLION, model) ? PRICES_PER_MILLION[model] : null;
  return known ? { ...known, assumed: false } : { ...MOST_EXPENSIVE, assumed: true };
}

/* -------------------------------------------------------------------------- */
/* Pricing a response                                                          */
/* -------------------------------------------------------------------------- */

export interface TokenCounts {
  /** Uncached input tokens (`input_tokens` — the API reports cache separately). */
  readonly input: number;
  readonly output: number;
  /** `cache_read_input_tokens`. */
  readonly cacheRead: number;
  /** `cache_creation_input_tokens`. */
  readonly cacheWrite: number;
}

/** One real call, priced. What `assist_usage` stores, minus who and when. */
export interface MeasuredCall {
  /** The model the request named. */
  readonly requestedModel: string;
  /** The model that produced the returned message (a fallback may differ). */
  readonly model: string;
  /** True when any billed attempt was priced at {@link MOST_EXPENSIVE}. */
  readonly priceAssumed: boolean;
  /** Summed over the attempts that were billed. */
  readonly tokens: TokenCounts;
  /** Integer micro-dollars, rounded up. */
  readonly costMicros: number;
}

/** The parts of a response this module reads. Structural, so no SDK import. */
export interface ResponseForPricing {
  readonly model?: string | null;
  readonly stop_reason?: string | null;
  readonly usage?: {
    readonly input_tokens?: number | null;
    readonly output_tokens?: number | null;
    readonly cache_read_input_tokens?: number | null;
    readonly cache_creation_input_tokens?: number | null;
    readonly iterations?: unknown;
  } | null;
}

/** One sampling attempt, as `usage.iterations` reports it (or the whole call). */
interface Attempt {
  readonly model: string;
  readonly tokens: TokenCounts;
}

/**
 * Price a response.
 *
 * ## Which tokens are billed
 *
 * With `fallbacks: "default"` one request can run more than one model: the
 * first declines, a substitute answers. What the installed SDK's types and the
 * bundled `claude-api` skill say about that (`shared/model-migration.md`,
 * "Billing"): **`usage.iterations` is the per-attempt source of truth, and the
 * top-level `usage` covers only the attempt that produced the returned
 * message.** Each attempt is billed at *its own* model's rates, and an attempt
 * that declined before producing any output is reported but not billed.
 *
 * So when `iterations` is present, every entry is priced by its own `model`
 * (a `message` entry's model may be null, meaning the one requested), and an
 * entry with no output that was followed by another hop — or that is the last
 * one on a response whose `stop_reason` is `refusal` — is left out. With no
 * `iterations`, the top-level block is the one attempt, and the same rule
 * applies to it.
 *
 * The cost is rounded **up** to a whole micro-dollar, once, at the end.
 */
export function measureCall(response: ResponseForPricing, requestedModel: string): MeasuredCall {
  const served =
    typeof response.model === "string" && response.model !== "" ? response.model : requestedModel;
  const refused = response.stop_reason === "refusal";

  const fromIterations = attemptsFrom(response.usage?.iterations, requestedModel);
  const attempts: Attempt[] =
    fromIterations.length > 0
      ? fromIterations
      : [{ model: served, tokens: countsOf(response.usage ?? {}) }];

  const last = attempts.length - 1;
  const billed = attempts.filter(
    (attempt, index) => !(attempt.tokens.output === 0 && (index < last || refused)),
  );

  let hundredths = 0;
  let assumed = false;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const attempt of billed) {
    const price = priceFor(attempt.model);
    assumed ||= price.assumed;
    hundredths +=
      attempt.tokens.input * price.input * HUNDREDTHS.input +
      attempt.tokens.cacheWrite * price.input * HUNDREDTHS.cacheWrite +
      attempt.tokens.cacheRead * price.input * HUNDREDTHS.cacheRead +
      attempt.tokens.output * price.output * HUNDREDTHS.output;
    tokens.input += attempt.tokens.input;
    tokens.output += attempt.tokens.output;
    tokens.cacheRead += attempt.tokens.cacheRead;
    tokens.cacheWrite += attempt.tokens.cacheWrite;
  }

  return {
    requestedModel,
    model: served,
    priceAssumed: assumed,
    tokens,
    costMicros: Math.ceil(hundredths / 100),
  };
}

/** Did anything in this call cost money? A call that billed nothing is not recorded. */
export function wasBilled(call: MeasuredCall): boolean {
  const { input, output, cacheRead, cacheWrite } = call.tokens;
  return call.costMicros > 0 || input + output + cacheRead + cacheWrite > 0;
}

function attemptsFrom(raw: unknown, requestedModel: string): Attempt[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      model:
        typeof entry.model === "string" && entry.model !== "" ? entry.model : requestedModel,
      tokens: countsOf(entry),
    }));
}

function countsOf(usage: Record<string, unknown>): TokenCounts {
  return {
    input: tokenCount(usage.input_tokens),
    output: tokenCount(usage.output_tokens),
    cacheRead: tokenCount(usage.cache_read_input_tokens),
    cacheWrite: tokenCount(usage.cache_creation_input_tokens),
  };
}

/** A count the API reported, or 0 for null, absent, negative or not a number. */
function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/* -------------------------------------------------------------------------- */
/* The month and the cap                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The cap a user who has never set one gets: ten dollars a calendar month.
 * Stated in Settings, beside the field, in these words' number.
 */
export const DEFAULT_CAP_DOLLARS = 10;

/** The largest cap the field (and `set_assist_cap`) accepts, in dollars. */
export const MAX_CAP_DOLLARS = 100_000;

export interface SpendBudget {
  /** This month's spend, integer micro-dollars. */
  readonly spendMicros: number;
  /** Real calls recorded this month. */
  readonly calls: number;
  /** Of those, how many were priced by assumption (an unknown model). */
  readonly assumedCalls: number;
  /**
   * The cap in force: `dollars` null means no cap. `source` says whether the
   * person chose it or it is {@link DEFAULT_CAP_DOLLARS} because they never
   * set one.
   */
  readonly cap: { readonly dollars: number | null; readonly source: "default" | "chosen" };
  /** The month, in the user's zone: its name and the day it starts again. */
  readonly month: { readonly label: string; readonly resets: string };
}

/** What `assist_budget` returns, as a row. */
interface BudgetRow {
  spend_micros: number | string | null;
  calls: number | null;
  assumed_calls: number | null;
  cap_set: boolean | null;
  cap_dollars: number | null;
}

/** The app's typed Supabase client, as the server action holds it. */
export type SpendClient = SupabaseClient<Database>;

/**
 * This calendar month's spend and the cap, for the signed-in user.
 *
 * "This month" is the month `now` falls in, in `zone` — the user's zone from
 * `profiles` (0010), or UTC when none is known — bounded by
 * `monthInstants` in `lib/calendar-dates.ts`, the app's one date
 * interpretation. Throws the database's message on a failed read; the caller
 * decides what a failed read means.
 */
export async function readBudget(
  supabase: SpendClient,
  now: number,
  zone: TimeZone,
): Promise<SpendBudget> {
  const window = monthInstants(now, zone);
  const { data, error } = await supabase.rpc("assist_budget", {
    p_from: new Date(window.from).toISOString(),
    p_to: new Date(window.to).toISOString(),
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as BudgetRow | undefined;

  return {
    spendMicros: Number(row?.spend_micros ?? 0),
    calls: row?.calls ?? 0,
    assumedCalls: row?.assumed_calls ?? 0,
    cap: row?.cap_set
      ? { dollars: row.cap_dollars ?? null, source: "chosen" }
      : { dollars: DEFAULT_CAP_DOLLARS, source: "default" },
    month: {
      label: formatMonth(window.month),
      resets: formatDateColumn(firstOfMonth(shiftMonth(window.month, 1)), "short") ?? "",
    },
  };
}

/**
 * At or over the cap? Checked before every real call. A cap of `$0` refuses
 * everything; no cap refuses nothing.
 *
 * Checked, not reserved: two calls that start together both see the spend
 * before either lands, so the month can pass the cap by one call's worth.
 * A call already in flight when the cap is crossed finishes and is recorded.
 * Both are in the README.
 */
export function isOverCap(budget: SpendBudget): boolean {
  return budget.cap.dollars !== null && budget.spendMicros >= budget.cap.dollars * 1_000_000;
}

/** The mean cost of a call this month, or null before there is one. */
export function meanCallMicros(budget: SpendBudget): number | null {
  return budget.calls > 0 ? Math.round(budget.spendMicros / budget.calls) : null;
}

/**
 * Micro-dollars as a person reads money: `$3.42`, `$1,204.00`. A non-zero
 * amount under half a cent says so rather than claiming `$0.00`.
 */
export function formatMicros(micros: number): string {
  const cents = Math.round(micros / 10_000);
  if (micros > 0 && cents === 0) return "under $0.01";
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Whole dollars, as the cap is written: `$10`, `$1,500`. */
export function formatCap(dollars: number): string {
  return `$${dollars.toLocaleString("en-US")}`;
}

/**
 * The sentence a call refused by the cap shows, in the panel. It names the
 * cap and the spend, says nothing was sent, and offers both ways on: raise the
 * cap in Settings (the panel draws that link beside it), or use Open in
 * Claude, which runs the same question on the person's own claude.ai
 * subscription and costs this account nothing.
 */
export function capRefusalMessage(budget: SpendBudget): string {
  const cap = budget.cap.dollars ?? 0;
  const whose = budget.cap.source === "default" ? "the default cap of" : "your cap of";
  return (
    `This month's API spending is ${formatMicros(budget.spendMicros)}, which has reached ` +
    `${whose} ${formatCap(cap)} a month, so this was not sent and nothing was spent. ` +
    `Raise the cap in Settings, or use Open in Claude to ask with your claude.ai ` +
    `subscription instead.${budget.month.resets ? ` The count starts again on ${budget.month.resets}.` : ""}`
  );
}

/**
 * The same facts as {@link capRefusalMessage}, as the formatted parts a panel
 * draws when the cap was already reached before anything was pressed
 * (`readAssistView` in `lib/assist/mode.ts`). Money stays a measured number
 * there — the panel sets the two amounts in the mono face — so the parts
 * travel separately rather than as one sentence.
 */
export function capReachedOf(budget: SpendBudget): CapReached {
  return {
    spent: formatMicros(budget.spendMicros),
    cap: formatCap(budget.cap.dollars ?? 0),
    defaultCap: budget.cap.source === "default",
    resets: budget.month.resets,
  };
}

/* -------------------------------------------------------------------------- */
/* Recording                                                                   */
/* -------------------------------------------------------------------------- */

/** How a real call ended, as `assist_usage.outcome` spells it. */
export type CallOutcome = "answered" | "failed" | "refused";

/**
 * Write one call to `assist_usage` through `record_assist_usage` (0011), the
 * table's only write path. The database stamps the owner and the time.
 *
 * Never throws: a call that has already been made and billed must still hand
 * its answer back, so a failed write is returned as a message for the log.
 */
export async function recordCall(
  supabase: SpendClient,
  entry: {
    readonly videoId: string | null;
    readonly kind: AssistKind;
    readonly outcome: CallOutcome;
    readonly call: MeasuredCall;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { error } = await supabase.rpc("record_assist_usage", {
      p_video: entry.videoId,
      p_kind: entry.kind,
      p_outcome: entry.outcome,
      p_requested_model: entry.call.requestedModel,
      p_model: entry.call.model,
      p_price_assumed: entry.call.priceAssumed,
      p_input: entry.call.tokens.input,
      p_output: entry.call.tokens.output,
      p_cache_read: entry.call.tokens.cacheRead,
      p_cache_write: entry.call.tokens.cacheWrite,
      p_cost_micros: entry.call.costMicros,
    });
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
