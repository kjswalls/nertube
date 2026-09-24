import { AppShell } from "@/components/app-shell";
import { SettingsHeader } from "@/components/settings/settings-header";
import { TimeZoneForm } from "@/components/settings/time-zone-form";
import {
  formatDateColumn,
  formatInstant,
  timeZoneGroups,
  todayColumn,
} from "@/lib/calendar-dates";
import { SpendingForm, type SpendingView } from "@/components/settings/spending-form";
import {
  DEFAULT_CAP_DOLLARS,
  formatMicros,
  isOverCap,
  meanCallMicros,
  MOST_EXPENSIVE,
  readBudget,
  type SpendBudget,
} from "@/lib/assist/spend";
import { requireUser } from "@/lib/supabase/require-user";
import { readTimeZone } from "@/lib/time-zone-data";
import { readClock } from "@/lib/request-clock";

export const metadata = { title: "Time zone and spending · settings · NerTube" };

/**
 * `/settings/account` — the user's time zone (M10).
 *
 * The one setting that belongs to the person rather than to a channel, so it
 * has one address with no slug and the channel switch is not drawn. It is the
 * zone every "today" in the app is computed in (the calendar's ring, `/now`'s
 * go-live check, the board's filming badge, the matrix's month) and every
 * timestamp is shown in (published, swapped, captured). It is stored per user
 * in the database, so the phone and the laptop agree.
 *
 * The list is built here, on the server, from this runtime's
 * `Intl.supportedValuesOf("timeZone")` with each zone's offset *today* — the
 * browser's list differs from Node's, so a list built in the browser would not
 * hydrate. The page also says what today is in the stored zone, from the same
 * clock read, as the plain confirmation that the setting did what it says.
 */
export default async function AccountSettingsPage() {
  const { supabase } = await requireUser();

  // The page's one clock read, and the zone, once each.
  const now = await readClock();
  const timeZone = await readTimeZone();

  const today = todayColumn(now, timeZone.zone);

  // M11: this month's API spending, in the same zone and from the same clock
  // read as the "today" line above it.
  let budget: SpendBudget | null = null;
  try {
    budget = await readBudget(supabase, now, timeZone.zone);
  } catch {
    budget = null;
  }

  return (
    <AppShell section="settings" gutter="reading" now={now}>
      <div
        data-testid="settings-account"
        className="flex w-full max-w-3xl flex-col gap-6"
      >
        <SettingsHeader section="account">
          <p>
            The zone your day is counted in: when the calendar turns over to
            tomorrow, when a scheduled video is due, and the dates on anything
            you published, swapped or captured. It is saved to your account, so
            every device you sign in on uses the same one. Below it, what the
            brainstorm has cost on the API this month, and the cap on it.
          </p>
        </SettingsHeader>

        <TimeZoneForm
          groups={timeZoneGroups(now)}
          initial={timeZone.zone}
          known={timeZone.known}
          source={timeZone.source}
          todayLabel={formatDateColumn(today, "full") ?? today}
          timeLabel={formatInstant(now, timeZone.zone, "time") ?? ""}
        />

        {budget ? (
          <SpendingForm view={spendingView(budget)} />
        ) : (
          <section
            id="spending"
            data-testid="settings-spending-unreadable"
            className="rounded-card border border-border bg-surface px-4 py-4 text-[13px] leading-5 text-muted"
          >
            This month&rsquo;s API spending could not be read, so the cap cannot be shown or
            changed right now. While it cannot be read, the brainstorm does not call the API at
            all — Open in Claude still works. Reload to try again.
          </section>
        )}
      </div>
    </AppShell>
  );
}

/** The numbers the spending section shows, formatted here on the server. */
function spendingView(budget: SpendBudget): SpendingView {
  const mean = meanCallMicros(budget);
  const cap = budget.cap.dollars;
  return {
    monthLabel: budget.month.label,
    resets: budget.month.resets,
    spent: formatMicros(budget.spendMicros),
    calls: budget.calls,
    mean: mean === null ? null : formatMicros(mean),
    assumedCalls: budget.assumedCalls,
    estimatedCalls: budget.estimatedCalls,
    capDollars: cap,
    capSource: budget.cap.source,
    defaultCap: DEFAULT_CAP_DOLLARS,
    used: cap === null ? null : cap === 0 ? 1 : budget.spendMicros / (cap * 1_000_000),
    // The same comparison the reservation makes, so the meter and the words
    // never say "reached" while the next call would still go (review, 3).
    atCap: isOverCap(budget),
    assumedRate: `$${MOST_EXPENSIVE.input} in and $${MOST_EXPENSIVE.output} out per million tokens`,
  };
}
