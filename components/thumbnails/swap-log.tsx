import { useTimeZone } from "@/components/time-zone";
import { formatInstant, type TimeZone } from "@/lib/calendar-dates";
import { isThumbnailRole } from "@/lib/storage";

import { ROLE_LABEL } from "./roles";

/**
 * The swap log: date, from, to, reason. Newest first, and append-only.
 *
 * ## Append-only is a database fact, not a policy this renders politely
 *
 * `0001_init.sql` revokes UPDATE and DELETE on `thumbnail_swaps` from
 * `authenticated` entirely, and grants INSERT on a column list that leaves out
 * `swapped_at` so only the column default can set it. There is therefore no
 * control on this page to edit or delete a row, because there is no request the
 * browser could send that would. A log that could be tidied up is not a log.
 *
 * Every row here was written by `swap_thumbnail` in the same transaction as the
 * `shipped_role` it describes, so the list and the "Live" badge above it cannot
 * disagree: a swap that failed left no row, and a row that exists means the
 * role changed.
 *
 * The first entry of any video has `from_role` null — nothing was replaced —
 * and reads as the launch choice rather than as a swap from nowhere.
 */
export interface SwapEntry {
  readonly id: string;
  /** ISO. */
  readonly swappedAt: string;
  readonly fromRole: string | null;
  readonly toRole: string;
  readonly reason: string;
}

function roleName(value: string | null): string {
  if (value === null) return "—";
  return isThumbnailRole(value) ? ROLE_LABEL[value] : value;
}

/**
 * When a swap happened, in the user's zone (M10) and a fixed locale: this is
 * rendered on the server and hydrated in the browser, and both format with
 * the zone the server read, never the machine's.
 */
function formatWhen(iso: string, zone: TimeZone): string {
  return formatInstant(iso, zone, "dateTime") ?? iso;
}

export function SwapLog({ entries }: { entries: readonly SwapEntry[] }) {
  const zone = useTimeZone();
  return (
    <section aria-labelledby="swap-log-heading" className="flex flex-col gap-2">
      <h3 id="swap-log-heading" className="text-sm font-semibold">
        Swap log
      </h3>

      {entries.length === 0 ? (
        <p data-testid="swap-log-empty" className="text-xs text-muted">
          Nothing shipped yet. Every change of the live thumbnail is recorded
          here with its reason, and nothing here can be edited or removed
          afterwards.
        </p>
      ) : (
        <ol data-testid="swap-log" className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li
              key={entry.id}
              data-testid="swap-log-row"
              data-from={entry.fromRole ?? ""}
              data-to={entry.toRole}
              className="flex flex-col gap-1 rounded-input border border-border bg-surface px-3 py-2"
            >
              <p className="flex flex-wrap items-baseline gap-2 text-xs">
                <time
                  dateTime={entry.swappedAt}
                  className="font-mono text-[11px] text-muted"
                >
                  {formatWhen(entry.swappedAt, zone)}
                </time>
                <span data-testid="swap-log-roles">
                  {entry.fromRole === null ? (
                    <>Shipped {roleName(entry.toRole).toLowerCase()}</>
                  ) : (
                    <>
                      {roleName(entry.fromRole)} → {roleName(entry.toRole)}
                    </>
                  )}
                </span>
              </p>
              <p
                data-testid="swap-log-reason"
                className="text-sm [overflow-wrap:anywhere]"
              >
                {entry.reason}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
