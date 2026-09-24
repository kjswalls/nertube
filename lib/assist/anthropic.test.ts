import { afterEach, describe, expect, it } from "vitest";

import { createAnthropicProvider, DEFAULT_MODEL, MAX_TOKENS } from "./anthropic";
import type { CallOutcome, MeasuredCall } from "./spend";
import { critiqueRequest, titlesRequest, VOICE_GUIDE_ALPHA } from "./test-fixtures";
import {
  AssistError,
  type AssistErrorCode,
  type SuggestionsResult,
} from "./types";

/**
 * The real provider, exercised without a network.
 *
 * **No test in this file leaves the machine, and none can.** There is no API
 * key in this container and api.anthropic.com is unreachable from it, which is
 * the constraint that shaped the whole module: the transport is injectable, so
 * every test here hands the SDK a stub `fetch` and then asserts on two things
 * — the request the SDK actually built from our parameters, and what the
 * provider does with each kind of reply.
 *
 * That is also the only way the settings PLAN.md pins can be *checked* rather
 * than asserted in a comment. `effort: "medium"`, `fallbacks: "default"` and
 * the beta flag that goes with it are read back out of the outgoing request
 * below, so if a future edit drops one of them, this fails.
 */

/** The transport: every call recorded, one canned reply per test. */
function stub(handler: (init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchStub = async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    calls.push({ url: String(input), init });
    return handler(init);
  };
  return { calls, fetchStub };
}

function provider(
  handler: (init: RequestInit) => Response | Promise<Response>,
  options: { model?: string; apiKey?: string } = {},
) {
  const { calls, fetchStub } = stub(handler);
  return {
    calls,
    provider: createAnthropicProvider({
      apiKey: options.apiKey ?? "sk-ant-test-key",
      ...(options.model === undefined ? {} : { model: options.model }),
      maxRetries: 0,
      fetch: fetchStub,
    }),
  };
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A `/v1/messages` reply carrying `text` as its single text block. */
function message(text: string, over: Record<string, unknown> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: DEFAULT_MODEL,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 1200 },
    ...over,
  };
}

const suggestions = (count: number) =>
  JSON.stringify({
    suggestions: Array.from({ length: count }, (_unused, index) => ({
      text: `Title ${index + 1}`,
      rationale: `Reason ${index + 1}`,
    })),
    recommended_index: 0,
  });

function apiError(status: number, type: string, headers: HeadersInit = {}) {
  return jsonResponse(
    { type: "error", error: { type, message: `a ${status}` } },
    status,
    headers,
  );
}

async function codeOf(run: () => Promise<unknown>): Promise<AssistErrorCode | string> {
  try {
    await run();
  } catch (error) {
    return error instanceof AssistError ? error.code : `not-an-AssistError`;
  }
  return "no-error";
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/* -------------------------------------------------------------------------- */

describe("the request it builds", () => {
  it("sends the model, effort and fallbacks PLAN.md pins", async () => {
    const { calls, provider: anthropic } = provider(() =>
      jsonResponse(message(suggestions(20))),
    );

    await anthropic.run(titlesRequest());

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body));

    expect(body.model).toBe("claude-opus-5");
    expect(body.max_tokens).toBe(16_000);
    expect(body.output_config.effort).toBe("medium");
    expect(body.fallbacks).toBe("default");

    // The beta flags travel as a header, not in the body — and the scalar
    // "default" form pairs with the -07-01 flag, never with -06-01.
    const header = new Headers(calls[0].init.headers).get("anthropic-beta");
    expect(header).toContain("server-side-fallback-2026-07-01");
    expect(header).not.toContain("server-side-fallback-2026-06-01");
  });

  it("sends the structured-outputs beta the SDK's own parse() sends", async () => {
    /*
      The review found this missing, and it is the one thing in the provider
      that could be wrong on 100% of production calls with nobody here able to
      find out. `output_config.format` goes to the *beta* messages endpoint,
      and the SDK's own structured-output entry point on that namespace —
      `client.beta.messages.parse`, `resources/beta/messages/messages.js:75-83`
      in the installed 0.128.0 — adds this exact flag on top of whatever
      `betas` the caller passed. The plain `create()` adds nothing of its own,
      so a direct `create()` call sends only what the provider lists. Asserted
      here rather than remembered.
    */
    const { calls, provider: anthropic } = provider(() =>
      jsonResponse(message(suggestions(20))),
    );

    await anthropic.run(titlesRequest());

    const header = new Headers(calls[0].init.headers).get("anthropic-beta");
    expect(header).toContain("structured-outputs-2025-12-15");
    // Both, together, on the one request that carries a schema.
    expect(header).toContain("server-side-fallback-2026-07-01");
  });

  it("sends no thinking configuration at all", async () => {
    // Thinking is adaptive and on by default on this model; `budget_tokens`
    // was removed and sending it is a 400.
    const { calls, provider: anthropic } = provider(() =>
      jsonResponse(message(suggestions(20))),
    );

    await anthropic.run(titlesRequest());
    const body = JSON.parse(String(calls[0].init.body));

    expect(body.thinking).toBeUndefined();
    expect(body.effort).toBeUndefined();
    expect(body.budget_tokens).toBeUndefined();
  });

  it("asks for JSON through a schema that carries no counts", async () => {
    const { calls, provider: anthropic } = provider(() =>
      jsonResponse(message(suggestions(20))),
    );

    await anthropic.run(titlesRequest());
    const body = JSON.parse(String(calls[0].init.body));

    expect(body.output_config.format.type).toBe("json_schema");

    // Walk the whole schema: a bound anywhere in it would mean the module
    // could reject a 21-title answer, which is the behaviour PLAN.md forbids.
    const bounds = ["maxItems", "maxLength", "minLength", "maximum", "minimum"];
    const seen: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (bounds.includes(key)) seen.push(key);
        walk(value);
      }
    };
    walk(body.output_config.format.schema);

    expect(seen).toEqual([]);
  });

  it("puts the channel's voice guide in the system prompt", async () => {
    const { calls, provider: anthropic } = provider(() =>
      jsonResponse(message(suggestions(20))),
    );

    await anthropic.run(titlesRequest());
    const body = JSON.parse(String(calls[0].init.body));

    expect(String(body.system)).toContain(VOICE_GUIDE_ALPHA.trim());
    expect(String(body.messages[0].content)).toContain(
      "Editing my videos on a ten year old laptop",
    );
  });

  it("sends the thumbnails as image blocks, before the instructions", async () => {
    const { calls, provider: anthropic } = provider(() =>
      jsonResponse(
        message(
          JSON.stringify({
            verdicts: [
              {
                role: "safe",
                reads_at_tile_size: true,
                complements_title: true,
                note: "Fine.",
              },
            ],
            recommended_role: "safe",
          }),
        ),
      ),
    );

    await anthropic.run(critiqueRequest(["safe"]));
    const body = JSON.parse(String(calls[0].init.body));
    const content = body.messages[0].content;

    expect(content[0].type).toBe("image");
    expect(content[0].source.type).toBe("base64");
    expect(content[0].source.media_type).toBe("image/png");
    expect(content[content.length - 1].type).toBe("text");
  });

  it("takes the model from the environment when one is set", async () => {
    process.env.ANTHROPIC_MODEL = "claude-sonnet-5";
    const { calls, provider: anthropic } = provider(() =>
      jsonResponse(message(suggestions(20), { model: "claude-sonnet-5" })),
    );

    await anthropic.run(titlesRequest());

    expect(JSON.parse(String(calls[0].init.body)).model).toBe("claude-sonnet-5");
  });

  it("never reads a key at module scope: an unset key is a typed error", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const keyless = createAnthropicProvider({ fetch: async () => jsonResponse({}) });

    expect(await codeOf(() => keyless.run(titlesRequest()))).toBe(
      "not_configured",
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("a good answer", () => {
  it("clamps twenty-one to twenty and keeps the work", async () => {
    const { provider: anthropic } = provider(() =>
      jsonResponse(message(suggestions(21))),
    );

    const result = (await anthropic.run(titlesRequest())) as SuggestionsResult;

    expect(result.suggestions).toHaveLength(20);
    expect(result.meta.returned).toBe(21);
    expect(result.meta.droppedOverflow).toBe(1);
    expect(result.meta.requested).toBe(20);
    expect(result.meta.provider).toBe("anthropic");
    expect(result.meta.model).toBe(DEFAULT_MODEL);
    expect(result.meta.servedByFallback).toBe(false);
  });

  it("notices when a fallback model answered instead", async () => {
    const { provider: anthropic } = provider(() =>
      jsonResponse(
        message(suggestions(20), {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 900,
            output_tokens: 1200,
            iterations: [{ type: "fallback_message", output_tokens: 1200 }],
          },
        }),
      ),
    );

    const result = (await anthropic.run(titlesRequest())) as SuggestionsResult;

    expect(result.meta.servedByFallback).toBe(true);
    expect(result.meta.model).toBe("claude-opus-4-8");
  });

  it("measures how long it took", async () => {
    const { provider: anthropic } = provider(() =>
      jsonResponse(message(suggestions(20))),
    );

    const result = (await anthropic.run(titlesRequest())) as SuggestionsResult;

    expect(result.meta.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

/* -------------------------------------------------------------------------- */

describe("every failure maps to a typed error", () => {
  it("a refusal becomes a message, not a crash", async () => {
    const { provider: anthropic } = provider(() =>
      jsonResponse(
        message("", {
          content: [],
          stop_reason: "refusal",
          stop_details: {
            type: "refusal",
            category: "cyber",
            explanation: "This one is about exploit development.",
          },
        }),
      ),
    );

    const error = (await anthropic
      .run(titlesRequest())
      .catch((e) => e)) as AssistError;

    expect(error.code).toBe("refused");
    expect(error.category).toBe("cyber");
    expect(error.detail).toContain("exploit development");
    // The same prompt will be declined the same way, so a retry button here
    // would be a lie.
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/declined/i);
  });

  it("a 429 becomes rate_limited, with the wait when the API gives one", async () => {
    const { provider: anthropic } = provider(() =>
      apiError(429, "rate_limit_error", { "retry-after": "30" }),
    );

    const error = (await anthropic
      .run(titlesRequest())
      .catch((e) => e)) as AssistError;

    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.retryable).toBe(true);
  });

  it("a 500 becomes upstream", async () => {
    const { provider: anthropic } = provider(() => apiError(500, "api_error"));

    expect(await codeOf(() => anthropic.run(titlesRequest()))).toBe("upstream");
  });

  it("a 401 and a 403 become unauthorized", async () => {
    for (const status of [401, 403]) {
      const { provider: anthropic } = provider(() =>
        apiError(status, "authentication_error"),
      );
      expect(await codeOf(() => anthropic.run(titlesRequest()))).toBe(
        "unauthorized",
      );
    }
  });

  it("names the environment variable in the detail and never in the sentence", async () => {
    /*
      The review found `MESSAGES.unauthorized` reading "Check ANTHROPIC_API_KEY
      in the deployment's environment", which `failureOf` returns verbatim to
      the browser — so a 401 put an infrastructure variable on the screen of
      whoever happened to be using the app, contradicting this milestone's own
      recorded decision to keep PLAN.md's build-output grep a bright line. The
      name belongs where the person who can act on it reads it: `detail`, which
      is logged on the server and never rendered.
    */
    const { provider: anthropic } = provider(() =>
      apiError(401, "authentication_error"),
    );

    const error = (await anthropic
      .run(titlesRequest())
      .catch((e) => e)) as AssistError;

    expect(error.code).toBe("unauthorized");
    expect(error.message).not.toContain("ANTHROPIC_API_KEY");
    expect(error.detail).toContain("ANTHROPIC_API_KEY");
  });

  it("a 400 becomes rejected — our bug, and it says so", async () => {
    const { provider: anthropic } = provider(() =>
      apiError(400, "invalid_request_error"),
    );

    const error = (await anthropic
      .run(titlesRequest())
      .catch((e) => e)) as AssistError;

    expect(error.code).toBe("rejected");
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/bug in this app/i);
  });

  it("a body that is not JSON becomes malformed", async () => {
    const { provider: anthropic } = provider(() =>
      jsonResponse(message("I'm sorry — I can't help with that.")),
    );

    expect(await codeOf(() => anthropic.run(titlesRequest()))).toBe("malformed");
  });

  it("JSON of the wrong shape becomes wrong_shape", async () => {
    const { provider: anthropic } = provider(() =>
      jsonResponse(message(JSON.stringify({ titles: ["One", "Two"] }))),
    );

    expect(await codeOf(() => anthropic.run(titlesRequest()))).toBe(
      "wrong_shape",
    );
  });

  it("an answer with nothing in it becomes empty", async () => {
    const { provider: anthropic } = provider(() =>
      jsonResponse(
        message(JSON.stringify({ suggestions: [], recommended_index: 0 })),
      ),
    );

    expect(await codeOf(() => anthropic.run(titlesRequest()))).toBe("empty");
  });

  it("a response cut off at max_tokens reads as unreadable, not as empty", async () => {
    const { provider: anthropic } = provider(() =>
      jsonResponse(message("", { content: [], stop_reason: "max_tokens" })),
    );

    expect(await codeOf(() => anthropic.run(titlesRequest()))).toBe("malformed");
  });

  it("a connection failure becomes unreachable", async () => {
    const { provider: anthropic } = provider(() => {
      throw new TypeError("fetch failed");
    });

    expect(await codeOf(() => anthropic.run(titlesRequest()))).toBe(
      "unreachable",
    );
  });

  it("our own deadline becomes timeout", async () => {
    const { provider: anthropic } = provider(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          // Never answers; the SDK's own timer aborts the request signal.
          init.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );

    expect(
      await codeOf(() => anthropic.run(titlesRequest(), { timeoutMs: 20 })),
    ).toBe("timeout");
  });

  it("the person closing the panel becomes cancelled, not a failure", async () => {
    const controller = new AbortController();
    const { provider: anthropic } = provider(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
          setTimeout(() => controller.abort(), 5);
        }),
    );

    const error = (await anthropic
      .run(titlesRequest(), { signal: controller.signal })
      .catch((e) => e)) as AssistError;

    expect(error.code).toBe("cancelled");
    // Nobody is waiting for a sentence about a panel they closed themselves.
    expect(error.retryable).toBe(false);
  });

  it("anything unrecognised still arrives as an AssistError", async () => {
    const { provider: anthropic } = provider(() => {
      throw "a string, thrown from somewhere odd";
    });

    const error = await anthropic.run(titlesRequest()).catch((e) => e);

    expect(error).toBeInstanceOf(AssistError);
    expect((error as AssistError).message.length).toBeGreaterThan(10);
  });
});

/* -------------------------------------------------------------------------- */
/* What each call cost (M11)                                                   */
/* -------------------------------------------------------------------------- */

describe("every billed response is reported to onUsage", () => {
  type Reported = { call: MeasuredCall; outcome: CallOutcome };

  function recorded(
    handler: (init: RequestInit) => Response | Promise<Response>,
    onUsage?: (call: MeasuredCall, outcome: CallOutcome) => unknown,
  ) {
    const reports: Reported[] = [];
    const { calls, fetchStub } = stub(handler);
    return {
      calls,
      reports,
      provider: createAnthropicProvider({
        apiKey: "sk-ant-test-key",
        maxRetries: 0,
        fetch: fetchStub,
        onUsage:
          onUsage ??
          ((call, outcome) => {
            reports.push({ call, outcome });
          }),
      }),
    };
  }

  it("an answer, priced at the model that served it", async () => {
    const { reports, provider: anthropic } = recorded(() =>
      jsonResponse(message(suggestions(12))),
    );
    await anthropic.run(titlesRequest());

    // 900 × 5 + 1,200 × 25 = 4,500 + 30,000 = 34,500 µ$.
    expect(reports).toEqual([
      {
        outcome: "answered",
        call: {
          requestedModel: "claude-opus-5",
          model: "claude-opus-5",
          priceAssumed: false,
          tokens: { input: 900, output: 1200, cacheRead: 0, cacheWrite: 0 },
          costMicros: 34_500,
        },
      },
    ]);
  });

  it("a fallback-served answer, at the fallback's own rates", async () => {
    const { reports, provider: anthropic } = recorded(() =>
      jsonResponse(
        message(suggestions(12), {
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 900,
            output_tokens: 1200,
            iterations: [
              { type: "message", model: "claude-opus-5", input_tokens: 900, output_tokens: 0 },
              { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 900, output_tokens: 1200 },
            ],
          },
        }),
      ),
    );
    const result = (await anthropic.run(titlesRequest())) as SuggestionsResult;

    expect(result.meta.servedByFallback).toBe(true);
    expect(reports[0].call.model).toBe("claude-opus-4-8");
    expect(reports[0].call.requestedModel).toBe("claude-opus-5");
    // Only the serving hop billed: 900 × 5 + 1,200 × 25.
    expect(reports[0].call.costMicros).toBe(34_500);
  });

  it("cache tokens, at their multipliers", async () => {
    const { reports, provider: anthropic } = recorded(() =>
      jsonResponse(
        message(suggestions(12), {
          usage: {
            input_tokens: 100,
            output_tokens: 100,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 200,
          },
        }),
      ),
    );
    await anthropic.run(titlesRequest());
    // 100 × 5 + 100 × 25 + 1,000 × 0.5 + 200 × 6.25 = 500 + 2,500 + 500 + 1,250.
    expect(reports[0].call.costMicros).toBe(4_750);
    expect(reports[0].call.tokens).toEqual({ input: 100, output: 100, cacheRead: 1000, cacheWrite: 200 });
  });

  it("a refusal, as refused — billed only for what it wrote", async () => {
    const { reports, provider: anthropic } = recorded(() =>
      jsonResponse(
        message("", {
          content: [],
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber", explanation: "no" },
          usage: { input_tokens: 900, output_tokens: 0 },
        }),
      ),
    );
    expect(await codeOf(() => anthropic.run(titlesRequest()))).toBe("refused");
    expect(reports).toHaveLength(1);
    expect(reports[0].outcome).toBe("refused");
    expect(reports[0].call.costMicros).toBe(0);
  });

  it("an unusable 200, as failed — it was still billed", async () => {
    const { reports, provider: anthropic } = recorded(() =>
      jsonResponse(message(JSON.stringify({ nothing: "useful" }))),
    );
    expect(await codeOf(() => anthropic.run(titlesRequest()))).toBe("wrong_shape");
    expect(reports).toHaveLength(1);
    expect(reports[0].outcome).toBe("failed");
    expect(reports[0].call.costMicros).toBe(34_500);
  });

  it("nothing for a request that got no response to price", async () => {
    const { reports, provider: anthropic } = recorded(() => apiError(429, "rate_limit_error"));
    expect(await codeOf(() => anthropic.run(titlesRequest()))).toBe("rate_limited");
    expect(reports).toHaveLength(0);
  });

  it("waits for the recorder, and a recorder that throws does not cost the answer", async () => {
    let finished = false;
    const slow = recorded(
      () => jsonResponse(message(suggestions(12))),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished = true;
      },
    );
    await slow.provider.run(titlesRequest());
    expect(finished).toBe(true);

    const broken = recorded(
      () => jsonResponse(message(suggestions(12))),
      () => {
        throw new Error("database down");
      },
    );
    const result = (await broken.provider.run(titlesRequest())) as SuggestionsResult;
    expect(result.suggestions).toHaveLength(12);
  });
});

/* -------------------------------------------------------------------------- */
/* The worst case, reserved before the request leaves (M11 review, 1 and 2)    */
/* -------------------------------------------------------------------------- */

describe("the worst case is reserved before anything is sent", () => {
  function gated(
    handler: (init: RequestInit) => Response | Promise<Response>,
    beforeSend: (worst: { requestedModel: string; costMicros: number }) => Promise<void> | void,
  ) {
    const events: string[] = [];
    const worst: { requestedModel: string; costMicros: number }[] = [];
    const noUsage: boolean[] = [];
    const { calls, fetchStub } = stub((init) => {
      events.push("sent");
      return handler(init);
    });
    return {
      calls,
      events,
      worst,
      noUsage,
      provider: createAnthropicProvider({
        apiKey: "sk-ant-test-key",
        maxRetries: 0,
        fetch: fetchStub,
        beforeSend: async (w) => {
          events.push("reserve");
          worst.push(w);
          await beforeSend(w);
        },
        onUsage: () => {
          events.push("settle");
        },
        onNoUsage: (billed) => {
          events.push("close");
          noUsage.push(billed);
        },
      }),
    };
  }

  it("reserves, then sends, then settles — with a worst case above any real answer", async () => {
    const run = gated(() => jsonResponse(message(suggestions(12))), () => {});
    await run.provider.run(titlesRequest());
    expect(run.events).toEqual(["reserve", "sent", "settle"]);
    expect(run.worst[0].requestedModel).toBe("claude-opus-5");
    // All of max_tokens at the dearest output rate ($50/M) is the floor of it…
    expect(run.worst[0].costMicros).toBeGreaterThan(MAX_TOKENS * 50);
    // …and the prompt, one token per byte at $10/M, is on top.
    const sent = JSON.parse(String(run.calls[0].init.body)) as { system: string };
    expect(run.worst[0].costMicros).toBeGreaterThan(MAX_TOKENS * 50 + Buffer.byteLength(sent.system) * 10);
  });

  it("counts each image of a critique at the image ceiling", async () => {
    const text = gated(() => jsonResponse(message(suggestions(12))), () => {});
    await text.provider.run(titlesRequest()).catch(() => {});
    const critique = gated(() => apiError(400, "invalid_request_error"), () => {});
    await critique.provider.run(critiqueRequest()).catch(() => {});
    // Three images at 5,000 tokens × $10/M each is at least 150,000 µ$ more.
    expect(critique.worst[0].costMicros - text.worst[0].costMicros).toBeGreaterThan(100_000);
  });

  it("sends nothing when the reservation refuses, and throws its refusal", async () => {
    const run = gated(
      () => jsonResponse(message(suggestions(12))),
      () => {
        throw new AssistError("spend_cap", { message: "At the cap." });
      },
    );
    expect(await codeOf(() => run.provider.run(titlesRequest()))).toBe("spend_cap");
    expect(run.calls).toHaveLength(0);
    expect(run.events).toEqual(["reserve"]);
  });

  it("keeps the worst case after our own timeout: the API may have billed it", async () => {
    const run = gated(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
      () => {},
    );
    expect(await codeOf(() => run.provider.run(titlesRequest(), { timeoutMs: 20 }))).toBe("timeout");
    expect(run.events).toEqual(["reserve", "sent", "close"]);
    expect(run.noUsage).toEqual([true]);
  });

  it("keeps it after a dropped connection, and releases it after an error status", async () => {
    const dropped = gated(() => Promise.reject(new TypeError("fetch failed")), () => {});
    expect(await codeOf(() => dropped.provider.run(titlesRequest()))).toBe("unreachable");
    expect(dropped.noUsage).toEqual([true]);

    for (const [status, type] of [
      [429, "rate_limit_error"],
      [500, "api_error"],
      [400, "invalid_request_error"],
    ] as const) {
      const refused = gated(() => apiError(status, type), () => {});
      await codeOf(() => refused.provider.run(titlesRequest()));
      expect(refused.noUsage).toEqual([false]);
    }
  });
});
