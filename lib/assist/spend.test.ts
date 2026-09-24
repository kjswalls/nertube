import { describe, expect, it } from "vitest";

import {
  capReachedOf,
  capRefusalMessage,
  DEFAULT_CAP_DOLLARS,
  formatCap,
  formatMicros,
  isOverCap,
  meanCallMicros,
  measureCall,
  MOST_EXPENSIVE,
  PRICES_PER_MILLION,
  priceFor,
  readBudget,
  recordCall,
  wasBilled,
  type SpendBudget,
  type SpendClient,
} from "./spend";

/**
 * The spend arithmetic (M11): the price table, the rounding, what a
 * server-side fallback is billed at, and the cap check.
 *
 * Every expected cost is worked by hand in the comment beside it, in
 * micro-dollars. A dollar per million tokens is a micro-dollar per token, so
 * "5/25" means 5 µ$ an input token and 25 µ$ an output token.
 */

const response = (
  model: string,
  usage: Record<string, unknown>,
  stop_reason: string | null = "end_turn",
) => ({ model, stop_reason, usage });

describe("the price table", () => {
  it("is the signed-off table, per million tokens, input/output", () => {
    expect(PRICES_PER_MILLION).toEqual({
      "claude-opus-5": { input: 5, output: 25 },
      "claude-opus-5-5": { input: 4, output: 20 },
      "claude-sonnet-5": { input: 2, output: 10 },
      "claude-haiku-4-5": { input: 1, output: 5 },
      "claude-fable-5-1": { input: 10, output: 50 },
      "claude-opus-4-8": { input: 5, output: 25 },
    });
  });

  it("prices an unknown model at the most expensive entry, never zero", () => {
    expect(MOST_EXPENSIVE).toEqual({ input: 10, output: 50 });
    expect(priceFor("claude-opus-9")).toEqual({ input: 10, output: 50, assumed: true });
    expect(priceFor("")).toMatchObject({ assumed: true, input: 10 });
    // Not fooled by a key every object has.
    expect(priceFor("constructor")).toMatchObject({ assumed: true, output: 50 });
    expect(priceFor("claude-haiku-4-5")).toEqual({ input: 1, output: 5, assumed: false });
  });
});

describe("measureCall", () => {
  it("prices input and output at the served model's rates", () => {
    // 1,000 × 5 + 2,000 × 25 = 5,000 + 50,000 = 55,000 µ$ = $0.055
    const call = measureCall(
      response("claude-opus-5", { input_tokens: 1000, output_tokens: 2000 }),
      "claude-opus-5",
    );
    expect(call).toEqual({
      requestedModel: "claude-opus-5",
      model: "claude-opus-5",
      priceAssumed: false,
      tokens: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 },
      costMicros: 55_000,
    });
  });

  it("prices each model in the table at its own rates", () => {
    const cost = (model: string) =>
      measureCall(response(model, { input_tokens: 1_000_000, output_tokens: 1_000_000 }), model)
        .costMicros;
    // A million of each is exactly the two per-million prices added, in dollars.
    expect(cost("claude-opus-5")).toBe(30_000_000);
    expect(cost("claude-opus-5-5")).toBe(24_000_000);
    expect(cost("claude-sonnet-5")).toBe(12_000_000);
    expect(cost("claude-haiku-4-5")).toBe(6_000_000);
    expect(cost("claude-fable-5-1")).toBe(60_000_000);
    expect(cost("claude-opus-4-8")).toBe(30_000_000);
  });

  it("prices cache writes at 1.25x input and cache reads at 0.1x", () => {
    // Opus 5: 100 × 5 = 500; 1,000 cache writes × 6.25 = 6,250;
    // 10,000 cache reads × 0.5 = 5,000; 10 × 25 = 250. Total 12,000 µ$.
    const call = measureCall(
      response("claude-opus-5", {
        input_tokens: 100,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 10_000,
        output_tokens: 10,
      }),
      "claude-opus-5",
    );
    expect(call.tokens).toEqual({ input: 100, output: 10, cacheRead: 10_000, cacheWrite: 1000 });
    expect(call.costMicros).toBe(12_000);
  });

  it("rounds a fraction of a micro-dollar up, once, at the end", () => {
    // Haiku: 1 cache read × 0.1 = 0.1 µ$, and 3 of them 0.3 µ$ → 1 µ$.
    expect(
      measureCall(response("claude-haiku-4-5", { cache_read_input_tokens: 3 }), "claude-haiku-4-5")
        .costMicros,
    ).toBe(1);
    // Opus 5: 1 cache write = 6.25 µ$ → 7.
    expect(
      measureCall(
        response("claude-opus-5", { cache_creation_input_tokens: 1 }),
        "claude-opus-5",
      ).costMicros,
    ).toBe(7);
  });

  it("treats null cache counts (the API's 'none') as zero", () => {
    const call = measureCall(
      response("claude-sonnet-5", {
        input_tokens: 10,
        output_tokens: 10,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      }),
      "claude-sonnet-5",
    );
    // 10 × 2 + 10 × 10 = 120.
    expect(call.costMicros).toBe(120);
  });

  it("prices an unknown served model at the dearest rate and says so", () => {
    // 1,000 × 10 + 1,000 × 50 = 60,000.
    const call = measureCall(
      response("claude-opus-7", { input_tokens: 1000, output_tokens: 1000 }),
      "claude-opus-5",
    );
    expect(call.model).toBe("claude-opus-7");
    expect(call.priceAssumed).toBe(true);
    expect(call.costMicros).toBe(60_000);
  });

  it("bills a fallback-served call at each attempt's own model, per usage.iterations", () => {
    /*
      Opus 5 declined before any output (reported, not billed); Opus 4.8
      answered. Top-level usage covers only the serving attempt, so the
      iterations are the source of truth.
      Opus 4.8: 2,000 × 5 + 1,500 × 25 = 10,000 + 37,500 = 47,500.
    */
    const call = measureCall(
      {
        model: "claude-opus-4-8",
        stop_reason: "end_turn",
        usage: {
          input_tokens: 2000,
          output_tokens: 1500,
          iterations: [
            { type: "message", model: "claude-opus-5", input_tokens: 2000, output_tokens: 0 },
            {
              type: "fallback_message",
              model: "claude-opus-4-8",
              input_tokens: 2000,
              output_tokens: 1500,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          ],
        },
      },
      "claude-opus-5",
    );
    expect(call.requestedModel).toBe("claude-opus-5");
    expect(call.model).toBe("claude-opus-4-8");
    expect(call.tokens).toEqual({ input: 2000, output: 1500, cacheRead: 0, cacheWrite: 0 });
    expect(call.costMicros).toBe(47_500);
  });

  it("bills a hop that declined mid-output, at its own model, as well as the rescue", () => {
    // Opus 5 wrote 100 tokens then declined: 1,000 × 5 + 100 × 25 = 7,500.
    // Sonnet 5 answered: 1,000 × 2 + 500 × 10 = 7,000. Total 14,500.
    const call = measureCall(
      {
        model: "claude-sonnet-5",
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          iterations: [
            { type: "message", model: "claude-opus-5", input_tokens: 1000, output_tokens: 100 },
            { type: "fallback_message", model: "claude-sonnet-5", input_tokens: 1000, output_tokens: 500 },
          ],
        },
      },
      "claude-opus-5",
    );
    expect(call.costMicros).toBe(14_500);
    expect(call.tokens.input).toBe(2000);
  });

  it("prices a `message` iteration with no model at the requested model", () => {
    const call = measureCall(
      {
        model: "claude-opus-5",
        usage: {
          iterations: [{ type: "message", model: null, input_tokens: 10, output_tokens: 10 }],
        },
      },
      "claude-opus-5",
    );
    expect(call.costMicros).toBe(300);
    expect(call.priceAssumed).toBe(false);
  });

  it("bills nothing for a refusal before any output", () => {
    const refused = measureCall(
      response("claude-opus-5", { input_tokens: 900, output_tokens: 0 }, "refusal"),
      "claude-opus-5",
    );
    expect(refused.costMicros).toBe(0);
    expect(wasBilled(refused)).toBe(false);
  });

  it("bills the partial output of a refusal that came mid-answer", () => {
    // 900 × 5 + 40 × 25 = 4,500 + 1,000 = 5,500.
    const refused = measureCall(
      response("claude-opus-5", { input_tokens: 900, output_tokens: 40 }, "refusal"),
      "claude-opus-5",
    );
    expect(refused.costMicros).toBe(5_500);
    expect(wasBilled(refused)).toBe(true);
  });

  it("falls back to the requested model when the response names none", () => {
    const call = measureCall({ usage: { input_tokens: 1, output_tokens: 1 } }, "claude-haiku-4-5");
    expect(call.model).toBe("claude-haiku-4-5");
    expect(call.costMicros).toBe(6);
  });

  it("never produces a negative or fractional token count from a strange body", () => {
    const call = measureCall(
      response("claude-opus-5", { input_tokens: -50, output_tokens: 10.7, cache_read_input_tokens: "9" }),
      "claude-opus-5",
    );
    expect(call.tokens).toEqual({ input: 0, output: 10, cacheRead: 0, cacheWrite: 0 });
  });
});

/* -------------------------------------------------------------------------- */

const budget = (over: Partial<SpendBudget> = {}): SpendBudget => ({
  spendMicros: 0,
  calls: 0,
  assumedCalls: 0,
  cap: { dollars: DEFAULT_CAP_DOLLARS, source: "default" },
  month: { label: "September 2026", resets: "1 Oct" },
  ...over,
});

describe("the cap", () => {
  it("is ten dollars when none was set", () => {
    expect(DEFAULT_CAP_DOLLARS).toBe(10);
  });

  it("refuses at the cap, not only past it", () => {
    expect(isOverCap(budget({ spendMicros: 9_999_999 }))).toBe(false);
    expect(isOverCap(budget({ spendMicros: 10_000_000 }))).toBe(true);
    expect(isOverCap(budget({ spendMicros: 10_000_001 }))).toBe(true);
  });

  it("refuses everything at $0 and nothing with no cap", () => {
    expect(isOverCap(budget({ cap: { dollars: 0, source: "chosen" } }))).toBe(true);
    expect(isOverCap(budget({ spendMicros: 9e9, cap: { dollars: null, source: "chosen" } }))).toBe(false);
  });

  it("says the cap, the spend, where to change it and the free way", () => {
    const text = capRefusalMessage(budget({ spendMicros: 10_020_000 }));
    expect(text).toContain("$10.02");
    expect(text).toContain("the default cap of $10");
    expect(text).toContain("Settings");
    expect(text).toContain("Open in Claude");
    expect(text).toContain("nothing was spent");
    expect(text).toContain("1 Oct");
    expect(capRefusalMessage(budget({ spendMicros: 3_000_000, cap: { dollars: 3, source: "chosen" } })))
      .toContain("your cap of $3");
  });

  it("hands the panel the same facts as parts, for the cap already reached on the page", () => {
    // The note a panel draws above Open in Claude (M11 integration) says what
    // the refusal says, from the same budget: formatted, never the arithmetic.
    expect(capReachedOf(budget({ spendMicros: 10_020_000 }))).toEqual({
      spent: "$10.02",
      cap: "$10",
      defaultCap: true,
      resets: "1 Oct",
    });
    expect(
      capReachedOf(budget({ spendMicros: 0, cap: { dollars: 0, source: "chosen" } })),
    ).toMatchObject({ spent: "$0.00", cap: "$0", defaultCap: false });
  });

  it("computes the mean only once there is a call", () => {
    expect(meanCallMicros(budget())).toBeNull();
    expect(meanCallMicros(budget({ spendMicros: 1_000_000, calls: 3 }))).toBe(333_333);
  });
});

describe("formatting money", () => {
  it("is dollars and cents", () => {
    expect(formatMicros(0)).toBe("$0.00");
    expect(formatMicros(55_000)).toBe("$0.06");
    expect(formatMicros(10_020_000)).toBe("$10.02");
    expect(formatMicros(1_204_000_000)).toBe("$1,204.00");
    expect(formatMicros(4_000)).toBe("under $0.01");
    expect(formatCap(1500)).toBe("$1,500");
  });
});

/* -------------------------------------------------------------------------- */

function client(data: unknown, error: { message: string } | null = null) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  // Just the one method this module calls, standing in for the typed client.
  const stub = {
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      return Promise.resolve({ data, error });
    },
  } as unknown as SpendClient;
  return { calls, stub };
}

describe("readBudget", () => {
  const NOW = Date.parse("2026-09-30T10:30:00Z");

  it("asks for the month in the user's zone and applies the $10 default", async () => {
    const { calls, stub } = client([
      { spend_micros: "2500000", calls: 4, assumed_calls: 1, cap_set: false, cap_dollars: null },
    ]);
    const read = await readBudget(stub, NOW, "Pacific/Kiritimati");
    // 10:30 UTC on the 30th is already 1 October in Kiritimati.
    expect(calls[0]).toEqual({
      fn: "assist_budget",
      args: { p_from: "2026-09-30T10:00:00.000Z", p_to: "2026-10-31T10:00:00.000Z" },
    });
    expect(read).toEqual({
      spendMicros: 2_500_000,
      calls: 4,
      assumedCalls: 1,
      cap: { dollars: 10, source: "default" },
      month: { label: "October 2026", resets: "1 Nov" },
    });
  });

  it("tells a chosen cap and a chosen 'no cap' apart from the default", async () => {
    const set = await readBudget(
      client([{ spend_micros: 0, calls: 0, assumed_calls: 0, cap_set: true, cap_dollars: 25 }]).stub,
      NOW,
      "UTC",
    );
    expect(set.cap).toEqual({ dollars: 25, source: "chosen" });
    expect(set.month.label).toBe("September 2026");

    const none = await readBudget(
      client([{ spend_micros: 0, calls: 0, assumed_calls: 0, cap_set: true, cap_dollars: null }]).stub,
      NOW,
      "UTC",
    );
    expect(none.cap).toEqual({ dollars: null, source: "chosen" });
  });

  it("throws the database's message rather than reading a failure as zero", async () => {
    await expect(readBudget(client(null, { message: "boom" }).stub, NOW, "UTC")).rejects.toThrow("boom");
  });
});

describe("recordCall", () => {
  it("sends every column through record_assist_usage and never throws", async () => {
    const { calls, stub } = client(null);
    const call = measureCall(
      response("claude-opus-4-8", { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 }),
      "claude-opus-5",
    );
    await expect(
      recordCall(stub, { videoId: "v1", kind: "titles", outcome: "answered", call }),
    ).resolves.toEqual({ ok: true });
    expect(calls[0]).toEqual({
      fn: "record_assist_usage",
      args: {
        p_video: "v1",
        p_kind: "titles",
        p_outcome: "answered",
        p_requested_model: "claude-opus-5",
        p_model: "claude-opus-4-8",
        p_price_assumed: false,
        p_input: 10,
        p_output: 2,
        p_cache_read: 5,
        p_cache_write: 0,
        // 10 × 5 + 2 × 25 + 5 × 0.5 = 50 + 50 + 2.5 → 103.
        p_cost_micros: 103,
      },
    });

    const failing = client(null, { message: "denied" });
    await expect(
      recordCall(failing.stub, { videoId: null, kind: "hooks", outcome: "failed", call }),
    ).resolves.toEqual({ ok: false, error: "denied" });
  });
});
