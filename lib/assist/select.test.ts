import { describe, expect, it } from "vitest";

import { assistFallbackWarning, selectAssistProvider } from "./select";

/**
 * The one part of M8 that cannot be proved by running the feature.
 *
 * Every browser walk in this repository exercises `lib/assist/fake.ts`, because
 * the container has no `ANTHROPIC_API_KEY` and no route to `api.anthropic.com`.
 * So "a key makes it call Claude" and "no key in production is an error rather
 * than a quiet substitution" are claims that live or die here.
 */
describe("selectAssistProvider", () => {
  it("honours an explicit fake even when a key is present", () => {
    expect(
      selectAssistProvider({
        ASSIST_PROVIDER: "fake",
        ANTHROPIC_API_KEY: "sk-ant-not-a-real-key",
        NODE_ENV: "production",
      }),
    ).toBe("fake");
  });

  it("is case- and whitespace-insensitive about that word", () => {
    expect(selectAssistProvider({ ASSIST_PROVIDER: "  FAKE " })).toBe("fake");
  });

  it("chooses the real provider when a key is present and nothing was said", () => {
    expect(
      selectAssistProvider({ ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" }),
    ).toBe("anthropic");
  });

  it("chooses the real provider when the variable names anything but fake", () => {
    // A typo must not silently become fixtures. There is one real provider, so
    // every value that is not the word `fake` means "ask Claude".
    expect(selectAssistProvider({ ASSIST_PROVIDER: "anthropic" })).toBe("anthropic");
    expect(selectAssistProvider({ ASSIST_PROVIDER: "claude" })).toBe("anthropic");
    expect(selectAssistProvider({ ASSIST_PROVIDER: "faek" })).toBe("anthropic");
  });

  it("does NOT fall back in production when the key is missing", () => {
    // The whole point. A deployment where somebody forgot to paste the key
    // must say so, not hand out invented titles that read exactly like real
    // ones. `lib/assist/anthropic.ts` then raises `not_configured`, whose
    // sentence names the variable.
    expect(selectAssistProvider({ NODE_ENV: "production" })).toBe("anthropic");
    expect(
      selectAssistProvider({ NODE_ENV: "production", ANTHROPIC_API_KEY: "   " }),
    ).toBe("anthropic");
  });

  it("falls back to the fixtures outside production when there is no key", () => {
    // This container's permanent state, and a fresh clone's. The feature has to
    // be reviewable without a paid account; the panel says a fixture answered.
    expect(selectAssistProvider({})).toBe("fake");
    expect(selectAssistProvider({ NODE_ENV: "development" })).toBe("fake");
    expect(selectAssistProvider({ NODE_ENV: "test" })).toBe("fake");
    expect(selectAssistProvider({ ANTHROPIC_API_KEY: "" })).toBe("fake");
  });
});

describe("assistFallbackWarning", () => {
  it("warns only when the fixtures were inferred rather than asked for", () => {
    expect(assistFallbackWarning({})).toMatch(/ANTHROPIC_API_KEY/);
    expect(assistFallbackWarning({ ASSIST_PROVIDER: "fake" })).toBeNull();
    expect(assistFallbackWarning({ NODE_ENV: "production" })).toBeNull();
    expect(
      assistFallbackWarning({ ANTHROPIC_API_KEY: "sk-ant-not-a-real-key" }),
    ).toBeNull();
  });
});
