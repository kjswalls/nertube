"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useSyncExternalStore } from "react";

import { setTimeZone } from "@/app/actions/time-zone";
import { SaveStatus, useSaveQueue } from "@/components/autosave";
import {
  canonicalTimeZone,
  timeZoneCity,
  type TimeZone,
  type TimeZoneGroup,
} from "@/lib/calendar-dates";

/**
 * The time zone picker (M10).
 *
 * A native `<select>` grouped by area — the phone's own picker, which is the
 * comfortable way to choose one of four hundred names with a thumb, and on a
 * desktop a list you can type a city's first letters into. Beside it, once the
 * page has hydrated, a one-press "Use <city>" for the zone this device is in
 * when that differs from the saved one.
 *
 * ## Saved with Save, not on change
 *
 * An arrow key on a closed `<select>` changes its value and fires `change` on
 * Windows and Linux (the M9 review found the stage select moving a video on
 * one ArrowDown). Saving on `change` would write a zone per keypress while the
 * person browsed the list, and each write re-renders every date on every page.
 * So a choice is a choice until Save is pressed; Escape puts it back.
 *
 * The write goes through `useSaveQueue`, the application's one save queue, so
 * the status line, Retry and the signed-out sentence are the ones every other
 * setting has. After it lands the server components are refreshed: the
 * "today" line below the picker, and the sidebar's counts, are the server's.
 */
export function TimeZoneForm({
  groups,
  initial,
  known,
  source,
  todayLabel,
  timeLabel,
}: {
  groups: readonly TimeZoneGroup[];
  /** The stored zone, or UTC while none is (`known` false). */
  initial: TimeZone;
  known: boolean;
  source: "detected" | "chosen" | null;
  /** Today in the stored zone, in words, from the server's clock. */
  todayLabel: string;
  /** The time now in the stored zone (`14:05`), from the same clock read. */
  timeLabel: string;
}) {
  const router = useRouter();
  const selectId = useId();
  const statusId = `${selectId}-status`;

  const [saved, setSaved] = useState<TimeZone>(initial);
  const [choice, setChoice] = useState<TimeZone>(initial);
  // A fresh server render (after a save here, or a change on another device
  // picked up by a refresh) is the new baseline.
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setSaved(initial);
    setChoice(initial);
  }

  /*
    This device's zone. `null` on the server and during hydration (the server
    cannot know it, so rendering it there would not hydrate), the real answer
    on the render after — which is what `useSyncExternalStore` with a server
    snapshot is for.
  */
  const device = useSyncExternalStore(noSubscription, deviceTimeZone, () => null);

  const queue = useSaveQueue<TimeZone>({
    merge: (_, next) => next,
    save: async (zone) => {
      const result = await setTimeZone(zone);
      if (!result.ok) return { ok: false, error: result.error };
      setSaved(result.zone);
      setChoice(result.zone);
      router.refresh();
      return { ok: true };
    },
  });

  const dirty = choice !== saved;
  const offerDevice = device !== null && device !== saved && device !== choice;
  const listed = groups.some((group) => group.zones.some((zone) => zone.value === choice));

  return (
    <section
      aria-labelledby={`${selectId}-heading`}
      className="flex flex-col gap-4 rounded-card border border-border bg-surface px-4 py-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${selectId}-heading`} className="text-[13px] font-semibold">
          Your time zone
        </h2>
        <p data-testid="time-zone-today" className="text-[13px] leading-5 text-muted">
          {known ? (
            <>
              {/*
                The city is the server's, like the date and the time beside
                it (M10 integration): naming the zone just saved while the
                date was still the old zone's read "Wednesday … in Kiritimati,
                where it is 13:34" for the moment before the refresh landed.
              */}
              Today is <span className="text-foreground">{todayLabel}</span> in{" "}
              {timeZoneCity(initial)}
              {timeLabel ? (
                <>
                  , where it is{" "}
                  <span className="font-mono text-foreground">{timeLabel}</span>
                </>
              ) : null}
              .
              {source === "detected" ? " Taken from your browser when you first signed in." : ""}
            </>
          ) : (
            <>
              No time zone is saved yet, so dates follow UTC — today is{" "}
              <span className="text-foreground">{todayLabel}</span> there. Pick yours below.
            </>
          )}
        </p>
      </div>

      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-center"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty) queue.send(choice);
        }}
      >
        <label htmlFor={selectId} className="sr-only">
          Time zone
        </label>
        <select
          id={selectId}
          name="timeZone"
          data-testid="time-zone-select"
          value={choice}
          aria-describedby={statusId}
          onChange={(event) => {
            queue.touch();
            setChoice(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && dirty) {
              event.preventDefault();
              setChoice(saved);
            }
          }}
          className="min-w-0 flex-1 rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent md:text-[13px] thumb:min-h-11"
        >
          {listed ? null : <option value={choice}>{choice}</option>}
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.zones.map((zone) => (
                <option key={zone.value} value={zone.value}>
                  {zone.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          type="submit"
          data-testid="time-zone-save"
          aria-disabled={!dirty || queue.pending || undefined}
          className="shrink-0 rounded-button border border-accent px-3 py-2 text-sm font-medium outline-none hover:bg-accent/10 focus-visible:ring-2 focus-visible:ring-accent aria-disabled:border-border aria-disabled:text-muted aria-disabled:hover:bg-transparent thumb:min-h-11"
        >
          Save
        </button>
      </form>

      {offerDevice ? (
        <p className="text-[13px] leading-5 text-muted">
          This device is in {timeZoneCity(device)}.{" "}
          <button
            type="button"
            data-testid="time-zone-use-device"
            onClick={() => {
              setChoice(device);
              queue.send(device);
            }}
            className="rounded-button border border-border px-2 py-0.5 font-medium text-foreground outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11 thumb:px-3"
          >
            Use {timeZoneCity(device)}
          </button>
        </p>
      ) : null}

      <SaveStatus
        id={statusId}
        state={queue.state}
        testId="time-zone-status"
        idle={dirty ? "Not saved yet — press Save, or Escape to put it back." : ""}
        onRetry={(zone) => queue.send(zone)}
      />
    </section>
  );
}

/** Nothing to subscribe to: a device's zone does not change under a page. */
function noSubscription(): () => void {
  return () => {};
}

function deviceTimeZone(): TimeZone | null {
  try {
    return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}
