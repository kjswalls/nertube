import "server-only";

import { cookies } from "next/headers";

import { readClock } from "@/lib/request-clock";
import { readTimeZone } from "@/lib/time-zone-data";

import {
  selectAssistMode,
  selectAssistProvider,
  type AssistMode,
  type AssistProviderName,
} from "./select";
import { capReachedOf, isOverCap, readBudget, type SpendClient } from "./spend";
import { readAssistStub } from "./test-stub";
import type { CapReached } from "./types";

/**
 * Which way an assist goes for this request — the one place that decides it.
 *
 * Two questions, answered here for both the page and the server action:
 *
 * 1. **Which implementation answers a pill** ({@link chooseProvider}): the
 *    environment's rule (`selectAssistProvider`), unless this request is the
 *    browser suite's stubbed real provider. `app/actions/assist.ts` asks this
 *    before every call; the page asks it below. They used to be two copies.
 * 2. **What the panels lead with** ({@link readAssistView}): the API, or Open
 *    in Claude. `selectAssistMode` over the environment, and then — the M11
 *    integration's addition — the spending cap: when a real provider would
 *    answer and this month's spending has already reached the cap, the page
 *    is served in the `manual` mode, so the panel opens on a working Open in
 *    Claude with the reason beside it rather than on a pill that can only be
 *    refused.
 *
 * Server-only because it reads the environment the key lives in. The browser
 * learns one word — `api` or `manual` — plus, when the cap is the reason, the
 * two amounts and the day it resets, already formatted.
 *
 * ## The test switches
 *
 * The browser suite runs one production server with `ASSIST_PROVIDER=fake`,
 * so every M8 spec keeps its fixtures. Two cookies, each honoured only when
 * `playwright.config.ts` started the server with its variable, let a spec see
 * the other configurations without a second server:
 *
 * - `nertube-test-assist-mode` (`manual` | `api`, needs
 *   `NERTUBE_TEST_ASSIST_MODE=1`) picks the mode, as a keyless deployment
 *   would see it. It cannot choose a provider, reach the key, or change what
 *   any action does.
 * - `nertube-test-assist=stub` (needs `NERTUBE_TEST_ANTHROPIC_STUB`,
 *   `lib/assist/test-stub.ts`) makes the real provider answer, against a local
 *   stub, so the cap can be walked.
 *
 * Both are the shape of the test clock (`lib/request-clock.ts`): without the
 * variable the cookie is never read.
 */
export const TEST_ASSIST_MODE_COOKIE = "nertube-test-assist-mode";

/** Which implementation answers this request, and — in the browser suite only — where. */
export interface ChosenProvider {
  readonly name: AssistProviderName;
  readonly stub: { readonly baseURL: string } | null;
}

/**
 * `selectAssistProvider`'s answer, unless this request is the browser suite's
 * stubbed real provider (`lib/assist/test-stub.ts`, off unless the server was
 * started with `NERTUBE_TEST_ANTHROPIC_STUB`).
 */
export async function chooseProvider(): Promise<ChosenProvider> {
  const stub = await readAssistStub();
  if (stub) return { name: "anthropic", stub };
  return { name: selectAssistProvider(process.env), stub: null };
}

/** The mode the environment (or the suite's cookie) asks for, before the cap. */
export async function readAssistMode(): Promise<AssistMode> {
  if (process.env.NERTUBE_TEST_ASSIST_MODE === "1") {
    const value = (await cookies()).get(TEST_ASSIST_MODE_COOKIE)?.value;
    if (value === "manual" || value === "api") return value;
  }
  return selectAssistMode(process.env);
}

export interface AssistView {
  readonly mode: AssistMode;
  /** Set when the mode is `manual` *because* the cap has been reached. */
  readonly capReached: CapReached | null;
}

/**
 * What the video page hands its three assist controls.
 *
 * The cap is read only when it could matter: the mode is `api` and the answer
 * would come from the real provider. The fixtures cost nothing and are never
 * capped, and the keyless mode never calls anything, so neither pays for the
 * read. When it is read and cannot be (0011 missing, a hiccup), the page
 * stays on the API: the pill's own ask refuses with the sentence that says
 * so, and that refusal opens Open in Claude by itself. Drawing the page must
 * not fail over a number only one button needs.
 *
 * Checked when the page is drawn, and again by the action before every call
 * (`app/actions/assist.ts`), which is the check that actually holds the line:
 * this one only decides what the panel leads with.
 */
export async function readAssistView(supabase: SpendClient): Promise<AssistView> {
  const mode = await readAssistMode();
  if (mode !== "api") return { mode, capReached: null };
  if ((await chooseProvider()).name !== "anthropic") return { mode, capReached: null };

  try {
    const budget = await readBudget(supabase, await readClock(), (await readTimeZone()).zone);
    if (isOverCap(budget)) return { mode: "manual", capReached: capReachedOf(budget) };
  } catch (error) {
    console.warn(
      `[assist] this month's spending could not be read for the page, so it leads with the API: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { mode, capReached: null };
}
