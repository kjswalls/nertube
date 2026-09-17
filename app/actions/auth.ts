"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { z } from "zod";

import { safePath } from "@/lib/safe-path";
import { createClient } from "@/lib/supabase/server";

/** What the login form renders. `null` before the first submit. */
export type SignInState = { error: string } | null;

const Credentials = z.object({
  email: z.email(),
  password: z.string().min(1),
});

/**
 * Email + password sign-in. There is no sign-up action: NerTube has exactly
 * one user, created once from the Supabase dashboard (or by
 * `scripts/seed-demo.ts`), after which signups are disabled.
 */
export async function signIn(
  _prevState: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const parsed = Credentials.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: "Enter an email address and a password." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    // "Invalid login credentials" and friends come from the auth server and say
    // something useful. A transport failure arrives as Node's bare "fetch
    // failed", which under the password field reads as "your password is wrong"
    // when the truth is that nothing is listening at NEXT_PUBLIC_SUPABASE_URL.
    if (isAuthRetryableFetchError(error) || error.status === undefined) {
      return {
        error:
          "Could not reach the authentication server. Check that Supabase is running and that NEXT_PUBLIC_SUPABASE_URL is right.",
      };
    }
    return { error: error.message };
  }

  // The signed-out render of every page is now stale.
  revalidatePath("/", "layout");
  redirect(safePath(formData.get("next")));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();

  revalidatePath("/", "layout");
  redirect("/login");
}
