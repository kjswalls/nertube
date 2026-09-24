import { redirect } from "next/navigation";
import { cache } from "react";

import { createClient } from "./server";

/**
 * The server-side guard. Every server component, server action and RPC caller
 * that touches user data starts here.
 *
 * Returns the request's client alongside the user so callers do not build a
 * second one. `getUser()`, never `getSession()`: only `getUser()` verifies the
 * token with the auth server, so only its answer is safe to authorize with.
 *
 * `redirect()` throws, so anything after this call has a real user.
 *
 * `cache()`d per request. Every data reader starts here, and a signed-in page
 * runs five or six of them (the shell, the Now count, the Ideas count, the
 * Calendar count, the page's own read). Uncached, each one was its own
 * round trip to the auth server, one after another, before any data was read;
 * that was most of the wait on every click. One verified answer per request
 * is still a verified answer. Outside a render (a server action) `cache()`
 * does not memoize, so an action still checks once per call.
 */
export const requireUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return { supabase, user };
});
