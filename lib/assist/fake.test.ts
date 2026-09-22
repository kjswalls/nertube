import { afterEach, describe, expect, it } from "vitest";

import { createFakeProvider } from "./fake";
import {
  critiqueRequest,
  hooksRequest,
  titlesRequest,
  VOICE_GUIDE_BETA,
} from "./test-fixtures";
import {
  AssistError,
  type AssistErrorCode,
  type SuggestionsResult,
  type ThumbnailCritiqueResult,
} from "./types";

/**
 * The fake is what every end-to-end test and every keyless run uses, so these
 * tests are really about three promises: the same input gives the same answer,
 * the voice guide changes the answer, and every failure the UI has to render
 * can be produced on demand without a network.
 */

const provider = createFakeProvider();

afterEach(() => {
  delete process.env.ASSIST_FAKE_SCENARIO;
});

async function titles(
  ...args: Parameters<typeof titlesRequest>
): Promise<SuggestionsResult> {
  return (await provider.run(titlesRequest(...args))) as SuggestionsResult;
}

describe("determinism", () => {
  it("answers the same request identically, every time", async () => {
    const first = await titles();
    const second = await titles();

    expect(second).toEqual(first);
  });

  it("answers differently for a different video", async () => {
    const first = await titles();
    const second = await titles({ video: { title: "Something else entirely" } });

    expect(second.suggestions).not.toEqual(first.suggestions);
  });

  it("reports a latency, and the same one, rather than none at all", async () => {
    const result = await titles();

    expect(result.meta.elapsedMs).toBeGreaterThan(500);
    expect((await titles()).meta.elapsedMs).toBe(result.meta.elapsedMs);
  });
});

describe("the voice guide", () => {
  it("changes the answer when it changes", async () => {
    const alpha = await titles();
    const beta = await titles({ channel: { voiceGuide: VOICE_GUIDE_BETA } });

    expect(beta.suggestions).not.toEqual(alpha.suggestions);
  });

  it("leaves a visible fingerprint, so a keyless run can show it working", async () => {
    const withGuide = await titles();
    const without = await titles({ channel: { voiceGuide: null } });

    const fingerprint = (rationale: string) =>
      rationale.includes(`Keeps the channel's "`);

    expect(withGuide.suggestions.some((s) => fingerprint(s.rationale))).toBe(true);
    expect(without.suggestions.some((s) => fingerprint(s.rationale))).toBe(false);
  });
});

describe("the shape of a good answer", () => {
  it("gives twenty titles with a rationale each and a pick in range", async () => {
    const result = await titles();

    expect(result.kind).toBe("titles");
    expect(result.suggestions).toHaveLength(20);
    expect(new Set(result.suggestions.map((s) => s.text)).size).toBe(20);
    for (const suggestion of result.suggestions) {
      expect(suggestion.text.length).toBeGreaterThan(5);
      expect(suggestion.rationale.length).toBeGreaterThan(20);
    }
    expect(result.recommended).not.toBeNull();
    expect(result.recommended!).toBeLessThan(result.suggestions.length);
    expect(result.meta.provider).toBe("fake");
    expect(result.meta.model).toBe("fixtures");
  });

  it("writes only the hooks that are missing", async () => {
    const result = (await provider.run(
      hooksRequest({ existing: ["One already written", "And a second"] }),
    )) as SuggestionsResult;

    expect(result.suggestions).toHaveLength(1);
    expect(result.meta.requested).toBe(1);
  });

  it("judges each uploaded variant once, in page order", async () => {
    const result = (await provider.run(
      critiqueRequest(["wild_card", "moderate", "safe"]),
    )) as ThumbnailCritiqueResult;

    expect(result.verdicts.map((v) => v.role)).toEqual([
      "wild_card",
      "moderate",
      "safe",
    ]);
    expect(result.recommendedRole).not.toBeNull();
  });
});

describe("failures on demand", () => {
  const codes: AssistErrorCode[] = [
    "not_configured",
    "refused",
    "timeout",
    "cancelled",
    "rate_limited",
    "upstream",
    "unreachable",
    "unauthorized",
    "rejected",
    "malformed",
    "wrong_shape",
    "empty",
  ];

  it("produces every failure the UI has to render, by option", async () => {
    for (const code of codes) {
      const failing = createFakeProvider({ scenario: code });
      await expect(failing.run(titlesRequest())).rejects.toMatchObject({
        name: "AssistError",
        code,
      });
    }
  });

  it("produces one from a marker in the video's own text", async () => {
    await expect(
      provider.run(
        titlesRequest({ video: { notes: "Testing [[assist:refused]] here" } }),
      ),
    ).rejects.toMatchObject({ code: "refused" });
  });

  it("produces one from the environment", async () => {
    process.env.ASSIST_FAKE_SCENARIO = "rate_limited";

    const error = await provider.run(titlesRequest()).catch((e) => e);

    expect((error as AssistError).code).toBe("rate_limited");
    expect((error as AssistError).retryAfterSeconds).toBe(12);
  });

  it("ignores a marker that is not a scenario", async () => {
    await expect(
      provider.run(
        titlesRequest({ video: { notes: "[[assist:banana]] is not a failure" } }),
      ),
    ).resolves.toMatchObject({ kind: "titles" });
  });

  it("carries the sentences and the retry advice the panel shows", async () => {
    const refused = (await createFakeProvider({ scenario: "refused" })
      .run(titlesRequest())
      .catch((e) => e)) as AssistError;

    expect(refused.message).toMatch(/declined/i);
    expect(refused.retryable).toBe(false);
    expect(refused.category).toBe("general_harms");

    const upstream = (await createFakeProvider({ scenario: "upstream" })
      .run(titlesRequest())
      .catch((e) => e)) as AssistError;
    expect(upstream.retryable).toBe(true);
  });

  it("stops before doing any work when the caller has already given up", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.run(titlesRequest(), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("bad answers on demand", () => {
  it("overshoots, so the clamp has something to clamp", async () => {
    const result = (await createFakeProvider({ scenario: "overflow" }).run(
      titlesRequest(),
    )) as SuggestionsResult;

    expect(result.meta.returned).toBe(21);
    expect(result.suggestions).toHaveLength(20);
    expect(result.meta.droppedOverflow).toBe(1);
  });

  it("repeats what the video already has, so the dedupe has something to drop", async () => {
    const existing = ["I tried Editing my videos on a ten year old laptop for 30 days"];
    const result = (await createFakeProvider({ scenario: "duplicate" }).run(
      titlesRequest({ existing }),
    )) as SuggestionsResult;

    expect(result.meta.droppedDuplicates).toBeGreaterThan(0);
    expect(result.suggestions.map((s) => s.text)).not.toContain(existing[0]);
  });

  it("returns something unusable, so the count has something to count", async () => {
    const result = (await createFakeProvider({ scenario: "unusable" }).run(
      titlesRequest(),
    )) as SuggestionsResult;

    expect(result.meta.droppedUnusable).toBe(2);
    expect(result.suggestions.every((s) => s.text.trim() !== "")).toBe(true);
  });
});
