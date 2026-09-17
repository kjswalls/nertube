import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

import type { Database } from "@/lib/database.types";

import { supabaseEnv } from "./env";

/**
 * Supabase client for server components, server actions and route handlers.
 *
 * Create a new one per request — never cache one across requests, or a
 * refreshed session leaks between them.
 *
 * `cookies()` is async in Next 16, hence the `await`.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = supabaseEnv();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server components cannot write cookies, and a token refresh during
          // a render lands here. Safe to swallow: `proxy.ts` runs before every
          // matched request and writes refreshed cookies onto its own response,
          // so the session is still kept current.
        }
      },
    },
  });
}
