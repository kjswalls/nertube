import { afterEach, describe, expect, it } from "vitest";

import { createAnthropicProvider, DEFAULT_MODEL } from "./anthropic";
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

    // The beta flag travels as a header, not in the body — and the scalar
    // "default" form pairs with the -07-01 flag, never with -06-01.
    const header = new Headers(calls[0].init.headers).get("anthropic-beta");
    expect(header).toContain("server-side-fallback-2026-07-01");
    expect(header).not.toContain("server-side-fallback-2026-06-01");
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
