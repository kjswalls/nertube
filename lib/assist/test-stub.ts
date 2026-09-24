import "server-only";

import { cookies } from "next/headers";

/**
 * The browser suite's way to drive the **real** provider against a stub (M11).
 *
 * The whole suite runs with `ASSIST_PROVIDER=fake`, which is right for every
 * spec but one: the spending cap has to be shown refusing, recording and
 * letting through *real* calls, and the fixtures record nothing and are never
 * refused. So `e2e/spend-cap.spec.ts` starts a local HTTP server that answers
 * like `/v1/messages`, and this lets its requests — and only its — use
 * `lib/assist/anthropic.ts`, pointed at that server. The SDK, the request it
 * builds, the usage it reads back, the pricing and the database write are all
 * the ones that ship; only the far end of the socket is a stub. It is the
 * browser-level twin of `anthropic.test.ts`'s injected `fetch`, and the
 * sibling of `NERTUBE_TEST_CLOCK` (`lib/request-clock.ts`).
 *
 * Two keys, both required:
 *
 * - `NERTUBE_TEST_ANTHROPIC_STUB`, the stub's origin, set on the server only
 *   by `playwright.config.ts`. Unset — everywhere but the browser suite — the
 *   cookie below is never read.
 * - the `nertube-test-assist` cookie, set to `stub` by the one spec.
 *
 * What it cannot do, even if the variable were ever set in a deployment: the
 * address comes from the environment, never from the request, so a cookie
 * cannot point the app at a host of its choosing; and the key sent there is
 * {@link STUB_API_KEY}, never `ANTHROPIC_API_KEY`, so the real key never goes
 * anywhere but Anthropic.
 */
export const TEST_ASSIST_COOKIE = "nertube-test-assist";

/** The key the stub is sent. Not a credential: the stub accepts anything. */
export const STUB_API_KEY = "nertube-e2e-stub-key";

/** The stub's origin, when this request asked for it and the server allows it. */
export async function readAssistStub(): Promise<{ baseURL: string } | null> {
  const baseURL = (process.env.NERTUBE_TEST_ANTHROPIC_STUB ?? "").trim();
  if (baseURL === "") return null;
  const asked = (await cookies()).get(TEST_ASSIST_COOKIE)?.value;
  return asked === "stub" ? { baseURL } : null;
}
