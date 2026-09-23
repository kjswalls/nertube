import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/app-shell";
import {
  StageTemplateEditor,
  type TemplateStage,
} from "@/components/settings/checklists/stage-template-editor";
import { SettingsHeader } from "@/components/settings/settings-header";
import {
  TEMPLATE_COLUMNS,
  readTemplateItem,
  sortTemplates,
  type TemplateItem,
} from "@/lib/checklist-templates";
import { isStageKind } from "@/lib/defaults";
import { readPaged } from "@/lib/paged";
import { requireUser } from "@/lib/supabase/require-user";
import { channelPageTitle } from "@/lib/page-title";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return { title: await channelPageTitle(slug, "checklists") };
}

/**
 * `/settings/checklists/[slug]` — one channel's checklist templates, one
 * editor per stage.
 *
 * ## What is read, and why occupancy is one of the things
 *
 * Four flat, RLS-scoped reads: the channels (for the switch), the channel's
 * stages — *all* of them, disabled included, because a switched-off lane's
 * template is still the lane's and should be visible where it can be edited —
 * the templates for those stages, and the channel's non-archived videos,
 * counted per stage in memory. The count is what lets each editor say "three
 * videos are in Packaging now and keep their lists", which is the only
 * sentence on the page that turns the snapshot rule from a fact about the
 * schema into something the person can see.
 *
 * A slug that does not belong to this user is a 404, like the board's: RLS
 * makes another user's channel indistinguishable from one that never existed.
 */
export default async function ChecklistSettingsPage({
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
    throw new Error(`Could not load the stages: ${stagesError.message}`);
  }

  const stages: TemplateStage[] = (stageRows ?? []).map((stage) => ({
    id: stage.id,
    name: stage.name,
    kind: isStageKind(stage.kind) ? stage.kind : null,
    isEnabled: stage.is_enabled,
  }));
  const stageIds = stages.map((stage) => stage.id);

  const templatesByStage = new Map<string, TemplateItem[]>();
  if (stageIds.length > 0) {
    const { data: templateRows, error: templatesError } = await supabase
      .from("checklist_templates")
      .select(TEMPLATE_COLUMNS)
      .in("stage_id", stageIds)
      .order("position", { ascending: true });

    if (templatesError) {
      throw new Error(`Could not load the templates: ${templatesError.message}`);
    }
    for (const row of templateRows ?? []) {
      const list = templatesByStage.get(row.stage_id) ?? [];
      list.push(readTemplateItem(row));
      templatesByStage.set(row.stage_id, list);
    }
  }

  // Occupancy: the non-archived videos in each stage. Archived ones are off
  // the board and out of `/now` already, so they are not something a template
  // edit could be said to leave behind.
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

  return (
    <AppShell currentSlug={channel.slug} section="settings" gutter="reading">
      <div
        data-testid="settings-checklists"
        data-channel={channel.slug}
        className="flex w-full max-w-3xl flex-col gap-5"
      >
        <SettingsHeader section="checklists" channel={channel} channels={channels}>
          <p>
            Each stage&rsquo;s list is copied onto a video the moment it enters
            that stage &mdash; from then on the video&rsquo;s copy is its own.
            Editing a template changes what the <em>next</em> video gets; it
            never rewrites a list someone has already started ticking. The
            minutes are what{" "}
            <Link
              href="/now"
              className="underline decoration-border underline-offset-2 hover:decoration-current"
            >
              /now
            </Link>{" "}
            uses to decide what fits in ten minutes, and the rows are what the{" "}
            <Link
              href={`/c/${channel.slug}/board`}
              className="underline decoration-border underline-offset-2 hover:decoration-current"
            >
              board
            </Link>{" "}
            counts towards done/total on every card.
          </p>
        </SettingsHeader>

        {stages.length === 0 ? (
          <p data-testid="settings-no-stages" className="text-[13px] text-muted">
            This channel has no stages, so there is nothing to write a template
            for.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {stages.map((stage) => (
              <StageTemplateEditor
                key={stage.id}
                stage={stage}
                initial={sortTemplates(templatesByStage.get(stage.id) ?? [])}
                occupied={occupied.get(stage.id) ?? 0}
              />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
