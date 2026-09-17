import Link from "next/link";

import { signOut } from "@/app/actions/auth";
import { CaptureHost } from "@/components/capture/capture-host";
import { ChannelShortcuts } from "@/components/channel-shortcuts";
import { ShortcutHints } from "@/components/shortcut-hints";
import { requireUser } from "@/lib/supabase/require-user";

/**
 * The shared header: brand, channel switcher, sign out.
 *
 * Rendered by every signed-in page, so it does its own `requireUser()` rather
 * than taking the user as a prop — a page that forgets to guard cannot end up
 * rendering a header for nobody.
 *
 * `currentSlug` is the channel the page is about, if any; it is marked with
 * `aria-current="page"` as well as with colour, so the switcher reads correctly
 * to a screen reader too.
 *
 * It is also where the two application-wide keyboard bindings live — `c` to
 * capture and `1..9` to switch channel — because it is the one component every
 * signed-in page renders and the one that already knows the channel list. The
 * hint bar next to them is generated from the live registry, so it lists
 * exactly the keys that work on the route being looked at.
 */
export async function AppHeader({ currentSlug }: { currentSlug?: string }) {
  const { supabase } = await requireUser();

  // Same order as `/`, which redirects to the first channel's board: a stable
  // "first channel" means the two never disagree.
  const { data: channels } = await supabase
    .from("channels")
    .select("id, name, slug")
    .order("created_at", { ascending: true });

  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link
          href="/"
          className="text-sm font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
        >
          NerTube
        </Link>

        <nav aria-label="Channels" className="flex flex-wrap items-center gap-1">
          {(channels ?? []).map((channel, index) => {
            const isCurrent = channel.slug === currentSlug;
            // The digit that switches to this channel, drawn on the chip: the
            // shortcut is otherwise invisible, and this is the same numbering
            // the capture form uses.
            const digit = index < 9 && (channels ?? []).length > 1 ? index + 1 : null;
            return (
              <Link
                key={channel.id}
                href={`/c/${channel.slug}/board`}
                aria-current={isCurrent ? "page" : undefined}
                aria-keyshortcuts={digit ? String(digit) : undefined}
                className={[
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-foreground/40",
                  isCurrent
                    ? "bg-foreground font-medium text-background"
                    : "border border-border text-muted hover:text-foreground",
                ].join(" ")}
              >
                {digit ? (
                  <span
                    aria-hidden="true"
                    className={[
                      "rounded px-1 text-xs tabular-nums",
                      isCurrent ? "bg-background/20" : "bg-surface",
                    ].join(" ")}
                  >
                    {digit}
                  </span>
                ) : null}
                {channel.name}
              </Link>
            );
          })}

          <Link
            href="/c/new"
            className="rounded-full border border-dashed border-border px-3 py-1 text-sm text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/40"
          >
            + New channel
          </Link>
        </nav>

        {/* `c` anywhere opens the capture modal, so the binding is mounted by
            the one component every signed-in page renders. It also already
            knows the channel list and the route's channel, which is exactly
            what capture needs to pick its target. */}
        <CaptureHost channels={channels ?? []} currentSlug={currentSlug} />

        {/* Binds `1..9`; renders nothing. */}
        <ChannelShortcuts channels={channels ?? []} currentSlug={currentSlug} />

        <ShortcutHints />

        <form action={signOut} className="ml-auto">
          <button
            type="submit"
            className="rounded-md px-2 py-1 text-sm text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/40"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
