"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, type ReactNode } from "react";

import { recordDetectedTimeZone } from "@/app/actions/time-zone";
import { UTC, type TimeZone } from "@/lib/calendar-dates";

/**
 * The user's time zone, on the client.
 *
 * The value is the **server's**: `AppShell` reads it once per request
 * (`readTimeZone()` in `lib/time-zone-data.ts`) and hands it to this provider,
 * and every client component that formats an instant or computes a day reads
 * it from here. No component asks its own browser for a zone while rendering —
 * that answer exists only in the browser, so the server's HTML would have been
 * made with a different one and React would report the mismatch (and a user
 * would see the date jump).
 */
interface TimeZoneValue {
  readonly zone: TimeZone;
  /** False until a zone has been recorded for this user; `zone` is UTC then. */
  readonly known: boolean;
  /** Why it is not known (`UserTimeZone.missing` in `lib/time-zone-data.ts`). */
  readonly missing: TimeZoneMissing;
}

type TimeZoneMissing = "none" | "unreadable" | "failed" | null;

const TimeZoneContext = createContext<TimeZoneValue>({
  zone: UTC,
  known: false,
  missing: null,
});

export function TimeZoneProvider({
  zone,
  known,
  missing,
  children,
}: {
  zone: TimeZone;
  known: boolean;
  missing: TimeZoneMissing;
  children: ReactNode;
}) {
  return (
    <TimeZoneContext.Provider value={{ zone, known, missing }}>
      {/*
        Only when the read worked and found no row. A row this runtime cannot
        read would refuse a detected zone (detected never overwrites) and a
        failed read would fail the write too, so either would be a write on
        every page load for nothing.
      */}
      {!known && missing === "none" ? <TimeZoneDetector /> : null}
      {children}
    </TimeZoneContext.Provider>
  );
}

/** The zone every "today" and every shown timestamp on this page uses. */
export function useTimeZone(): TimeZone {
  return useContext(TimeZoneContext).zone;
}

/** Whether that zone is the user's, or the UTC stand-in. */
export function useTimeZoneKnown(): boolean {
  return useContext(TimeZoneContext).known;
}

/**
 * One attempt per tab, not per mount or per document: `AppShell` is rendered
 * by each page, so a navigation remounts it, and a reload starts a new
 * document — a zone the database refuses would otherwise be re-sent on every
 * click or every reload. `sessionStorage` survives reloads in the tab and is
 * keyed by the zone, so a browser that moves zone tries once more. It can be
 * unavailable (a private window, blocked site data); the module flag is then
 * the fallback, which is the old once-per-document behaviour.
 */
let attempted = false;
const ATTEMPT_KEY = "nertube-time-zone-detected:";

function alreadyAttempted(zone: string): boolean {
  if (attempted) return true;
  attempted = true;
  try {
    if (window.sessionStorage.getItem(ATTEMPT_KEY + zone) !== null) return true;
    window.sessionStorage.setItem(ATTEMPT_KEY + zone, "1");
  } catch {
    // No storage: fall back to the module flag above.
  }
  return false;
}

/**
 * First use, for a session that signed in before there was anything to
 * record (sign-in itself records the zone — `app/actions/auth.ts` — so this
 * only runs for a user with no row yet).
 *
 * After hydration, in an effect, so it never blocks or alters the first
 * render: the page draws in UTC, says so (`TimeZoneNotice`), records the
 * browser's zone as *detected* — which never overwrites one chosen elsewhere —
 * and refreshes the server components once it is stored, so the dates change
 * exactly once, from the sentence that said they would.
 */
function TimeZoneDetector() {
  const router = useRouter();
  useEffect(() => {
    let zone: string;
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!zone || alreadyAttempted(zone)) return;
    recordDetectedTimeZone(zone)
      .then((result) => {
        if (result.ok) router.refresh();
      })
      .catch(() => {
        // Nothing to say: the page is already telling the user it is in UTC
        // and where to change that.
      });
  }, [router]);
  return null;
}

/**
 * The sentence that says dates are in UTC, where the difference matters
 * (the calendar and `/now`), and only while the zone is unknown.
 */
export function TimeZoneNotice() {
  const { known, missing } = useContext(TimeZoneContext);
  if (known) return null;
  return (
    <p
      data-testid="time-zone-notice"
      data-missing={missing ?? undefined}
      className="text-[12px] leading-5 text-muted"
    >
      {missing === "unreadable"
        ? "Dates here follow UTC: the time zone saved for you is not one this server can read."
        : missing === "failed"
          ? "Dates here follow UTC: your time zone could not be read."
          : "Dates here follow UTC until your time zone is set."}{" "}
      <Link
        href="/settings/account"
        className="rounded-sm underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
      >
        Set it in Settings
      </Link>
    </p>
  );
}
