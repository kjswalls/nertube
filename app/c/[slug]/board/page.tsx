import { notFound } from "next/navigation";

import { AppHeader } from "@/components/app-header";
import { BoardColumn } from "@/components/board-column";
import { requireUser } from "@/lib/supabase/require-user";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return { title: `${slug} · board · NerTube` };
}

/**
 * The kanban board for one channel.
 *
 * M0 renders the columns and nothing else: the enabled stages in `position`
 * order, each with its name and a count. There are no cards and no drag and
 * drop — that is M1, which fills `BoardColumn`'s children and replaces the
 * hard-coded count with the real one.
 *
 * Columns are ordered by `position` because `position` *is* display order.
 * Behaviour (the gate, "move to the next stage") compares `CORE_KIND_ORDER`
 * instead, never this.
 */
export default async function BoardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { supabase } = await requireUser();

  // RLS scopes this to the signed-in user, so a slug belonging to someone else
  // is indistinguishable from one that does not exist. Both are a 404.
  const { data: channel } = await supabase
    .from("channels")
    .select("id, name")
    .eq("slug", slug)
    .maybeSingle();

  if (!channel) {
    notFound();
  }

  const { data: stages, error } = await supabase
    .from("stages")
    .select("id, name, kind, position")
    .eq("channel_id", channel.id)
    .eq("is_enabled", true)
    .order("position", { ascending: true });

  if (error) {
    throw new Error(`Could not load the stages for ${slug}: ${error.message}`);
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader currentSlug={slug} />

      <main className="flex flex-1 flex-col gap-4 px-4 py-6">
        <h1 className="text-lg font-semibold tracking-tight">{channel.name}</h1>

        {stages.length === 0 ? (
          <p className="text-sm text-muted">
            This channel has no enabled stages. Turn one back on in settings.
          </p>
        ) : (
          <div className="flex flex-1 items-start gap-3 overflow-x-auto pb-4">
            {stages.map((stage) => (
              <BoardColumn
                key={stage.id}
                name={stage.name}
                /* M1 replaces this with the column's real card count. */
                count={0}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
