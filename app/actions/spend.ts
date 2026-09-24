"use server";

import { z } from "zod";

import { MAX_CAP_DOLLARS } from "@/lib/assist/spend";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * The monthly API spending cap, written from Settings (M11).
 *
 * The one write path to `assist_caps` is `set_assist_cap()` (migration 0011);
 * the client holds no INSERT or UPDATE on the table. `null` means "no cap";
 * a whole number of dollars from 0 to {@link MAX_CAP_DOLLARS} is a cap. The
 * application's default for somebody who has never saved one lives in
 * `lib/assist/spend.ts`, beside the check that enforces it.
 */

export type SetCapResult =
  | { ok: true; dollars: number | null }
  | { ok: false; error: string };

const Dollars = z.union([z.null(), z.number().int().min(0).max(MAX_CAP_DOLLARS)]);

export async function setAssistCap(dollars: number | null): Promise<SetCapResult> {
  const parsed = Dollars.safeParse(dollars);
  if (!parsed.success) {
    return {
      ok: false,
      error: `A cap is a whole number of dollars from 0 to ${MAX_CAP_DOLLARS.toLocaleString("en-US")}, or empty for no cap.`,
    };
  }

  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("set_assist_cap", { p_dollars: parsed.data });
  if (error) {
    return { ok: false, error: "The cap could not be saved. Nothing changed — try again." };
  }
  return { ok: true, dollars: data?.cap_dollars ?? null };
}
