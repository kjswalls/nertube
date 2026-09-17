"use client";

import { useId, useState, useTransition } from "react";

import { moveVideo } from "@/app/actions/moves";

/** One option: an enabled stage of this video's channel. */
export interface FlowStage {
  readonly id: string;
  readonly name: string;
}

/**
 * The stage select — the third way to move a video, and the same way.
 *
 * ## One gate, three doors
 *
 * The board has a drag and a pair of bracket keys; this is the select on the
 * detail page. All three call `moveVideo`, which calls the `move_video` RPC,
 * which is the only thing that can write `stage_id` at all — `UPDATE
 * (stage_id, stage_entered_at, published_at, shipped_role)` is revoked from
 * `authenticated` in `0001_init.sql`. So the TTH gate, the cross-channel
 * refusal, the disabled-stage refusal, the `stage_entered_at` stamp, the
 * checklist snapshot and the script fill happen identically here, in one
 * transaction, and there is no "well, the detail page does it differently".
 *
 * That matters most on *this* page, because this is the page with the packaging
 * fields on it. A select that wrote the column directly would be a way to move
 * a video past the gate from the very screen that exists to satisfy it.
 *
 * ## The refusal says what the board says
 *
 * `moveVideo` owns the wording: it turns `move_video`'s `gate:<field>` into one
 * sentence naming the missing field, and both callers render that sentence
 * verbatim. Not a paraphrase and not `error.message` — a raw
 * `P0001: gate:thumbnail_concept` is not something anyone can act on, and a
 * second hand-written copy of "packaging still needs…" here is a sentence that
 * would drift from the board's the first time either is edited.
 *
 * The board's toast reads
 * *"Could not move “<title>” to <stage>. <message> It is still in <stage>."*;
 * this drops the title, because the title is the heading of the page you are
 * already looking at, and keeps the rest exactly.
 *
 * ## The select snaps back, like the card does
 *
 * A refused move leaves the control showing the stage the video is actually in.
 * A `<select>` that keeps displaying the option the database rejected is the
 * same bug as a card left sitting in a column it never reached.
 */
export function StageSelect({
  videoId,
  channelSlug,
  stages,
  currentStageId,
  currentStageName,
  onMoved,
}: {
  videoId: string;
  channelSlug: string;
  /** Enabled stages, in `position` order. */
  stages: readonly FlowStage[];
  currentStageId: string;
  currentStageName: string;
  /** Called after the database has confirmed a move. */
  onMoved: (stageId: string) => void;
}) {
  const selectId = useId();
  const [current, setCurrent] = useState({
    id: currentStageId,
    name: currentStageName,
  });
  const [status, setStatus] = useState<
    { kind: "idle" } | { kind: "moved"; name: string } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  /**
   * A video can sit in a stage that has since been disabled — settings refuses
   * to disable a stage holding live videos, but an archived one can come back
   * into one. The column it is in is then not in the list, and a select whose
   * value matches no option silently shows the first one instead, which is a
   * lie about where the video is. So it gets an option of its own.
   */
  const knowsCurrent = stages.some((stage) => stage.id === current.id);

  function move(stageId: string): void {
    const target = stages.find((stage) => stage.id === stageId);
    if (!target || target.id === current.id) return;

    const from = current;
    setStatus({ kind: "idle" });

    startTransition(async () => {
      try {
        const result = await moveVideo({ videoId, stageId, slug: channelSlug });

        if (result.ok) {
          setCurrent({ id: result.stageId, name: target.name });
          setStatus({ kind: "moved", name: target.name });
          onMoved(result.stageId);
        } else {
          // Snap back, and say the same thing the board says.
          setCurrent(from);
          setStatus({
            kind: "error",
            message: `Could not move to ${target.name}. ${result.message} It is still in ${from.name}.`,
          });
        }
      } catch {
        setCurrent(from);
        setStatus({
          kind: "error",
          message: `Could not move to ${target.name}: the server could not be reached. It is still in ${from.name}.`,
        });
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={selectId} className="text-xs font-medium text-muted">
        Stage
      </label>

      <select
        id={selectId}
        name="stage"
        data-testid="stage-select"
        value={current.id}
        disabled={pending}
        onChange={(event) => move(event.target.value)}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-foreground/40 disabled:opacity-60"
      >
        {knowsCurrent ? null : (
          <option value={current.id}>{current.name} (turned off)</option>
        )}
        {stages.map((stage) => (
          <option key={stage.id} value={stage.id}>
            {stage.name}
          </option>
        ))}
      </select>

      <p
        role={status.kind === "error" ? "alert" : "status"}
        data-testid="stage-select-status"
        data-state={pending ? "moving" : status.kind}
        className={[
          "min-h-4 text-xs",
          status.kind === "error"
            ? "text-amber-700 dark:text-amber-400"
            : "text-muted",
        ].join(" ")}
      >
        {pending
          ? "Moving…"
          : status.kind === "moved"
            ? `Moved to ${status.name}.`
            : status.kind === "error"
              ? status.message
              : "Moving from here runs the same packaging gate as the board."}
      </p>
    </div>
  );
}
