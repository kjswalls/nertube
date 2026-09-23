import Link from "next/link";
import { redirect } from "next/navigation";

import { CaptureForm } from "@/components/capture/capture-form";
import { requireUser } from "@/lib/supabase/require-user";

export const metadata = { title: "Capture · NerTube" };

/**
 * `/capture` — the standalone capture page (PLAN.md's "mobile bookmark").
 *
 * The same `CaptureForm` the `c` modal renders, with nothing else on the page:
 * no board, no header chrome to scroll past, one field under your thumb. The
 * form's controls are 44px tall and its inputs are 16px type, which is the
 * threshold below which iOS Safari zooms the page on focus — the one piece of
 * mobile styling that is a behaviour rather than a taste.
 *
 * `?c=<slug>` aims it at a channel, so a phone can hold a bookmark per channel.
 * Without it the form falls back to the last-used channel, the same as the
 * modal does away from a channel route.
 *
 * ## No `AppShell`, and 16px of padding rather than the gutter token
 *
 * This is the one signed-in route that does not render the shell, which is why
 * anything claiming "every signed-in route" has to say *except this one*: there
 * is no sidebar here, and so `c` and `1`..`9` are not bound — the page already
 * *is* the capture form.
 *
 * The padding is `px-4` (16px) and not `--spacing-gutter` (32px) because the
 * gutter is sized for a 1440px window where 32px is a rest at the edge. On a
 * 390px phone it is 64px of the 390 — a sixth of the screen — spent on margin
 * beside a single text field. 16px is the phone's gutter; the token is the
 * desk's.
 */
export default async function CapturePage({
  searchParams,
}: {
  searchParams: Promise<{
    c?: string | string[];
    /**
     * Both bucket ids, from the matrix's empty cell. That link is what this
     * page answers when JavaScript is not running — see
     * `components/ideas/matrix/capture-cell.tsx`, which otherwise intercepts
     * the click and opens the same form in a dialog without leaving the grid.
     */
    vertical?: string | string[];
    horizontal?: string | string[];
  }>;
}) {
  const { supabase } = await requireUser();
  const { c, vertical, horizontal } = await searchParams;

  const { data: channels, error } = await supabase
    .from("channels")
    .select("id, name, slug")
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Could not load your channels: ${error.message}`);
  }

  // Nothing to capture into yet; `/c/new` is the only useful destination.
  if (!channels || channels.length === 0) {
    redirect("/c/new");
  }

  const wanted = one(c);
  const routeChannel = wanted
    ? channels.find((channel) => channel.slug === wanted)
    : undefined;

  const target = routeChannel ?? channels[0];

  /*
    The bucket pair, resolved against the target channel rather than trusted.

    Both or neither: a cell is an intersection, and half of one is not a thing
    the matrix can have offered. The ids are read back as names as well, so the
    form can *say* where it is filing the idea — and looking them up here is
    also the check that they are this channel's and on the axis they claim,
    which is what stops a hand-typed query filing an idea into a bucket nobody
    chose. (The composite foreign key would refuse it too; this refuses it
    before the row exists.)
  */
  let prefill:
    | {
        verticalId: string;
        verticalName: string;
        horizontalId: string;
        horizontalName: string;
      }
    | undefined;

  const verticalId = one(vertical);
  const horizontalId = one(horizontal);
  if (verticalId && horizontalId) {
    const { data: buckets } = await supabase
      .from("buckets")
      .select("id, axis, name")
      .eq("channel_id", target.id)
      .in("id", [verticalId, horizontalId]);

    const verticalBucket = (buckets ?? []).find(
      (bucket) => bucket.id === verticalId && bucket.axis === "vertical",
    );
    const horizontalBucket = (buckets ?? []).find(
      (bucket) => bucket.id === horizontalId && bucket.axis === "horizontal",
    );

    if (verticalBucket && horizontalBucket) {
      prefill = {
        verticalId: verticalBucket.id,
        verticalName: verticalBucket.name,
        horizontalId: horizontalBucket.id,
        horizontalName: horizontalBucket.name,
      };
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-lg flex-col gap-5 px-4 py-6">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="font-display text-[20px] leading-tight font-semibold tracking-tight">
          Capture an idea
        </h1>
        <Link
          href={`/c/${target.slug}/board`}
          className="rounded-button px-2 py-1 text-sm text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent thumb:flex thumb:min-h-11 thumb:items-center thumb:px-3"
        >
          Board
        </Link>
      </div>

      <CaptureForm
        /*
          A prefilled pair belongs to one channel: the composite foreign keys
          bind a video's buckets to its own channel and axis, so offering the
          channel chips here would be offering a choice the database refuses.
          Without a pair this is the full list, exactly as before.
        */
        channels={prefill ? [target] : channels}
        initialChannelId={target.id}
        preferLastUsed={!routeChannel && !prefill}
        variant="page"
        prefill={prefill}
      />
    </main>
  );
}

/** One value from a query parameter Next hands back as `string | string[]`. */
function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
