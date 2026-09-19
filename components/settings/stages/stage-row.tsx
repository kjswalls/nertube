"use client";

import Link from "next/link";
import { useId, useState, type KeyboardEvent, type RefObject } from "react";

import { renameStage, removeStage, setStageEnabled } from "@/app/actions/stages";
import { SaveStatus, useAutosave } from "@/components/autosave";
import { INERT_NOTE, KIND_NOTES, STAGE_NAME_MAX, type MoveVerdict } from "@/lib/stage-settings";

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
 * - **The arrows** move the column on the board and nothing else. They are
 *   disabled — not hidden — where the move would carry a core stage across
 *   another core stage, and the button's title says which pair keeps its
 *   order. Disabled rather than absent so the row's shape never changes and a
 *   keyboard user finds the arrows where they were; the explanation is one
 *   sentence in the header of the list, and again on each disabled button.
 * - **The name** is a label. It saves on blur or Enter through `useAutosave`,
 *   the same hook every field on the video page uses, so a failed rename is
 *   the same failure line with the same retry. The sentence under it — what
 *   this kind *does* — is what stays true whatever the name becomes.
 * - **The switch** changes the board's shape. It flips optimistically, because
 *   a controlled checkbox that springs back until the round trip lands reads
 *   as "the click did nothing", and it is put back with the reason when the
 *   database refuses. The refusal names the count and links to the videos.
 * - **Remove** exists only on an inert stage, behind a second click.
 */
export function StageRow({
  stage,
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
      name.setValue(stage.name);
    }
  }

  /* -------------------------------------------------------------- switch -- */

  const [enabled, setEnabled] = useState(stage.isEnabled);
  const [switching, setSwitching] = useState(false);
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
    const previous = enabled;
    setEnabled(next);
    setSwitching(true);
    setRefusal(null);
    try {
      const result = await setStageEnabled({ stageId: stage.id, enabled: next });
      if (!result.ok) {
        setEnabled(previous);
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
      onEnabledChanged(result.enabled);
    } catch {
      setEnabled(previous);
      setRefusal({
        message: "Could not reach the server, so the stage is unchanged. Try again.",
      });
    } finally {
      setSwitching(false);
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

  return (
    <li
      data-testid="stage-row"
      data-stage-id={stage.id}
      data-stage-name={stage.name}
      data-kind={stage.kind ?? "inert"}
      data-enabled={enabled ? "true" : "false"}
      className={[
        "grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-4 gap-y-2 rounded-card border bg-surface px-4 py-3",
        inert ? "border-dashed border-border" : "border-border",
        enabled ? "" : "opacity-80",
      ].join(" ")}
    >
      {/* The arrows. A column, so up is above down and the pair reads as
          one control with two ends. */}
      <div className="flex flex-col gap-1 pt-0.5">
        <MoveButton
          direction="up"
          stageName={stage.name}
          verdict={upVerdict}
          onClick={() => onMove("up")}
          buttonRef={moveButtonRef("up")}
        />
        <MoveButton
          direction="down"
          stageName={stage.name}
          verdict={downVerdict}
          onClick={() => onMove("down")}
          buttonRef={moveButtonRef("down")}
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
            className="min-w-0 flex-1 rounded-input border border-transparent bg-transparent px-1.5 py-0.5 font-display text-[17px] leading-tight outline-none hover:border-border focus-visible:border-border focus-visible:ring-2 focus-visible:ring-accent"
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
          <p
            role="alert"
            data-testid="stage-refusal"
            className="text-[12px] leading-5 text-over-limit"
          >
            {refusal.message}
            {refusal.href && refusal.label ? (
              <>
                {" "}
                <Link
                  href={refusal.href}
                  data-testid="stage-refusal-link"
                  className="underline decoration-over-limit/50 underline-offset-2 hover:decoration-over-limit"
                >
                  {refusal.label}
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col items-end gap-2">
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

        <div className="flex items-center gap-2">
          <input
            id={switchId}
            type="checkbox"
            data-testid="stage-enabled"
            checked={enabled}
            disabled={switching || removing === "busy"}
            onChange={(event) => void toggle(event.target.checked)}
            className="size-4 accent-[var(--accent)] outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <label htmlFor={switchId} className="text-[12px]">
            {enabled ? "On the board" : "Off"}
          </label>
        </div>

        {inert ? (
          removing === "confirm" ? (
            <span className="flex items-center gap-1 text-[12px]">
              <span className="text-muted">Remove?</span>
              <button
                type="button"
                data-testid="stage-remove-yes"
                onClick={() => void remove()}
                className="rounded-button border border-over-limit/50 px-2 py-0.5 text-over-limit outline-none hover:bg-over-limit/10 focus-visible:ring-2 focus-visible:ring-accent"
              >
                Yes, remove
              </button>
              <button
                type="button"
                onClick={() => setRemoving("idle")}
                className="rounded-button border border-border px-2 py-0.5 outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-accent"
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              data-testid="stage-remove"
              disabled={removing === "busy"}
              onClick={() => setRemoving("confirm")}
              className="text-[12px] text-muted underline decoration-border underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
            >
              {removing === "busy" ? "Removing…" : "Remove"}
            </button>
          )
        ) : null}
      </div>
    </li>
  );
}

/**
 * One arrow. `disabled` carries the verdict's reason as its title and as
 * visually hidden text, so the *why* is in the accessible name of the thing
 * that cannot be pressed, not only in a tooltip a keyboard user cannot summon.
 */
function MoveButton({
  direction,
  stageName,
  verdict,
  onClick,
  buttonRef,
}: {
  direction: "up" | "down";
  stageName: string;
  verdict: MoveVerdict;
  onClick: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const word = direction === "up" ? "up" : "down";
  return (
    <button
      ref={buttonRef}
      type="button"
      data-testid={`stage-move-${direction}`}
      data-offered={verdict.ok ? "true" : "false"}
      disabled={!verdict.ok}
      onClick={onClick}
      title={verdict.ok ? `Move ${stageName} ${word}` : verdict.reason}
      aria-label={
        verdict.ok
          ? `Move ${stageName} ${word}`
          : `Move ${stageName} ${word} — not available. ${verdict.reason}`
      }
      className="flex size-6 items-center justify-center rounded-button border border-border font-mono text-[11px] leading-none outline-none enabled:hover:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-30"
    >
      <span aria-hidden="true">{direction === "up" ? "▲" : "▼"}</span>
    </button>
  );
}
