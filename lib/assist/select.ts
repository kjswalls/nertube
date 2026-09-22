/**
 * Which implementation answers an assist: the whole environment decision, in
 * one pure function.
 *
 * It is here rather than inline in `app/actions/assist.ts` because it is the
 * one piece of M8 that *cannot* be checked by running the feature. There is no
 * `ANTHROPIC_API_KEY` in the container this was built in and no route to
 * `api.anthropic.com` from it, so every browser walk and every Playwright spec
 * exercises the fixtures. What the app does when a key *is* present is
 * therefore only ever provable by reading this, and by the unit tests beside
 * it. Making it a function with an explicit environment argument is what lets
 * those tests state each case rather than mutate `process.env` and hope.
 *
 * ## The rule
 *
 * | `ASSIST_PROVIDER` | key present | `NODE_ENV` | answers |
 * |---|---|---|---|
 * | `fake` | either | any | the fixtures |
 * | anything else non-empty | either | any | Claude |
 * | unset | yes | any | Claude |
 * | unset | no | `production` | Claude — and fails with "no API key configured" |
 * | unset | no | anything else | the fixtures |
 *
 * ## Why an explicit `fake` wins even when a key is present
 *
 * The Playwright suite runs against a deployment-shaped app and must never be
 * able to spend money or depend on a third party being up. `ASSIST_PROVIDER`
 * is set in `playwright.config.ts` and in `.env.local`; it is a statement, and
 * a statement outranks an inference.
 *
 * ## Why a *production* deployment with no key does not fall back
 *
 * This is the important one. The fixtures return plausible titles with
 * plausible reasons; nothing about them looks wrong. A deployment where
 * somebody forgot to paste the key would, if it fell back, hand its user
 * invented titles and let them believe a model wrote them — the single failure
 * in this feature that cannot be noticed from the outside. So in production a
 * missing key is an error with a sentence naming the variable, which is true
 * and fixable, and never a quiet substitution.
 *
 * ## Why a *development* checkout with no key does
 *
 * The opposite consideration, and it only applies where a person is looking at
 * their own machine: a fresh clone with no key would otherwise render four
 * buttons that can do nothing but fail, and the feature would be unreviewable
 * without a paid account. It falls back, and — this is the part that makes it
 * safe — the panel says which answered, every time, in
 * `components/assist/chrome.tsx`'s `AssistProvenance`. The fixtures are never
 * silent about being fixtures.
 */

export type AssistProviderName = "anthropic" | "fake";

/** Just the variables this decision reads. Nothing else is consulted. */
export interface AssistEnvironment {
  readonly ASSIST_PROVIDER?: string | undefined;
  readonly ANTHROPIC_API_KEY?: string | undefined;
  readonly NODE_ENV?: string | undefined;
}

export function selectAssistProvider(env: AssistEnvironment): AssistProviderName {
  const chosen = (env.ASSIST_PROVIDER ?? "").trim().toLowerCase();
  if (chosen === "fake") return "fake";
  // Any other value names the real thing. There is one real provider, so
  // "anthropic", "claude" or a typo all mean the same: do not pretend.
  if (chosen !== "") return "anthropic";

  const hasKey = (env.ANTHROPIC_API_KEY ?? "").trim() !== "";
  if (hasKey) return "anthropic";

  return env.NODE_ENV === "production" ? "anthropic" : "fake";
}

/**
 * Why the fixtures are answering, as a line for the server log — or null when
 * nothing surprising is happening.
 *
 * Only for the inferred case. Somebody who wrote `ASSIST_PROVIDER=fake` knows;
 * somebody who has simply not set a key yet may not, and a one-line warning
 * the first time is cheaper than wondering why the titles are always the same.
 */
export function assistFallbackWarning(env: AssistEnvironment): string | null {
  if ((env.ASSIST_PROVIDER ?? "").trim() !== "") return null;
  if ((env.ANTHROPIC_API_KEY ?? "").trim() !== "") return null;
  if (env.NODE_ENV === "production") return null;
  return "[assist] No ANTHROPIC_API_KEY, so the brainstorm is answering from lib/assist/fake.ts. Set ANTHROPIC_API_KEY to ask Claude, or ASSIST_PROVIDER=fake to silence this.";
}
