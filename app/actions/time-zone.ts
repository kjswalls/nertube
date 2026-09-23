"use server";

import { requireUser } from "@/lib/supabase/require-user";
import { writeTimeZone, type SetTimeZoneResult } from "@/lib/time-zone-data";

/**
 * The two writes to the user's time zone (M10). Both go through
 * `set_time_zone()` (migration 0010), the only write path to
 * `public.profiles`; the client holds no INSERT or UPDATE grant on it.
 *
 * The zone is canonicalised here first — `Intl` must be able to format with
 * it, it must have the IANA shape, and a name `Intl` spells the old way
 * (`Asia/Calcutta`) is stored the current way (`Asia/Kolkata`) — and the
 * database then checks that its own tz catalogue knows the name. That part is
 * `writeTimeZone` in `lib/time-zone-data.ts`, shared with `signIn`.
 */

/** Settings: the person picked a zone. Always replaces what is stored. */
export async function setTimeZone(zone: string): Promise<SetTimeZoneResult> {
  const { supabase } = await requireUser();
  return writeTimeZone(supabase, zone, false);
}

/**
 * First use: the browser's own zone, recorded only if nothing is stored yet —
 * so a laptop in another zone never overwrites what the phone chose. Answers
 * with whatever is stored afterwards, which may not be the zone sent.
 */
export async function recordDetectedTimeZone(zone: string): Promise<SetTimeZoneResult> {
  const { supabase } = await requireUser();
  return writeTimeZone(supabase, zone, true);
}
