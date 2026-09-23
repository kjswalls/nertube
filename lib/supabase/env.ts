/**
 * The two Supabase settings the app needs, read lazily.
 *
 * Lazily matters: `next build` compiles every module without a live Supabase
 * project, so reading (and throwing on) these at module scope would break the
 * build. Reading them inside a function moves the failure to the first request
 * that actually needs Supabase, where the message can name the variable.
 *
 * Only the two `NEXT_PUBLIC_` values live here. The service-role key is never
 * read anywhere in the app — it belongs to `scripts/` alone.
 */
export function supabaseEnv(): { url: string; anonKey: string } {
  // Spelled out in full, not built from a variable: the Next bundler inlines
  // `process.env.NEXT_PUBLIC_*` by literal text substitution for the browser.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    const names = [
      url ? null : "NEXT_PUBLIC_SUPABASE_URL",
      anonKey ? null : "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    ].filter((name): name is string => name !== null);
    throw new Error(
      `${names.join(" and ")} ${names.length === 1 ? "is" : "are"} not set. ` +
        "Copy .env.example to .env.local and fill it in — `npm run dev:stack` prints both " +
        "values, and so does `supabase start` on the Docker path.",
    );
  }

  return { url, anonKey };
}
