import { redirect } from "next/navigation";

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
 */
export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return { supabase, user };
}
