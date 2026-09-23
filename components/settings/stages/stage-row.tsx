"use client";

import { useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { renameStage, removeStage, setStageEnabled } from "@/app/actions/stages";
import { SaveStatus, useAutosave, type SaveState } from "@/components/autosave";
import { MoveButton } from "@/components/settings/move-button";
import { Refusal } from "@/components/settings/refusal";
import { RemoveConfirm } from "@/components/settings/remove-confirm";
import {
  INERT_NOTE,
  KIND_NOTES,
  STAGE_NAME_MAX,
  hiddenVideosSentence,
  ideaStaysOnSentence,
  occupiedHref,
  type MoveVerdict,
} from "@/lib/stage-settings";

import type { SettingsStage } from "./types";

/**
 * One stage: its order, its label, what it does, how many videos it holds,
 * and whether it is on.
 *
 * ## Which control is which kind of edit
 *
 * The four things on this row are not four equal settings, and the row is
 * laid out to say so:
 *
 * - **The arrows** (`MoveButton`, the area's one reorder control) move the
 *   column on the board and nothing else. They are disabled — not hidden —
 *   where the move would carry a core stage across another core stage, and
 *   the button says which pair keeps its order.
 * - **The name** is a label. It saves on blur or Enter through `useAutosave`,
 *   the same hook every field on the video page uses, so a failed rename is
 *   the same failure line with the same retry. The sentence under it — what
 *   this kind *does* — is what stays true whatever the name becomes.
 * - **The switch** changes the board's shape. It flips optimistically, because
 *   a controlled checkbox that springs back until the round trip lands reads
 *   as "the click did nothing", and it is put back with the reason when the
 *   database refuses. The refusal (`Refusal`, the area's one refusal line)
 *   names the count and links to the videos. While the round trip is out the
 *   row is `aria-busy` and its own status line says "Saving…"; the box is
 *   *not* disabled, because a disabled control drops keyboard focus on
 *   `<body>` — re-entry is guarded in the handler instead.
 * - **Remove** exists only on an inert stage, behind a second click
 *   (`RemoveConfirm`, which also owns where focus goes between the two).
 *
 * The Idea stage's switch is the one control here that is offered disabled:
 * capture always lands in it, so `set_stage_enabled` refuses to switch it off
 * (0008), and a switch that can never do anything is more honest greyed out
 * with the reason beside it than live and refusing every time.
 */
export function StageRow({
  stage,
  channelSlug,
  index,
  total,
  upVerdict,
  downVerdict,
  onMove,
  onRenamed,
  onEnabledChanged,
  onRemoved,
  moveButtonRef,
}: {
  stage: SettingsStage;
  channelSlug: string;
  /** Zero-based place in the list, for the "3 of 10" a screen reader hears. */
  index: number;
  total: number;
  upVerdict: MoveVerdict;
  downVerdict: MoveVerdict;
  /** Ask the editor to move this row; it owns the order and the round trip. */
  onMove: (direction: "up" | "down") => void;
  onRenamed: (name: string) => void;
  onEnabledChanged: (enabled: boolean) => void;
  onRemoved: () => void;
  /** So the editor can put focus back on an arrow after a move re-renders it. */
  moveButtonRef: (direction: "up" | "down") => RefObject<HTMLButtonElement | null>;
}) {
  const nameId = useId();
  const switchId = useId();
  const noteId = useId();
  const switchNoteId = useId();

  /* ---------------------------------------------------------------- name -- */

  const name = useAutosave({
    initial: stage.name,
    save: async (next) => {
      const result = await renameStage({ stageId: stage.id, name: next });
      if (!result.ok) return { ok: false, error: result.error };
      onRenamed(result.name);
      return { ok: true, value: result.name };
    },
  });

  function onNameKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      name.commit();
    } else if (event.key === "Escape") {
      // Consumed: reverting the name is all Escape means here.
      event.preventDefault();
      name.setValue(stage.name);
    }
  }

  /* -------------------------------------------------------------- switch -- */

  const [enabled, setEnabled] = useState(stage.isEnabled);
  const [switchState, setSwitchState] = useState<SaveState<never>>({ kind: "idle" });
  const switching = useRef(false);
  const [refusal, setRefusal] = useState<{
    message: string;
    href?: string;
    label?: string;
  } | null>(null);

  // A server render is authoritative; keep only the delta this row produced.
  const propsVersion = `${stage.id}|${stage.isEnabled}`;
  const [lastVersion, setLastVersion] = useState(propsVersion);
  if (propsVersion !== lastVersion) {
    setLastVersion(propsVersion);
    setEnabled(stage.isEnabled);
  }

  async function toggle(next: boolean): Promise<void> {
    // Re-entry is guarded here rather than by disabling the box: a disabled
    // checkbox drops keyboard focus on <body> for the length of the round trip.
    if (switching.current) return;
    switching.current = true;
    const previous = enabled;
    setEnabled(next);
    setSwitchState({ kind: "saving" });
    setRefusal(null);
    try {
      const result = await setStageEnabled({ stageId: stage.id, enabled: next });
      if (!result.ok) {
        setEnabled(previous);
        setSwitchState({ kind: "idle" });
        setRefusal({
          message: result.error,
          href: result.occupiedHref,
          label:
            result.occupied === undefined
              ? undefined
              : stage.kind === "idea"
                ? `See ${result.occupied === 1 ? "it" : "them"} in Ideas`
                : `See ${result.occupied === 1 ? "it" : "them"} on the board`,
        });
        return;
      }
      setEnabled(result.enabled);
      setSwitchState({ kind: "saved" });
      onEnabledChanged(result.enabled);
    } catch {
      setEnabled(previous);
      setSwitchState({ kind: "idle" });
      setRefusal({
        message: "Could not reach the server, so the stage is unchanged. Try again.",
      });
    } finally {
      switching.current = false;
    }
  }

  /* -------------------------------------------------------------- remove -- */

  const [removing, setRemoving] = useState<"idle" | "confirm" | "busy">("idle");

  async function remove(): Promise<void> {
    setRemoving("busy");
    setRefusal(null);
    try {
      const result = await removeStage({ stageId: stage.id });
      if (!result.ok) {
        setRemoving("idle");
        setRefusal({
          message: result.error,
          href: result.occupiedHref,
          label: result.occupied === undefined ? undefined : "See them on the board",
        });
        return;
      }
      onRemoved();
    } catch {
      setRemoving("idle");
      setRefusal({
        message: "Could not reach the server, so nothing was removed. Try again.",
      });
    }
  }

  /* -------------------------------------------------------------- render -- */

  const inert = stage.kind === null;
  const count = stage.occupied;
  // Idea stays on: the switch is offered greyed out, with the reason.
  const pinnedOn = stage.kind === "idea" && enabled;
  // A switched-off stage still holding videos: unreachable from any screen
  // since 0008, so when it is seen it is said, with the link.
  const hidden = !enabled && count > 0;

  return (
    <li
      data-testid="stage-row"
      data-stage-id={stage.id}
      data-stage-name={stage.name}
      data-kind={stage.kind ?? "inert"}
      data-enabled={enabled ? "true" : "false"}
      aria-busy={switchState.kind === "saving" || removing === "busy" ? true : undefined}
      className={[
        // M9: below `md` the count and the switch drop under the note instead
        // of taking a third column, which left the name field 40px wide at 390.
        "grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-4 gap-y-2 rounded-card border bg-surface px-4 py-3 max-md:grid-cols-[auto_minmax(0,1fr)] max-md:gap-x-3",
        inert ? "border-dashed border-border" : "border-border",
        enabled ? "" : "opacity-80",
      ].join(" ")}
    >
      {/* The arrows. A column, so up is above down and the pair reads as
          one control with two ends. */}
      <div className="flex flex-col gap-1 pt-0.5">
        <MoveButton
          direction="up"
          subject={stage.name}
          verdict={upVerdict}
          onClick={() => onMove("up")}
          buttonRef={moveButtonRef("up")}
          testIdPrefix="stage"
        />
        <MoveButton
          direction="down"
          subject={stage.name}
          verdict={downVerdict}
          onClick={() => onMove("down")}
          buttonRef={moveButtonRef("down")}
          testIdPrefix="stage"
        />
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <label htmlFor={nameId} className="sr-only">
            Name of stage {index + 1} of {total}
          </label>
          <input
            id={nameId}
            data-testid="stage-name"
            value={name.value}
            maxLength={STAGE_NAME_MAX}
            aria-describedby={noteId}
            onChange={(event) => name.setValue(event.target.value)}
            onBlur={name.commit}
            onKeyDown={onNameKey}
            // The label is the user's word for the stage, so it is set in the
            // reading face, like a title. Everything else on the row is chrome.
            className="min-w-0 flex-1 basis-32 rounded-input border border-transparent bg-transparent px-1.5 py-0.5 font-display text-[17px] leading-tight outline-none hover:border-border focus-visible:border-border focus-visible:ring-2 focus-visible:ring-accent"
          />
          <span
            data-testid="stage-kind"
            className={[
              "shrink-0 rounded-full border px-2 py-0.5 text-[11px] leading-4",
              inert ? "border-dashed border-border text-muted" : "border-border text-muted",
            ].join(" ")}
          >
            {inert ? "added — no behaviour" : `core · ${stage.kind}`}
          </span>
        </div>

        <p id={noteId} className="text-[12px] leading-5 text-muted">
          {inert ? INERT_NOTE : KIND_NOTES[stage.kind!]}
        </p>

        <SaveStatus state={name.state} testId="stage-name-status" />

        {refusal ? (
          <Refusal
            testId="stage-refusal"
            message={refusal.message}
            href={refusal.href}
            label={refusal.label}
          />
        ) : hidden ? (
          <Refusal
            testId="stage-hidden-videos"
            message={hiddenVideosSentence(stage.name, count)}
            href={occupiedHref(stage.kind, channelSlug)}
            label={stage.kind === "idea" ? "Open Ideas" : "Open the video page from the board"}
          />
        ) : null}
      </div>

      <div className="flex flex-col items-end gap-2 max-md:col-start-2 max-md:items-start">
        <span
          data-testid="stage-count"
          data-count={count}
          title={
            count === 0
              ? "No videos in this stage"
              : `${count} ${count === 1 ? "video" : "videos"} in this stage (archived ones not counted)`
          }
          className="font-mono text-[11px] text-muted"
        >
          {count === 0 ? "empty" : `${count} ${count === 1 ? "video" : "videos"}`}
        </span>

        <div className="flex flex-col items-end gap-1 max-md:items-start">
          <div className="flex items-center gap-2">
            <input
              id={switchId}
              type="checkbox"
              data-testid="stage-enabled"
              checked={enabled}
              disabled={pinnedOn || removing === "busy"}
              aria-describedby={pinnedOn ? switchNoteId : undefined}
              title={pinnedOn ? ideaStaysOnSentence(stage.name) : undefined}
              onChange={(event) => void toggle(event.target.checked)}
              className="size-4 accent-[var(--accent)] outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            <label htmlFor={switchId} className="text-[12px]">
              {/* The stage's name is part of the control's name, so nine
                  checkboxes are not nine "On the board"s to a screen reader;
                  the visible word is the state. */}
              <span className="sr-only">{stage.name}: </span>
              {enabled ? "On the board" : "Off"}
            </label>
          </div>
          {pinnedOn ? (
            <span
              id={switchNoteId}
              data-testid="stage-pinned-on"
              className="max-w-[16rem] text-right text-[11px] leading-4 text-muted max-md:text-left"
            >
              Stays on: capture lands here.
            </span>
          ) : (
            <SaveStatus state={switchState} testId="stage-switch-status" />
          )}
        </div>

        {inert ? (
          <RemoveConfirm
            state={removing}
            onAsk={() => setRemoving("confirm")}
            onConfirm={() => void remove()}
            onKeep={() => setRemoving("idle")}
            confirmLabel="Yes, remove"
            question="Remove?"
            subject={stage.name}
            testIdPrefix="stage"
          />
        ) : null}
      </div>
    </li>
  );
}
