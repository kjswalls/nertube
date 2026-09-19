import { notFound } from "next/navigation";

import type { ChannelSettings } from "@/app/actions/channels";
import { AppShell } from "@/components/app-shell";
import { ChannelForm } from "@/components/settings/channel/channel-form";
import { SettingsHeader } from "@/components/settings/settings-header";
import { requireUser } from "@/lib/supabase/require-user";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return { title: `${slug} · channel · NerTube` };
}

/**
 * `/settings/channel/[slug]` — the channel's own settings: the voice guide,
 * the script template, and the three thresholds.
 *
 * One read of one row. Everything on this page is a column on `channels`,
 * and every field saves on blur through `updateChannelSettings`, which reads
 * the row back and answers with what was stored. A slug that does not belong
 * to this user is a 404, like the board's.
 */
export default async function ChannelSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { supabase } = await requireUser();

  const { data: channelRows, error: channelsError } = await supabase
    .from("channels")
    // prettier-ignore
    .select("id, name, slug, voice_guide, script_template, wip_threshold, stale_days, expected_ctr")
    .order("created_at", { ascending: true });

  if (channelsError) {
    throw new Error(`Could not load the channels: ${channelsError.message}`);
  }
  const channels = channelRows ?? [];
  const channel = channels.find((row) => row.slug === slug);
  if (!channel) notFound();

  const settings: ChannelSettings = {
    voiceGuide: channel.voice_guide,
    scriptTemplate: channel.script_template,
    wipThreshold: channel.wip_threshold,
    staleDays: channel.stale_days,
    expectedCtr: channel.expected_ctr === null ? null : Number(channel.expected_ctr),
  };

  return (
    <AppShell currentSlug={channel.slug} section="settings" gutter="reading">
      <div
        data-testid="settings-channel"
        data-channel={channel.slug}
        className="flex w-full max-w-3xl flex-col gap-6"
      >
        <SettingsHeader section="channel" channel={channel} channels={channels}>
          <p>
            How <strong className="font-medium text-foreground">{channel.name}</strong> sounds,
            the shape its scripts start from, and the three numbers its board and its swap
            prompt read. Each field saves when you leave it.
          </p>
        </SettingsHeader>

        <ChannelForm channelId={channel.id} channelSlug={channel.slug} initial={settings} />
      </div>
    </AppShell>
  );
}
