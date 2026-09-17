"use client";

import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/lib/database.types";

import { supabaseEnv } from "./env";

/**
 * Supabase client for the browser.
 *
 * **Storage only.** This client uploads thumbnail images and concept sketches
 * straight from the browser to Supabase Storage (which keeps them clear of
 * Vercel's 4.5 MB request body limit) and reads them back. Every database
 * write goes through a server action instead — see the README.
 *
 * `createBrowserClient` is a singleton by default, so calling this repeatedly
 * returns the same instance and the same auth state.
 */
export function createClient() {
  const { url, anonKey } = supabaseEnv();
  return createBrowserClient<Database>(url, anonKey);
}
