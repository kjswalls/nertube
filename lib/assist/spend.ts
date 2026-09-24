import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  firstOfMonth,
  formatDateColumn,
  formatMonth,
  monthInstants,
  shiftMonth,
  type CalendarMonth,
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
 * 3. **Hold the line.** {@link reserveSpend} runs before every real call: under
 *    a per-user lock in the database it refuses at or over the cap, and
 *    otherwise writes the call's worst case ({@link worstCaseMicros}) as a
 *    pending row, which {@link settleSpend} or {@link closeReservation}
 *    replace once the call ends. {@link capRefusalMessage} is the sentence a
 *    refused call shows; {@link isOverCap} is the page's lighter check of what
 *    to lead with.
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
   * Of those, how many are counted at their worst case because no measured
   * cost exists: a call still in flight, or one that got no response back
   * (our timeout, a dropped connection) and may have been billed anyway.
   */
  readonly estimatedCalls: number;
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
  estimated_calls?: number | null;
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
  return budgetOf((Array.isArray(data) ? data[0] : data) as BudgetRow | undefined, window.month);
}

/** A row from `assist_budget` or `reserve_assist_spend`, as a {@link SpendBudget}. */
function budgetOf(row: BudgetRow | undefined, month: CalendarMonth): SpendBudget {
  return {
    spendMicros: Number(row?.spend_micros ?? 0),
    calls: row?.calls ?? 0,
    assumedCalls: row?.assumed_calls ?? 0,
    estimatedCalls: row?.estimated_calls ?? 0,
    cap: row?.cap_set
      ? { dollars: row.cap_dollars ?? null, source: "chosen" }
      : { dollars: DEFAULT_CAP_DOLLARS, source: "default" },
    month: {
      label: formatMonth(month),
      resets: formatDateColumn(firstOfMonth(shiftMonth(month, 1)), "short") ?? "",
    },
  };
}

/**
 * At or over the cap? A cap of `$0` refuses everything; no cap refuses
 * nothing. The same comparison `reserve_assist_spend` makes in the database.
 *
 * This is the page's check (`readAssistView`: what the panels lead with) and
 * Settings'. It holds no line by itself: the line is {@link reserveSpend},
 * which compares under a per-user lock and writes the call's worst case
 * before anything is sent, so calls started together cannot all pass it.
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
 * amount under a cent says so rather than claiming `$0.00`.
 *
 * Rounded **down** to the cent. Beside a cap, a figure rounded to the nearest
 * cent could read `$10.00` at $9.996 — the cap shown as met while the check,
 * which compares exact micro-dollars, still lets the next call go (M11 review,
 * finding 3). Rounded down, the figure never claims a line the check has not
 * reached.
 */
export function formatMicros(micros: number): string {
  const cents = Math.floor(micros / 10_000);
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

/* -------------------------------------------------------------------------- */
/* The worst case, reserved before a call                                      */
/* -------------------------------------------------------------------------- */

/**
 * The input tokens one image can cost, at most. Anthropic's vision guide puts
 * an image at about width × height / 750 tokens, with the long edge capped
 * (about 1,600 tokens at the classic 1,568 px, under 4,800 on the models that
 * take larger images). 5,000 is above both.
 */
export const IMAGE_TOKEN_CEILING = 5_000;

/**
 * Tokens the API adds around what this app sends — the structured-output
 * instructions, the turn framing. Not documented as a number; 2,000 is a
 * generous allowance on top of an already generous bound (below).
 */
export const INPUT_OVERHEAD_TOKENS = 2_000;

/**
 * The most one call can cost, in integer micro-dollars: what is reserved
 * before it is sent, and what it is counted at if no usage ever comes back.
 *
 * - **Input**: one token per UTF-8 byte of everything the request says in
 *   text — a byte-level tokenizer never produces more tokens than bytes — plus
 *   {@link IMAGE_TOKEN_CEILING} per image and {@link INPUT_OVERHEAD_TOKENS}.
 * - **Output**: the request's `max_tokens`, all of it (adaptive thinking
 *   included — it is billed as output).
 * - **Rate**: {@link MOST_EXPENSIVE} for both, whatever model was asked for,
 *   because a server-side fallback may answer with another.
 *
 * Rounded up. Not covered: a fallback chain in which *two* attempts both
 * produced output before the second answered is billed twice; the reserve
 * covers one. Written down in the README.
 */
export function worstCaseMicros(request: {
  readonly textBytes: number;
  readonly images: number;
  readonly maxTokens: number;
}): number {
  const input =
    Math.max(0, Math.ceil(request.textBytes)) +
    Math.max(0, request.images) * IMAGE_TOKEN_CEILING +
    INPUT_OVERHEAD_TOKENS;
  return input * MOST_EXPENSIVE.input + Math.max(0, request.maxTokens) * MOST_EXPENSIVE.output;
}

/** A reservation, or the budget that refused one. */
export type Reserved =
  | { readonly ok: true; readonly id: string; readonly budget: SpendBudget }
  | { readonly ok: false; readonly budget: SpendBudget };

/**
 * Before a real call: reserve its worst case against this month's cap.
 *
 * `reserve_assist_spend` (0011) takes a per-user transaction lock, sums the
 * month — settled calls at their cost, open reservations and unanswered calls
 * at their worst case — and, under the cap, writes a pending row for this
 * call. So asks started together, from any tab, video or kind, are counted
 * one after another and at most one of them can cross the line. The month can
 * therefore end over the cap by at most that one call's worst case.
 *
 * Throws the database's message on a failed read; the caller refuses the call
 * (a ceiling that is skipped whenever it cannot be read is not a ceiling).
 */
export async function reserveSpend(
  supabase: SpendClient,
  now: number,
  zone: TimeZone,
  call: {
    readonly videoId: string | null;
    readonly kind: AssistKind;
    readonly requestedModel: string;
    readonly estimateMicros: number;
  },
): Promise<Reserved> {
  const window = monthInstants(now, zone);
  const { data, error } = await supabase.rpc("reserve_assist_spend", {
    p_from: new Date(window.from).toISOString(),
    p_to: new Date(window.to).toISOString(),
    p_video: call.videoId,
    p_kind: call.kind,
    p_requested_model: call.requestedModel,
    p_estimate_micros: Math.ceil(call.estimateMicros),
    p_default_cap_dollars: DEFAULT_CAP_DOLLARS,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as
    | (BudgetRow & { reservation: string | null })
    | undefined;
  const budget = budgetOf(row, window.month);
  return row?.reservation ? { ok: true, id: row.reservation, budget } : { ok: false, budget };
}

/**
 * After a call whose response came back: the reservation becomes the
 * measured cost, tokens and served model (`settle_assist_spend`, 0011). A
 * response that billed nothing (declined before any output) closes the
 * reservation instead, as nothing to count.
 *
 * Never throws: a call that has been made and billed must still hand its
 * answer back. A failed write leaves the reservation at its worst case —
 * over-counted, never under — and is returned as a message for the log.
 */
export async function settleSpend(
  supabase: SpendClient,
  id: string,
  outcome: CallOutcome,
  call: MeasuredCall,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!wasBilled(call)) return closeReservation(supabase, id, false);
  try {
    const { error } = await supabase.rpc("settle_assist_spend", {
      p_id: id,
      p_outcome: outcome,
      p_model: call.model,
      p_price_assumed: call.priceAssumed,
      p_input: call.tokens.input,
      p_output: call.tokens.output,
      p_cache_read: call.tokens.cacheRead,
      p_cache_write: call.tokens.cacheWrite,
      p_cost_micros: call.costMicros,
    });
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * After a call that got no response: when it may still have been billed (our
 * own timeout, a dropped connection, an abort), the reservation stays at its
 * worst case, marked failed; when it cannot have been (the API answered with
 * an error status), it is removed (`close_assist_reservation`, 0011).
 * Never throws, for the same reason as {@link settleSpend}.
 */
export async function closeReservation(
  supabase: SpendClient,
  id: string,
  mayHaveBilled: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { error } = await supabase.rpc("close_assist_reservation", {
      p_id: id,
      p_may_have_billed: mayHaveBilled,
    });
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
