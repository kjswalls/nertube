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

  /*
    The one page with no sidebar — there is nothing to navigate to yet — but
    the same two themes, the same three faces and the same metrics as
    everything behind it: the name in Newsreader because it is the product's
    own name, the form in Instrument Sans, the 40px reading gutter, and the
    theme decided before the first paint by the same script every other page
    runs. Signing in should look like stepping into the workspace, not like
    arriving at a different product.
  */
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-gutter-reading py-16">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-[26px] leading-tight font-semibold tracking-tight">
          NerTube
        </h1>
        <p className="text-[13px] text-muted">Sign in to your pipeline.</p>
      </div>

      <LoginForm next={target} />
    </main>
  );
}
