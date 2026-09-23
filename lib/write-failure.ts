/**
 * Why a write never got an answer — for the sentence that goes under it.
 *
 * ## The defect this exists for (M9)
 *
 * Every write in the app is a server action, and every caller catches the
 * action's rejection and says "Could not reach the server … try again". That
 * is right when the network is gone. It was also what a person saw when their
 * **session** had gone — signed out in another tab, a refresh token revoked —
 * because `proxy.ts` answers a signed-out request with a redirect to `/login`,
 * the action's fetch follows it to an HTML page it cannot parse, and the
 * promise rejects exactly as if the server had been down. The sentence was
 * false, and its way forward (Retry) could never work: every retry was
 * redirected the same way. M9's walk found it by clearing the cookies mid-edit
 * on the video page.
 *
 * ## How it tells them apart
 *
 * Only after a failure, and with one request: a `HEAD` for the page the person
 * is on, not following redirects. `proxy.ts` is the thing that decides
 * "signed out", and it answers a signed-out request with a redirect — which a
 * `redirect: "manual"` fetch reports as an `opaqueredirect`. Any other answer
 * means the server is there and the session is fine, so the failure really was
 * the request; no answer at all means the server is not reachable. The
 * browser's own offline flag is checked first, because it is free.
 *
 * Nothing here signs anyone in or retries anything. It chooses the words.
 */

export type WriteFailure = "offline" | "signed-out" | "unreachable";

export async function diagnoseWriteFailure(): Promise<WriteFailure> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "offline";
  }
  try {
    const response = await fetch(
      `${window.location.pathname}${window.location.search}`,
      {
        method: "HEAD",
        redirect: "manual",
        cache: "no-store",
        credentials: "same-origin",
      },
    );
    return response.type === "opaqueredirect" || response.status === 401
      ? "signed-out"
      : "unreachable";
  } catch {
    return "unreachable";
  }
}

/** The sentence for a signed-out write. The Sign-in link sits beside it. */
export const SIGNED_OUT =
  "You have been signed out, so this is not saved. What you typed is still here — sign in again in another tab, then try again here.";

/** The sentence for a browser that knows it is offline. */
export const OFFLINE =
  "Could not reach the server — this browser is offline — so this is not saved. What you typed is still here; Retry once you are back.";

/**
 * Where "sign in again" goes: `/login` in a **new tab**, returning to this
 * page there. A new tab because this one is holding unsaved text, and a
 * navigation would take it away; the session cookie is shared, so once the
 * other tab has signed in, Retry here goes through.
 */
export function signInAgainHref(): string {
  const here = `${window.location.pathname}${window.location.search}`;
  return `/login?next=${encodeURIComponent(here)}`;
}

/**
 * The failure's sentence: the caller's own "could not reach the server" line
 * when that is what happened, and the shared one when it was something else.
 */
export function failureSentence(kind: WriteFailure, unreachable: string): string {
  return kind === "signed-out" ? SIGNED_OUT : kind === "offline" ? OFFLINE : unreachable;
}
