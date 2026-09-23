import { revalidatePath } from "next/cache";
import { cache } from "react";

import { canonicalTimeZone, UTC, type TimeZone } from "@/lib/calendar-dates";
import { createClient } from "@/lib/supabase/server";

/**
 * The signed-in user's time zone, as this request uses it.
 *
 * `known` is false until a zone has been recorded for this user — detected
 * from their browser at sign-in or on first use, or chosen in Settings — and
 * `zone` is then `UTC`, which is what every "today" meant before M10. The
 * calendar, `/now` and Settings say so while it is false.
 */
export interface UserTimeZone {
  readonly zone: TimeZone;
  readonly known: boolean;
  /** Who decided: the browser (`detected`) or the person (`chosen`). */
  readonly source: "detected" | "chosen" | null;
}

const UNKNOWN: UserTimeZone = { zone: UTC, known: false, source: null };

/**
 * Read once per request, like the clock.
 *
 * `cache()` memoises per request, so the shell, the page and a server action
 * that all ask get the same answer from one query — which is what stops two
 * parts of one page from disagreeing about what day it is.
 *
 * It never throws and never blocks a render on anything but its own query: a
 * failed read, or no row, is "not known yet" and the page renders in UTC with
 * the sentence that says so. Its own `createClient()` rather than
 * `requireUser()`, because the latter is a round trip to the auth server and
 * every page has already made it; RLS scopes the select to the caller, so a
 * request with no user simply finds no row.
 *
 * A stored name that this runtime's `Intl` cannot use (a tzdata newer on the
 * database than in Node) is treated as unknown rather than passed to a
 * formatter that would throw during render.
 */
export const readTimeZone = cache(async (): Promise<UserTimeZone> => {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("profiles")
      .select("time_zone, time_zone_source")
      .maybeSingle();
    if (error || !data) return UNKNOWN;
    const zone = canonicalTimeZone(data.time_zone);
    if (zone === null) return UNKNOWN;
    return { zone, known: true, source: data.time_zone_source };
  } catch {
    return UNKNOWN;
  }
});

export type SetTimeZoneResult =
  | { ok: true; zone: TimeZone; source: "detected" | "chosen" }
  | { ok: false; error: string };

type Supabase = Awaited<ReturnType<typeof createClient>>;

const NOT_A_ZONE =
  "That is not a time zone this app knows. Pick one from the list — a city in your zone, or UTC.";

/**
 * The one writer, behind `app/actions/time-zone.ts` and `signIn`
 * (`app/actions/auth.ts`, which records the browser's zone in the request that
 * signs the user in). Not itself a server action: it takes the request's
 * client, which a browser could not supply.
 */
export async function writeTimeZone(
  supabase: Supabase,
  raw: unknown,
  detected: boolean,
): Promise<SetTimeZoneResult> {
  const zone = canonicalTimeZone(raw);
  if (zone === null) return { ok: false, error: NOT_A_ZONE };

  const { data, error } = await supabase.rpc("set_time_zone", {
    p_zone: zone,
    p_detected: detected,
  });
  if (error) {
    // 22023 is the function's own refusal: Intl knows the name, the database's
    // tz catalogue does not (an older tzdata than the browser's).
    if (error.code === "22023") return { ok: false, error: NOT_A_ZONE };
    return { ok: false, error: `That did not save: ${error.message}` };
  }
  if (!data) return { ok: false, error: "That did not save: no answer from the database." };

  // Every page that says what day it is.
  revalidatePath("/", "layout");
  return { ok: true, zone: data.time_zone, source: data.time_zone_source };
}

