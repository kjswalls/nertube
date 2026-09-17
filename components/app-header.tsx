import Link from "next/link";

import { signOut } from "@/app/actions/auth";
import { CaptureHost } from "@/components/capture/capture-host";
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
          {(channels ?? []).map((channel) => {
            const isCurrent = channel.slug === currentSlug;
            return (
              <Link
                key={channel.id}
                href={`/c/${channel.slug}/board`}
                aria-current={isCurrent ? "page" : undefined}
                className={[
                  "rounded-full px-3 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-foreground/40",
                  isCurrent
                    ? "bg-foreground font-medium text-background"
                    : "border border-border text-muted hover:text-foreground",
                ].join(" ")}
              >
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
