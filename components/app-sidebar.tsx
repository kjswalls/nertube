import Link from "next/link";

import { signOut } from "@/app/actions/auth";
import { CaptureHost } from "@/components/capture/capture-host";
import { ChannelShortcuts } from "@/components/channel-shortcuts";
import { ShortcutHints } from "@/components/shortcut-hints";
import { ThemeToggle } from "@/components/theme-toggle";

/** Which entry in the sidebar the route being rendered corresponds to. */
export type SidebarSection = "board" | "now" | "ideas";

export interface SidebarChannel {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

/**
 * Which channel the Board and Ideas rows are *of*.
 *
 * The route's channel, or the first one — the same order `/` redirects by, so
 * the two never disagree. Exported because `AppShell` has to read the idea
 * count for exactly this channel before it can hand it down, and two copies of
 * this one-liner is how a badge ends up counting a different channel's bank
 * than the link beside it opens.
 */
export function boardChannelOf(
  channels: readonly SidebarChannel[],
  currentSlug?: string,
): SidebarChannel | undefined {
  return channels.find((channel) => channel.slug === currentSlug) ?? channels[0];
}

/**
 * The 224px sidebar: sections, channels, and the account.
 *
 * It replaces the M0–M2 top header. A horizontal bar cost 56px of a board that
 * is nine columns tall, put the channel switcher a long way from the board it
 * switches, and had nowhere to put `/now`, `/calendar` and `/ideas`. The sidebar is on its own ground (`--sidebar`, a shade off the page's
 * `--ground`) so the edge between chrome and work is a change of surface rather
 * than a drawn line — the 1px rule on the right is there to stop the two
 * grounds bleeding together on a low-contrast display, not to do the work.
 *
 * ## Current-page indication is never colour alone
 *
 * Three things say "you are here", and only one of them is a hue:
 *
 * 1. `aria-current="page"`, which is what assistive technology reads.
 * 2. A 3px marker bar at the left edge — a *shape*, present or absent.
 * 3. The label's weight and the item's own surface.
 *
 * The accent colour on top of those is a fourth signal, not the signal. This
 * matters here more than in most applications: the whole design rests on
 * colour meaning something, and if navigation spends the accent on "which page
 * am I on" then a stale column and a blocked video are competing with the
 * furniture.
 *
 * ## Why the unbuilt sections are disabled buttons and not links
 *
 * `/calendar` does not exist yet. `/now` (M3) and `/c/[slug]/ideas` (M5) do,
 * and are links like any other — M3's reviewers filed the Ideas row as
 * unreachable by keyboard and explained only by a tooltip, and the fix was
 * never a better tooltip: it was building the page it pointed at. M1's review
 * caught this exact mistake on the
 * gate-refusal toast — a link to a fragment on a page that had no such field —
 * and the answer was the same then: an affordance that says what it will do and
 * refuses to pretend it does it yet. Each one names the milestone it arrives
 * in, on the row and not only in a tooltip, so the shape of the product is
 * visible without a single dead link in it — and it is `aria-disabled` rather
 * than `disabled`, so a keyboard user can actually reach the thing that says
 * so. See `SidebarDisabled`.
 *
 * ## What it still does that the header did
 *
 * `CaptureHost` (`c`) and `ChannelShortcuts` (`1`..`9`) are mounted here,
 * because this is the one component every signed-in route renders — with the
 * deliberate exception of `/capture`, which is chrome-free by design and where
 * the page *is* the capture form, so neither key has anything to do. It is also
 * the component that already knows the channel list. `ShortcutHints`
 * still lists the *live* registrations, so it advertises exactly the keys that
 * work on the route being looked at.
 */
export function AppSidebar({
  channels,
  currentSlug,
  section,
  nowCount,
  ideasCount,
  userEmail,
}: {
  channels: readonly SidebarChannel[];
  /** The channel the current route is about, if any. */
  currentSlug?: string;
  /**
   * Which sidebar entry the current route *is*. Separate from `currentSlug`
   * because `/videos/[id]` belongs to a channel without being that channel's
   * board — the channel row is marked, the Board row is not, and the two
   * `aria-current` values say exactly that difference.
   */
  section?: SidebarSection;
  /**
   * How many rows `/now` is holding — see the note on the count below.
   * Undefined on a route that has no shell-level read to do it with.
   */
  nowCount?: number;
  /**
   * How many live ideas the Ideas row's channel is holding, or `null` when the
   * read failed and `undefined` when nobody asked. See `lib/ideas-data.ts`.
   */
  ideasCount?: number | null;
  userEmail: string | null;
}) {
  const boardChannel = boardChannelOf(channels, currentSlug);

  return (
    // Two elements, because "the sidebar is 224px of its own ground" and "the
    // sidebar stays put while the board scrolls" are two different jobs. The
    // outer strip stretches to the full height of the page — a `sticky` child
    // only paints one viewport of background, which leaves a long video page
    // with a bare stripe below the fold. The inner `<nav>` is the sticky one,
    // and it scrolls by itself when an account has more channels than fit.
    <div
      data-testid="app-sidebar"
      className="w-sidebar shrink-0 border-r border-border bg-sidebar"
    >
      <nav
        aria-label="Main"
        className="sticky top-0 flex h-dvh flex-col gap-5 overflow-y-auto px-3 py-4"
      >
        <div className="flex flex-col gap-3">
          <Link
            href="/"
            className="rounded-button px-1 font-display text-[17px] leading-none font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            NerTube
          </Link>

          {/* `c` anywhere opens the capture modal. Mounted by the one component
            every signed-in page renders, which also already knows the channel
            list and the route's channel — exactly what capture needs to pick
            its target. */}
          <CaptureHost channels={channels} currentSlug={currentSlug} />
        </div>

        <div className="flex flex-col gap-1">
          <h2 id="sidebar-sections" className="sr-only">
            Sections
          </h2>
          <ul
            aria-labelledby="sidebar-sections"
            className="flex flex-col gap-0.5"
          >
            <li>
              {/* M3 built it, so it is a link. The disabled treatment below is
                  for the sections that genuinely do not exist yet. */}
              <SidebarLink
                href="/now"
                current={section === "now" ? "page" : false}
                /*
                  The count, and why it is drawn the way it is.

                  It is the *same* number `/now` renders: `AppShell` gets it
                  from `rankNow()` over the rows that page lists, not from a
                  cheaper query that would quietly mean something else. Zero
                  draws nothing — a badge reading 0 is a claim that needs
                  reading, and an empty inbox should be quiet.

                  `aria-hidden` on the chip and the number repeated in `title`:
                  that keeps the link's accessible name exactly "Now" (which is
                  what makes the sidebar's own spec an honest assertion) while
                  still giving a screen reader the number, as the link's
                  description rather than as part of its name.
                */
                title={
                  nowCount === undefined || nowCount === 0
                    ? undefined
                    : `${nowCount} ${nowCount === 1 ? "thing" : "things"} you could do right now`
                }
                trailing={
                  nowCount === undefined || nowCount === 0 ? null : (
                    <span
                      aria-hidden="true"
                      data-testid="sidebar-now-count"
                      data-count={nowCount}
                      className="font-mono text-[10px] text-muted"
                    >
                      {nowCount}
                    </span>
                  )
                }
              >
                Now
              </SidebarLink>
            </li>
            <li>
              {boardChannel ? (
                <SidebarLink
                  href={`/c/${boardChannel.slug}/board`}
                  current={section === "board" ? "page" : false}
                >
                  Board
                </SidebarLink>
              ) : (
                <SidebarDisabled title="Create a channel first — a board is a board of something.">
                  Board
                </SidebarDisabled>
              )}
            </li>
            <li>
              {boardChannel ? (
                <SidebarLink
                  href={`/c/${boardChannel.slug}/ideas`}
                  current={section === "ideas" ? "page" : false}
                  /*
                    The bank's size, drawn exactly the way the Now count is:
                    `aria-hidden` on the chip so the link's accessible name
                    stays "Ideas", the number repeated in `title` so a screen
                    reader gets it as the link's description, and nothing at all
                    when it is zero or unknown.

                    It is the *unfiltered* count, like `/now`'s. Narrowing the
                    bank with the filters on the page does not change how many
                    ideas there are, and a badge that followed the filters would
                    be reporting the filter rather than the bank.
                  */
                  title={
                    ideasCount === undefined ||
                    ideasCount === null ||
                    ideasCount === 0
                      ? undefined
                      : `${ideasCount} ${ideasCount === 1 ? "idea" : "ideas"} in ${boardChannel.name}'s bank`
                  }
                  trailing={
                    ideasCount === undefined ||
                    ideasCount === null ||
                    ideasCount === 0 ? null : (
                      <span
                        aria-hidden="true"
                        data-testid="sidebar-ideas-count"
                        data-count={ideasCount}
                        className="font-mono text-[10px] text-muted"
                      >
                        {ideasCount}
                      </span>
                    )
                  }
                >
                  Ideas
                </SidebarLink>
              ) : (
                <SidebarDisabled title="Create a channel first — an idea bank is a bank of one channel's ideas.">
                  Ideas
                </SidebarDisabled>
              )}
            </li>
            <SectionItem label="Calendar" milestone="M6" />
          </ul>
        </div>

        <div className="flex min-h-0 flex-col gap-1">
          <h2
            id="sidebar-channels"
            className="px-2 text-[11px] font-medium tracking-[0.06em] text-muted uppercase"
          >
            Channels
          </h2>
          {/*
            The channel list is the one part of the sidebar that grows without
            bound, so it is the one part that scrolls.

            Its parent carries `min-h-0`, which lets this block shrink when the
            rest of the sidebar plus a long channel list is taller than `h-dvh`.
            Shrinking without `overflow-y-auto` here is the bug that produced:
            the `<ul>` kept its natural height, painted straight over the
            account block below it, and swallowed clicks meant for the theme
            toggle. Clipping and scrolling is what the shrink was for.
          */}
          <ul
            aria-labelledby="sidebar-channels"
            className="flex min-h-0 flex-col gap-0.5 overflow-y-auto"
          >
            {channels.map((channel, index) => {
              const isCurrent = channel.slug === currentSlug;
              // The digit that switches to this channel, drawn on the row: the
              // shortcut is otherwise invisible, and this is the same numbering
              // the capture form uses.
              const digit = index < 9 && channels.length > 1 ? index + 1 : null;
              return (
                <li key={channel.id}>
                  <SidebarLink
                    href={`/c/${channel.slug}/board`}
                    current={
                      // "page" only on the channel's own board. On a video of
                      // this channel the row is still marked — `aria-current`
                      // takes "true" for "this one, but not this page".
                      isCurrent
                        ? section === "board"
                          ? "page"
                          : "true"
                        : false
                    }
                    keyShortcut={digit === null ? undefined : String(digit)}
                    // `aria-hidden`, so the link's accessible name stays exactly
                    // the channel's name.
                    trailing={
                      digit === null ? null : (
                        <span
                          aria-hidden="true"
                          className="font-mono text-[10px] text-muted"
                        >
                          {digit}
                        </span>
                      )
                    }
                  >
                    {channel.name}
                  </SidebarLink>
                </li>
              );
            })}

            <li>
              <Link
                href="/c/new"
                className="flex items-center rounded-button px-2 py-1.5 text-[13px] text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
              >
                + New channel
              </Link>
            </li>
          </ul>
        </div>

        {/* Binds `1..9`; renders nothing. */}
        <ChannelShortcuts channels={channels} />

        <div className="mt-auto flex flex-col gap-3 border-t border-border pt-3">
          <ShortcutHints />

          <ThemeToggle />

          <div className="flex items-center justify-between gap-2">
            {userEmail ? (
              <span
                data-testid="account-email"
                title={userEmail}
                className="min-w-0 truncate text-[11px] text-muted"
              >
                {userEmail}
              </span>
            ) : (
              <span />
            )}

            <form action={signOut}>
              <button
                type="submit"
                className="shrink-0 rounded-button px-1.5 py-1 text-[12px] text-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </nav>
    </div>
  );
}

/**
 * A section that is drawn but not built. See the file comment.
 *
 * The milestone is drawn on the row, in small mono, exactly the way
 * `components/preview/assist-pill.tsx` draws M8 on the inert assist buttons. It
 * used to live only in `title`, which is a tooltip: a keyboard user never
 * hovers and a touch user cannot, so the one sentence explaining why the row
 * does nothing was reachable by mouse alone. On screen it is reachable by
 * everybody, and it joins the control's accessible name — "Calendar M6" — which
 * is the sentence in miniature.
 */
function SectionItem({
  label,
  milestone,
  note,
}: {
  label: string;
  milestone: string;
  /** Anything more than the milestone number, for the tooltip only. */
  note?: string;
}) {
  return (
    <li>
      <SidebarDisabled
        title={`${label} arrives in ${milestone}${note ? `, ${note}` : ""}.`}
        trailing={
          <span className="font-mono text-[10px] tracking-wide uppercase">
            {milestone}
          </span>
        }
      >
        {label}
      </SidebarDisabled>
    </li>
  );
}

/**
 * A control that is present and refuses to pretend it works.
 *
 * `aria-disabled` and **not** `disabled`. A `disabled` button is removed from
 * the tab order, so a keyboard or screen-reader user never landed on Calendar
 * at all — the row was visible, its explanation was in a tooltip they could not
 * summon, and the whole point of drawing it (the shape of the product is
 * visible) applied to mouse users only. `aria-disabled` keeps it in the tab
 * order and announces it as unavailable, which is the honest pair. M5 retired
 * the other user of this: Ideas is a real link now, which is the only complete
 * fix for a row nobody could reach.
 *
 * There is no click handler, which is what makes it do nothing. Nothing to
 * intercept, nothing to hydrate: this stays a Server Component.
 */
function SidebarDisabled({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-disabled="true"
      title={title}
      data-testid="sidebar-unbuilt"
      className="flex w-full cursor-not-allowed items-center justify-between gap-2 rounded-button px-2 py-1.5 text-left text-[13px] text-muted opacity-75 outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="min-w-0 truncate">{children}</span>
      {trailing}
    </button>
  );
}

function SidebarLink({
  href,
  current,
  keyShortcut,
  trailing,
  title,
  children,
}: {
  href: string;
  current: "page" | "true" | false;
  keyShortcut?: string;
  trailing?: React.ReactNode;
  /**
   * The link's accessible *description*, not its name: `title` on an element
   * that already has text content never joins the name computation. That is
   * how the Now count reaches assistive technology without turning the link
   * called "Now" into a link called "Now 7".
   */
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      title={title}
      aria-current={current === false ? undefined : current}
      aria-keyshortcuts={keyShortcut}
      className={[
        "relative flex items-center justify-between gap-2 rounded-button py-1.5 pr-2 pl-3 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
        current
          ? "bg-surface font-medium text-foreground"
          : "text-muted hover:text-foreground",
      ].join(" ")}
    >
      {/* Signal 2: a shape, not a hue. Present on the current row and absent
          everywhere else, so the page is identifiable with no colour at all. */}
      {current ? (
        <span
          aria-hidden="true"
          className="absolute top-1/2 left-0 h-3.5 w-[3px] -translate-y-1/2 rounded-full bg-accent"
        />
      ) : null}
      <span className="min-w-0 truncate">{children}</span>
      {trailing}
    </Link>
  );
}
