"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import { addStage, moveStage } from "@/app/actions/stages";
import { IN_FLIGHT, useMoveFocus } from "@/components/settings/move-button";
import { Refusal } from "@/components/settings/refusal";
import { STAGE_NAME_MAX, canMove } from "@/lib/stage-settings";

import { StageRow } from "./stage-row";
import type { SettingsChannel, SettingsStage } from "./types";

/**
 * One channel's stages, in board order, editable in place.
 *
 * ## What this component owns
 *
 * The list. Each row owns its own label, switch and refusal line
 * (`StageRow`), but the *order* is a property of the list, and so is adding
 * to it — so the arrows report up to here, `moveStage` is called from here,
 * and the answer (the whole order, renumbered by the database) replaces what
 * is on screen. Nothing is moved optimistically: a reorder is one round trip,
 * it is rarely pressed twice a second, and a row that jumped and then jumped
 * back would be worse than a row that took 200ms to move.
 *
 * A server render is still authoritative. The page re-reads on every
 * navigation and after `router.refresh()`, and when the set it sends differs
 * from the set last adopted — a stage added in another tab, a count changed
 * by a move on the board — the list is replaced wholesale. The same pattern
 * `RepurposedLane` and `FlowFields` use, for the same reason: local state is
 * only ever the delta this screen produced.
 *
 * ## Which arrows are lit
 *
 * `canMove` decides, per row and per direction, from the list as it stands —
 * the same function `moveStage` runs on the server before it asks the
 * database, which runs the same rule a third time. On a fresh channel every
 * arrow is off, because nine core stages in a row have nowhere legal to go;
 * the sentence in the header says why, so eighteen grey buttons do not read
 * as a broken screen. Add a stage and its arrows light up, and so do the
 * arrows of the core stages either side of it.
 *
 * Focus after a move is `useMoveFocus`'s job, shared with the other two
 * editors: the same arrow if it is still offered, otherwise the other one,
 * otherwise the name.
 */
export function StagesEditor({
  channel,
  stages,
}: {
  channel: SettingsChannel;
  stages: readonly SettingsStage[];
}) {
  const router = useRouter();

  const serverKey = keyOf(stages);
  const [adoptedKey, setAdoptedKey] = useState(serverKey);
  const [list, setList] = useState<readonly SettingsStage[]>(stages);
  if (adoptedKey !== serverKey) {
    setAdoptedKey(serverKey);
    setList(stages);
  }

  const [moving, setMoving] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  const focus = useMoveFocus({
    deps: [list],
    inFlight: moving !== null,
    nameField: (stageId) => `[data-stage-id="${stageId}"] [data-testid="stage-name"]`,
  });

  /* ---------------------------------------------------------------- moves -- */

  async function move(stageId: string, direction: "up" | "down"): Promise<void> {
    const index = list.findIndex((stage) => stage.id === stageId);
    const verdict = canMove(list, index, direction);
    if (!verdict.ok || moving !== null) return;

    setMoving(stageId);
    setMoveError(null);
    // Asked for before the write, consumed after it settles: a failed move
    // leaves the list as it was and focus goes back to the arrow pressed.
    focus.requestFocus(stageId, direction);
    try {
      const result = await moveStage({ stageId, direction });
      if (!result.ok) {
        setMoveError(result.error);
        return;
      }
      const positions = new Map(result.order.map((row) => [row.id, row.position]));
      setList((current) =>
        [...current]
          .map((stage) => ({ ...stage, position: positions.get(stage.id) ?? stage.position }))
          .sort((a, b) => a.position - b.position),
      );
      router.refresh();
    } catch {
      setMoveError("Could not reach the server, so the order is unchanged. Try again.");
    } finally {
      setMoving(null);
    }
  }

  /* ------------------------------------------------------------- per-row -- */

  function patch(stageId: string, change: Partial<SettingsStage>): void {
    setList((current) =>
      current.map((stage) => (stage.id === stageId ? { ...stage, ...change } : stage)),
    );
  }

  const enabledCount = list.filter((stage) => stage.isEnabled).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-[13px] font-medium">
          Board order{" "}
          <span className="font-mono text-[11px] font-normal text-muted">
            {enabledCount} of {list.length} on the board
          </span>
        </h2>
        <p className="text-[12px] leading-5 text-muted">
          Top to bottom here is left to right on the board. Core stages keep
          their order — the pipeline is a pipeline — so their arrows only light
          up next to a stage you added, which can sit anywhere. Renaming
          changes the label and nothing else; what a stage <em>does</em> is
          written under its name and stays put.
        </p>
      </div>

      {moveError ? <Refusal testId="stage-move-error" message={moveError} /> : null}

      <ol data-testid="stage-list" aria-label="Stages, in board order" className="flex flex-col gap-2">
        {list.map((stage, index) => (
          <StageRow
            key={stage.id}
            stage={stage}
            channelSlug={channel.slug}
            index={index}
            total={list.length}
            upVerdict={moving !== null ? IN_FLIGHT : canMove(list, index, "up")}
            downVerdict={moving !== null ? IN_FLIGHT : canMove(list, index, "down")}
            onMove={(direction) => void move(stage.id, direction)}
            onRenamed={(name) => {
              patch(stage.id, { name });
              router.refresh();
            }}
            onEnabledChanged={(isEnabled) => {
              patch(stage.id, { isEnabled });
              router.refresh();
            }}
            onRemoved={() => {
              // The row is gone with the button that removed it; focus goes
              // to the next row's name, or to the add form when it was last.
              const next = list[index + 1] ?? list[index - 1];
              focus.requestField(
                next
                  ? `[data-stage-id="${next.id}"] [data-testid="stage-name"]`
                  : "#add-stage-name",
              );
              setList((current) => current.filter((other) => other.id !== stage.id));
              router.refresh();
            }}
            moveButtonRef={(direction) => focus.buttonRef(stage.id, direction)}
          />
        ))}
      </ol>

      <AddStageForm
        channel={channel}
        taken={list.map((stage) => stage.name)}
        onAdded={(stage) => {
          setList((current) =>
            [...current, stage].sort((a, b) => a.position - b.position),
          );
          router.refresh();
        }}
      />
    </div>
  );
}

/** A key that changes when the server's set does, in any way the list shows. */
function keyOf(stages: readonly SettingsStage[]): string {
  return stages
    .map(
      (stage) =>
        `${stage.id}|${stage.name}|${stage.position}|${stage.isEnabled}|${stage.occupied}`,
    )
    .join(";");
}

/**
 * Adding an inert stage: one input, one button, appended at the end.
 *
 * The form says what it is adding before it is pressed — a column with no
 * behaviour — because that is the surprise a person would otherwise get on
 * the board: a "Sponsor review" column that videos can sit in and that the
 * gate, the badges and `/now` all look straight through.
 */
function AddStageForm({
  channel,
  taken,
  onAdded,
}: {
  channel: SettingsChannel;
  taken: readonly string[];
  onAdded: (stage: SettingsStage) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const trimmed = name.trim();
  const duplicate = taken.some(
    (other) => other.trim().toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
  );

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (trimmed === "" || duplicate || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await addStage({ channelId: channel.id, name: trimmed });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onAdded({ ...result.stage, occupied: 0 });
      setName("");
    } catch {
      setError("Could not reach the server, so nothing was added. Try again.");
    } finally {
      setBusy(false);
      // Back to the box on every outcome: the next stage, or the same name
      // to fix. The button is not disabled while the add is out, so focus
      // was never dropped; this is for the Enter-in-the-box path too.
      input.current?.focus();
    }
  }

  const refused = error ?? (duplicate ? `${channel.name} already has a stage called “${trimmed}”.` : null);

  return (
    <form
      onSubmit={(event) => void submit(event)}
      data-testid="add-stage"
      className="flex flex-col gap-2 rounded-card border border-dashed border-border px-4 py-3"
    >
      <label htmlFor="add-stage-name" className="text-[13px] font-medium">
        Add a stage
      </label>
      <div className="flex items-center gap-2">
        <input
          id="add-stage-name"
          ref={input}
          data-testid="add-stage-name"
          value={name}
          maxLength={STAGE_NAME_MAX}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          placeholder="e.g. Sponsor review"
          className="min-w-0 flex-1 basis-40 rounded-input border border-border bg-background px-3 py-2 text-[13px] outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent max-md:text-base thumb:min-h-11"
        />
        <button
          type="submit"
          data-testid="add-stage-submit"
          // Not disabled while busy: `submit` ignores re-entry, and a button
          // that disables itself under the cursor drops focus on <body>.
          aria-busy={busy ? true : undefined}
          disabled={trimmed === "" || duplicate}
          className="shrink-0 rounded-button border border-border px-3 py-2 text-[13px] font-medium outline-none enabled:hover:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 thumb:min-h-11"
        >
          {busy ? "Adding…" : "Add stage"}
        </button>
      </div>
      {refused ? (
        <Refusal testId="add-stage-status" message={refused} />
      ) : (
        <p data-testid="add-stage-status" className="text-[12px] leading-5 text-muted">
          It lands at the end of the board, switched on, with no behaviour: no
          gate, no badge, and not on /now&rsquo;s path. Its checklist template
          starts empty and is edited under Checklists. Move it with the arrows.
        </p>
      )}
    </form>
  );
}
