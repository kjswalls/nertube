import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import { SettingsHeader } from "@/components/settings/settings-header";
import { StagesEditor } from "@/components/settings/stages/stages-editor";
import type { SettingsStage } from "@/components/settings/stages/types";
import { isStageKind } from "@/lib/defaults";
import { readPaged } from "@/lib/paged";
import { requireUser } from "@/lib/supabase/require-user";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return { title: `${slug} · stages · NerTube` };
}

/**
 * `/settings/stages/[slug]` — one channel's stages: their order, their
 * labels, which are on the board, and adding one.
 *
 * ## What is read
 *
 * Three flat, RLS-scoped reads: the channels (for the switch and the
 * heading), the channel's stages — all of them, disabled included, because a
 * switched-off stage is exactly the one this screen exists to switch back on
 * — and the channel's non-archived videos, counted per stage in memory. The
 * count is what lets a row say "3 videos" *before* the switch is pressed, so
 * the database's refusal is confirmation rather than surprise; the refusal
 * itself still comes from `set_stage_enabled`, which counts again inside the
 * same transaction that writes.
 *
 * ## The channel is unmistakable, on purpose
 *
 * Stages are per channel (BRIEF.md: *"Stage definitions, checklist templates,
 * and content buckets are all per-channel"*), and this is the one screen
 * where editing the wrong channel's rows is a real mistake with a real cost.
 * `SettingsHeader` puts the channel in the switch and the heading, the
 * address carries it, `data-channel` on the root repeats it, and the sidebar
 * marks the channel row as current. Nothing on this page reads or writes
 * another channel's stages: every action resolves the channel from the stage
 * row it was handed, through RLS, never from the URL.
 *
 * A slug that does not belong to this user is a 404, like the board's.
 */
export default async function StageSettingsPage({
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

  const { data: stageRows, error: stagesError } = await supabase
    .from("stages")
    .select("id, name, kind, position, is_enabled")
    .eq("channel_id", channel.id)
    .order("position", { ascending: true });

  if (stagesError) {
    throw new Error(`Could not load the stages for ${slug}: ${stagesError.message}`);
  }

  // Occupancy per stage, non-archived only — the same count
  // `set_stage_enabled` makes, so the number on the row and the refusal agree.
  const videoRows = await readPaged(`videos for ${channel.slug}`, (from, to) =>
    supabase
      .from("videos")
      .select("id, stage_id")
      .eq("channel_id", channel.id)
      .is("archived_at", null)
      .order("id", { ascending: true })
      .range(from, to),
  );
  const occupied = new Map<string, number>();
  for (const video of videoRows) {
    occupied.set(video.stage_id, (occupied.get(video.stage_id) ?? 0) + 1);
  }

  const stages: SettingsStage[] = (stageRows ?? []).map((stage) => ({
    id: stage.id,
    name: stage.name,
    kind: isStageKind(stage.kind) ? stage.kind : null,
    position: stage.position,
    isEnabled: stage.is_enabled,
    occupied: occupied.get(stage.id) ?? 0,
  }));

  return (
    <AppShell currentSlug={channel.slug} section="settings" gutter="reading">
      <div
        data-testid="settings-stages"
        data-channel={channel.slug}
        className="flex w-full max-w-3xl flex-col gap-5"
      >
        <SettingsHeader section="stages" channel={channel} channels={channels}>
          <p>
            The columns of the{" "}
            <Link
              href={`/c/${channel.slug}/board`}
              className="underline decoration-border underline-offset-2 hover:decoration-current"
            >
              board
            </Link>
            , the options in a video&rsquo;s stage select, and the path{" "}
            <Link
              href="/now"
              className="underline decoration-border underline-offset-2 hover:decoration-current"
            >
              /now
            </Link>{" "}
            walks a video along. Renaming one changes its label and nothing
            else; switching one off takes its column away, and is refused
            while any video is still in it.
          </p>
        </SettingsHeader>

        {stages.length === 0 ? (
          <p data-testid="settings-no-stages" className="text-[13px] text-muted">
            This channel has no stages at all, which no screen in this app can
            produce. Add one below to give the board a column.
          </p>
        ) : null}

        <StagesEditor channel={channel} stages={stages} />
      </div>
    </AppShell>
  );
}
