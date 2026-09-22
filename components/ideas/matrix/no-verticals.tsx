import Link from "next/link";

import { settingsPath } from "@/components/settings/settings-nav";

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
      <section className="flex max-w-prose flex-col gap-3 rounded-card border border-border bg-surface px-4 py-3">
        <h2 className="font-display text-[16px] leading-tight font-semibold">
          {missing.length === 2
            ? "This channel has no buckets yet"
            : verticals.length === 0
              ? "No topic pillars yet"
              : "No formats yet"}
        </h2>

        <p className="text-[13px] text-muted">
          A matrix needs both axes: {missing.join(" and ")}{" "}
          {missing.length === 2 ? "are" : "is"} missing, so there is nothing to
          cross.
        </p>

        {verticals.length === 0 ? (
          <p className="text-[13px] text-muted">
            A new channel is seeded with the eight formats from the brief and no
            pillars at all — deliberately. The formats are a vocabulary anyone
            can borrow; the pillars are the three to five topics{" "}
            <em>this</em> channel is about, and only you know them. Name them
            and the grid below has rows.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={settingsPath("buckets", channelSlug)}
            data-testid="add-buckets"
            className="inline-flex items-center gap-1.5 rounded-button border border-border px-2 py-1 text-[12px] font-medium outline-none hover:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent"
          >
            {/* The link says what is missing, as the heading does: pillars,
                formats, or both. */}
            {missing.length === 2
              ? "Set up buckets"
              : verticals.length === 0
                ? "Name your pillars"
                : "Add formats"}
          </Link>

          <a
            href={`/c/${channelSlug}/ideas`}
            className="rounded-button px-1 py-0.5 text-[12px] text-muted underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-accent"
          >
            Back to the idea bank
          </a>
        </div>

        <p data-testid="add-buckets-note" className="text-[12px] text-muted">
          Naming pillars, renaming formats and setting monthly quotas all live
          in the channel&rsquo;s settings. A pillar added there is a row here
          the moment the page is next drawn.
        </p>
      </section>

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
