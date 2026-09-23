import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { AxisEditor } from "@/components/settings/channel/buckets/axis-editor";
import type { EditableBucket } from "@/components/settings/channel/buckets/types";
import { SettingsHeader } from "@/components/settings/settings-header";
import { readPaged } from "@/lib/paged";
import { requireUser } from "@/lib/supabase/require-user";
import { channelPageTitle } from "@/lib/page-title";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return { title: await channelPageTitle(slug, "buckets") };
}

/**
 * `/settings/buckets/[slug]` — one channel's content buckets: the topic
 * pillars (verticals, the matrix's rows) and the formats (horizontals, its
 * columns), each with an optional monthly quota.
 *
 * ## What is read
 *
 * Three flat, RLS-scoped reads: the channels (for the switch and the
 * heading), the channel's buckets, and the channel's non-archived videos —
 * only their two bucket columns — counted per bucket in memory. The count is
 * the same number the matrix prints as a row or column total (`BucketCount`
 * in `components/ideas/matrix/quota-meter.tsx`: non-archived videos carrying
 * the bucket), so a person reading "3 videos" here and "3 videos" there is
 * reading one fact. It is on the row so a removal — which unfiles them — is
 * never a surprise.
 *
 * ## The channel is unmistakable, on purpose
 *
 * Buckets are per channel (BRIEF.md), and the composite key on `videos`
 * makes a bucket useless to any other channel's videos. `SettingsHeader`
 * names the channel and offers the switch; every action resolves the channel
 * from the bucket row it was handed, through RLS — never from the URL. A
 * slug that does not belong to this user is a 404, like the board's.
 */
export default async function BucketSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { supabase } = await requireUser();

  const { data: channelRows, error: channelsError } = await supabase
    .from("channels")
    .select("id, name, slug")
    .order("created_at", { ascending: true });

  if (channelsError) {
    throw new Error(`Could not load the channels: ${channelsError.message}`);
  }
  const channels = channelRows ?? [];
  const channel = channels.find((row) => row.slug === slug);
  if (!channel) notFound();

  const { data: bucketRows, error: bucketsError } = await supabase
    .from("buckets")
    .select("id, channel_id, axis, name, position, monthly_quota")
    .eq("channel_id", channel.id)
    .order("position", { ascending: true });

  if (bucketsError) {
    throw new Error(`Could not load the buckets for ${slug}: ${bucketsError.message}`);
  }

  // Filed per bucket, non-archived only — the matrix's own count.
  const videoRows = await readPaged(`videos for ${channel.slug}`, (from, to) =>
    supabase
      .from("videos")
      .select("id, vertical_id, horizontal_id")
      .eq("channel_id", channel.id)
      .is("archived_at", null)
      .order("id", { ascending: true })
      .range(from, to),
  );
  const filed = new Map<string, number>();
  for (const video of videoRows) {
    if (video.vertical_id) filed.set(video.vertical_id, (filed.get(video.vertical_id) ?? 0) + 1);
    if (video.horizontal_id) {
      filed.set(video.horizontal_id, (filed.get(video.horizontal_id) ?? 0) + 1);
    }
  }

  const verticals: EditableBucket[] = [];
  const horizontals: EditableBucket[] = [];
  for (const row of bucketRows ?? []) {
    const bucket: EditableBucket = {
      id: row.id,
      channelId: row.channel_id,
      axis: row.axis === "vertical" ? "vertical" : "horizontal",
      name: row.name,
      position: row.position,
      monthlyQuota: row.monthly_quota,
      filed: filed.get(row.id) ?? 0,
    };
    if (row.axis === "vertical") verticals.push(bucket);
    else if (row.axis === "horizontal") horizontals.push(bucket);
  }

  return (
    <AppShell currentSlug={channel.slug} section="settings" gutter="reading">
      <div
        data-testid="settings-buckets"
        data-channel={channel.slug}
        className="flex w-full max-w-3xl flex-col gap-6"
      >
        <SettingsHeader section="buckets" channel={channel} channels={channels}>
          <p>
            The two axes of{" "}
            <Link
              href={`/c/${channel.slug}/ideas?view=matrix`}
              className="underline decoration-border underline-offset-2 hover:decoration-current"
            >
              the matrix
            </Link>
            : pillars down the side, formats across the top, and every video filed under
            one of each. What is written here is what the capture form and the video page
            offer in their pickers. A quota is the matrix&rsquo;s target for the month &mdash;
            the <span className="font-mono">n of quota</span> beside a row or column counts
            videos with a target publish date in the current month.
          </p>
        </SettingsHeader>

        <AxisEditor channel={channel} axis="vertical" buckets={verticals} />
        <AxisEditor channel={channel} axis="horizontal" buckets={horizontals} />
      </div>
    </AppShell>
  );
}
