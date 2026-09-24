import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

import { supabaseEnv } from "./env";

/**
 * Refresh the Supabase session for one request and guard the route.
 *
 * Called from the root `proxy.ts` (Next 16's renamed middleware). Two jobs:
 *
 * 1. Call `getClaims()`, which refreshes an expired access token and writes the
 *    new cookies onto the outgoing response. Server components cannot write
 *    cookies, so if this did not happen here the session would quietly expire.
 * 2. Send anyone without a user to `/login`.
 *
 * `/login` runs through job 1 and skips job 2. It cannot be left out of the
 * matcher instead: the login page calls `getUser()` too, and an expired token
 * would then be rotated at Supabase with nowhere to put the new cookies —
 * consuming the refresh token and signing the user out by visiting the page
 * they came to sign in on.
 *
 * `getClaims()` — never `getSession()`: `getSession()` trusts whatever is in the
 * cookie, `getClaims()` verifies the token's signature. It refreshes an expired
 * token first, exactly as `getUser()` did, so job 1 is unchanged. With
 * asymmetric signing keys it verifies locally against the cached
 * public key instead of asking the auth server; with a legacy shared secret it
 * falls back to `getUser()` itself, so it is never slower. This is only the
 * gate: every page and action still authorizes with `requireUser()`'s
 * `getUser()`, and every query with RLS.
 */
export async function updateSession(request: NextRequest) {
  // Reassigned by `setAll` below, so that refreshed cookies ride along.
  let response = NextResponse.next({ request });

  let url: string;
  let anonKey: string;
  try {
    ({ url, anonKey } = supabaseEnv());
  } catch (error) {
    // A fresh clone with no .env.local would otherwise 500 on every URL with
    // nothing on screen to say why. The proxy sees every page request, so this
    // is the one place that can answer them all with the reason.
    return setupNeeded(error);
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        // `no-store` and friends: a response that sets auth cookies must never
        // be cached by Vercel's edge or any proxy in front of it.
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const user = data?.claims.sub ? data.claims : null;

  const onLoginPage = request.nextUrl.pathname === "/login";

  if (!user && !onLoginPage) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    const wanted = request.nextUrl.pathname + request.nextUrl.search;
    if (wanted !== "/") {
      loginUrl.searchParams.set("next", wanted);
    }

    const redirectResponse = NextResponse.redirect(loginUrl);
    // Carry over whatever `setAll` wrote. When a refresh token has been
    // revoked, Supabase clears the auth cookies here — dropping those clears
    // would leave the browser retrying a dead token on every request.
    for (const cookie of response.cookies.getAll()) {
      redirectResponse.cookies.set(cookie);
    }
    redirectResponse.headers.set("Cache-Control", "private, no-store");
    return redirectResponse;
  }

  return response;
}

/**
 * The page shown when the Supabase environment variables are missing. Plain
 * HTML: nothing in `app/` can render without the same variables.
 */
function setupNeeded(error: unknown) {
  const detail =
    error instanceof Error ? error.message : "Supabase is not configured.";

  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>NerTube is not configured</title></head>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>NerTube is not configured</h1><p>${escapeHtml(detail)}</p>` +
      `<p>See <code>.env.example</code> and the README.</p></body></html>`,
    {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    },
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
