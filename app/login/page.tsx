import { redirect } from "next/navigation";

import { safePath } from "@/lib/safe-path";
import { createClient } from "@/lib/supabase/server";

import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · NerTube" };

/**
 * The one public route (`proxy.ts` excludes it from the auth matcher).
 *
 * There is no sign-up form on purpose: NerTube is single-user, so the one
 * account is created once in the Supabase dashboard and signups are then
 * turned off (`[auth] enable_signup = false`). See the README.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // `?next=` is attacker-controllable: `safePath` is the one copy of the check,
  // shared with the `signIn` action that later redirects to the same value.
  const { next } = await searchParams;
  const target = safePath(Array.isArray(next) ? next[0] : next);

  if (user) {
    redirect(target);
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-4 py-16">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">NerTube</h1>
        <p className="text-sm text-muted">Sign in to your pipeline.</p>
      </div>

      <LoginForm next={target} />
    </main>
  );
}
