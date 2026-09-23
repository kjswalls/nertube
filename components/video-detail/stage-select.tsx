"use client";

import { useId, useRef, useState, useTransition, type KeyboardEvent } from "react";

import { moveVideo } from "@/app/actions/moves";
import { useVideoVersion } from "@/components/video-version";

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
 *
 * ## An arrow key browses; it does not move (M9 review)
 *
 * On Windows and Linux an arrow key on a closed `<select>` changes its value
 * and fires `change`. This used to move the video on that `change`, so one
 * ArrowDown ran the gate, seeded a checklist and toasted — and the select,
 * disabled while the move was in flight, dropped focus to <body>, so the
 * second arrow did nothing (WCAG 3.2.2). Now a value reached from the keyboard
 * is only a choice: the status line says it is not moved yet, and Enter or the
 * Move button beside the select makes the move; Escape puts the choice back.
 * A pick with the pointer from the open list is a decision and moves at once,
 * as it always did. The select is never `disabled` while a move is in flight,
 * so it keeps focus; a second move waits for the first.
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
    | { kind: "idle" }
    /**
     * `notice` is `moveVideo`'s soft warning — today, PLAN.md's *Publish Prep →
     * Scheduled with < 3 thumbnail paths*. It rides on a **successful** move
     * and is therefore printed under "Moved to X.", not instead of it.
     */
    | { kind: "moved"; name: string; notice: string | null }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [pending, startTransition] = useTransition();
  const version = useVideoVersion();
  /** The option showing in the select, when it is not yet the stage. */
  const [choice, setChoice] = useState<string | null>(null);
  /** The last change came from a key, not a pick from the open list. */
  const keyed = useRef(false);
  const selectRef = useRef<HTMLSelectElement>(null);

  /**
   * A video can sit in a stage that has since been disabled — settings refuses
   * to disable a stage holding live videos, but an archived one can come back
   * into one. The column it is in is then not in the list, and a select whose
   * value matches no option silently shows the first one instead, which is a
   * lie about where the video is. So it gets an option of its own.
   */
  const knowsCurrent = stages.some((stage) => stage.id === current.id);

  function move(stageId: string): void {
    // In flight already: the select stays focusable, so this is the guard.
    if (pending) return;
    const target = stages.find((stage) => stage.id === stageId);
    setChoice(null);
    if (!target || target.id === current.id) return;

    const from = current;
    setStatus({ kind: "idle" });

    startTransition(async () => {
      try {
        const result = await moveVideo({ videoId, stageId, slug: channelSlug });

        if (result.ok) {
          // `move_video` stamps `updated_at` like any other write, so the
          // page's shared version token has to hear about it — otherwise the
          // next packaging save on this page would report a conflict with a
          // move the user made themselves.
          version.adopt(result.updatedAt);
          setCurrent({ id: result.stageId, name: target.name });
          setStatus({ kind: "moved", name: target.name, notice: result.notice });
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

  function onKeyDown(event: KeyboardEvent<HTMLSelectElement>): void {
    if (event.key === "Enter") {
      if (choice !== null) {
        event.preventDefault();
        move(choice);
      }
      return;
    }
    if (event.key === "Escape") {
      if (choice !== null) {
        // Consumed: putting the choice back is all Escape means here.
        event.preventDefault();
        setChoice(null);
      }
      return;
    }
    if (event.key === "Tab" || event.key === " " || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    // Arrows, Home/End, Page keys and type-ahead letters all change a closed
    // select's value from the keyboard.
    keyed.current = true;
  }

  const target = choice === null ? null : stages.find((stage) => stage.id === choice) ?? null;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={selectId} className="text-xs font-medium text-muted">
        Stage
      </label>

      <div className="flex items-center gap-2">
        <select
          ref={selectRef}
          id={selectId}
          name="stage"
          data-testid="stage-select"
          value={choice ?? current.id}
          aria-busy={pending || undefined}
          aria-describedby={`${selectId}-status`}
          onPointerDown={() => {
            keyed.current = false;
          }}
          onKeyDown={onKeyDown}
          onChange={(event) => {
            const value = event.target.value;
            if (keyed.current) {
              keyed.current = false;
              setChoice(value === current.id ? null : value);
              return;
            }
            move(value);
          }}
          className="min-w-0 flex-1 rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent aria-busy:opacity-60"
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
        {target !== null ? (
          <button
            type="button"
            data-testid="stage-select-move"
            aria-disabled={pending || undefined}
            onClick={() => {
              // The button goes once the choice is made; focus goes back to
              // the select rather than to <body> with it.
              selectRef.current?.focus();
              move(target.id);
            }}
            className="shrink-0 rounded-button border border-accent px-3 py-2 text-sm font-medium outline-none hover:bg-accent/10 focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11"
          >
            Move<span className="sr-only"> to {target.name}</span>
          </button>
        ) : null}
      </div>

      {/*
        The live region carries what the move did, and the standing hint sits
        beside it rather than inside it — a permanent sentence in a live region
        is a sentence that gets announced again every time the region settles.
      */}
      <p
        id={`${selectId}-status`}
        data-testid="stage-select-status"
        data-state={pending ? "moving" : target !== null ? "chosen" : status.kind}
        className={[
          "min-h-4 text-xs",
          status.kind === "error" ||
          (status.kind === "moved" && status.notice !== null)
            ? "text-attention"
            : "text-muted",
        ].join(" ")}
      >
        <span role={status.kind === "error" ? "alert" : "status"}>
          {pending
            ? "Moving…"
            : target !== null
              ? `Not moved yet. Enter or Move takes it to ${target.name}; Escape puts it back.`
              : status.kind === "moved"
              ? `Moved to ${status.name}.${status.notice ? ` ${status.notice}` : ""}`
              : status.kind === "error"
                ? status.message
                : ""}
        </span>
        {!pending && target === null && status.kind === "idle" ? (
          <span>Moving from here runs the same packaging gate as the board.</span>
        ) : null}
      </p>
    </div>
  );
}
