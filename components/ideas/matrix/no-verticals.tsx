import Link from "next/link";

import { settingsPath } from "@/components/settings/settings-nav";
import {
  PRIMARY_ACTION,
  QUIET_ACTION,
  StatePanel,
} from "@/components/state-panel";

import { BucketCount, QuotaMeter } from "./quota-meter";
import type { BucketTally } from "./tally";

/**
 * What the matrix shows a channel that has no topic pillars yet — which is
 * every channel, the day it is created.
 *
 * `lib/defaults.ts` seeds the eight formats from BRIEF.md and leaves the
 * verticals empty **on purpose**: the formats are a general vocabulary anyone
 * can start from, and the pillars are the thing this particular channel is
 * about. Nobody else can guess them. So the first visit to this page is
 * guaranteed to be the one where half the grid does not exist, and what it does
 * then is not a detail — it is the first thing the feature ever says.
 *
 * Three rules it follows:
 *
 * 1. **No grid.** A table with no rows, or with one invented row, would be the
 *    page pretending. It says what is missing, in the words the brief uses.
 * 2. **What it does have is still worth showing.** The formats are real, they
 *    have real counts and possibly real quotas, and one axis of the answer is
 *    better than none — so they are drawn as a strip, labelled as one axis.
 * 3. **The way to add pillars is a link to it.** Until M7 this was a
 *    control that was present and plainly unavailable, carrying the milestone
 *    on itself, because a button that opened nothing would be the dead-link
 *    mistake M1 and M3 both filed. M7 built `/settings/buckets/[slug]`, so
 *    the control is now the link it was standing in for — and it lands on
 *    the pillars axis, whose add form is the first empty thing on the page.
 */
export function NoVerticals({
  channelSlug,
  verticals,
  horizontals,
  monthLabel,
}: {
  channelSlug: string;
  verticals: readonly BucketTally[];
  horizontals: readonly BucketTally[];
  monthLabel: string;
}) {
  const missing: string[] = [];
  if (verticals.length === 0) missing.push("topic pillars");
  if (horizontals.length === 0) missing.push("formats");

  return (
    <div
      data-testid="matrix-needs-buckets"
      data-verticals={verticals.length}
      data-horizontals={horizontals.length}
      className="flex flex-col gap-5"
    >
      {/* M9: the application's one empty-state presentation. */}
      <StatePanel
        title={
          missing.length === 2
            ? "This channel has no buckets yet"
            : verticals.length === 0
              ? "No topic pillars yet"
              : "No formats yet"
        }
        actions={
          <>
            <Link
              href={settingsPath("buckets", channelSlug)}
              data-testid="add-buckets"
              className={PRIMARY_ACTION}
            >
              {/* The link says what is missing, as the heading does: pillars,
                  formats, or both. */}
              {missing.length === 2
                ? "Set up buckets"
                : verticals.length === 0
                  ? "Name your pillars"
                  : "Add formats"}
            </Link>
            <Link href={`/c/${channelSlug}/ideas`} className={QUIET_ACTION}>
              Back to the idea bank
            </Link>
          </>
        }
      >
        <p>
          The matrix crosses topic pillars with formats, and every empty
          intersection is a prompt for an idea.{" "}
          {missing.length === 2 ? (
            "This channel has neither yet."
          ) : verticals.length === 0 ? (
            <>
              This channel has the eight formats from the brief and no pillars
              yet — on purpose: formats are a vocabulary anyone can borrow, but
              the three to five topics <em>this</em> channel is about are yours
              to name.
            </>
          ) : (
            "This channel has pillars, and no formats to cross them with."
          )}
        </p>
        <p data-testid="add-buckets-note">
          Both live in the channel&rsquo;s settings, with their monthly quotas;
          one named there is a row here on the way back.
        </p>
      </StatePanel>

      {/*
        One axis is still an answer. Not called a matrix, and drawn as a list
        rather than as a one-row table, so it cannot be mistaken for the grid
        that is not there.
      */}
      {horizontals.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-medium tracking-[0.06em] text-muted uppercase">
            Formats only, until there are pillars to cross them with
          </h3>
          <ul
            data-testid="format-strip"
            className="flex flex-wrap gap-2"
          >
            {horizontals.map((column) => (
              <li
                key={column.bucket.id}
                data-testid="format-chip"
                data-bucket={column.bucket.name}
                data-total={column.total}
                className="flex min-w-[112px] flex-col gap-1 rounded-card border border-border bg-surface px-3 py-2"
              >
                <span className="font-display text-[13px] leading-tight">
                  {column.bucket.name}
                </span>
                <BucketCount total={column.total} />
                <QuotaMeter tally={column} monthLabel={monthLabel} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {verticals.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-medium tracking-[0.06em] text-muted uppercase">
            Pillars only, until there are formats to cross them with
          </h3>
          <ul className="flex flex-wrap gap-2">
            {verticals.map((row) => (
              <li
                key={row.bucket.id}
                data-testid="pillar-chip"
                data-bucket={row.bucket.name}
                data-total={row.total}
                className="flex min-w-[112px] flex-col gap-1 rounded-card border border-border bg-surface px-3 py-2"
              >
                <span className="font-display text-[13px] leading-tight">
                  {row.bucket.name}
                </span>
                <BucketCount total={row.total} />
                <QuotaMeter tally={row} monthLabel={monthLabel} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
