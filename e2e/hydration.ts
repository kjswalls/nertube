import { expect } from '@playwright/test';

/**
 * Doing something to a page that may not have hydrated yet.
 *
 * ## The property this is about
 *
 * `/videos/[id]` renders on the server and its controls are real HTML before
 * any JavaScript runs — but their handlers only exist once the route has
 * hydrated. A click or a keystroke that lands in that window is swallowed
 * silently: the button depresses, the text goes into the box, and nothing
 * happens, because React has not attached anything to it yet.
 *
 * M4 widened that window. All five sections stay mounted — that is M3's
 * decision and `e2e/preview.spec.ts` asserts it, because it is what makes
 * switching sections free of consequences for a half-typed field — and in M4
 * two of the five stopped being a heading and a paragraph. Hydration is one
 * synchronous pass over the whole tree, so a heavier page is a longer window.
 *
 * This is not a flake in a test. It is a real property of the page, and the
 * honest fix if it ever gets worse is to make the sections lighter, **not** to
 * unmount the ones that are not showing: that would trade a swallowed first
 * click for a lost draft, which is the worse of the two.
 *
 * ## Why a retry is the right assertion and not a workaround
 *
 * A person whose click did nothing clicks again. Writing that down is more
 * faithful than a fixed wait, and it keeps the assertion about the outcome —
 * the disclosure opened, the field saved — rather than about the timing.
 *
 * What it must never do is hide a failure. `proof` is given a short timeout so
 * a genuinely broken control fails the outer deadline with the same message it
 * would have anyway, rather than hanging on the first attempt; and `act` must
 * be idempotent, because it will be run more than once.
 */
export async function untilTaken(
  /** The interaction. Run repeatedly, so it has to be safe to repeat. */
  act: () => Promise<void>,
  /** What proves the page took it. Short-deadlined; the retry is the patience. */
  proof: () => Promise<void>,
  timeout = 20_000,
): Promise<void> {
  await expect(async () => {
    await act();
    await proof();
  }).toPass({ timeout });
}
