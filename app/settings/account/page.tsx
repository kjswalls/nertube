import { AppShell } from "@/components/app-shell";
import { SettingsHeader } from "@/components/settings/settings-header";
import { TimeZoneForm } from "@/components/settings/time-zone-form";
import {
  formatDateColumn,
  formatInstant,
  timeZoneGroups,
  todayColumn,
} from "@/lib/calendar-dates";
import { requireUser } from "@/lib/supabase/require-user";
import { readTimeZone } from "@/lib/time-zone-data";
import { readClock } from "@/lib/request-clock";

export const metadata = { title: "Time zone · settings · NerTube" };

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
  await requireUser();

  // The page's one clock read, and the zone, once each.
  const now = await readClock();
  const timeZone = await readTimeZone();

  const today = todayColumn(now, timeZone.zone);

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
            every device you sign in on uses the same one.
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
      </div>
    </AppShell>
  );
}
