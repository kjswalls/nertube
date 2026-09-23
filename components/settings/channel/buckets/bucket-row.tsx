"use client";

import { useId, useState, type KeyboardEvent, type RefObject } from "react";

import {
  removeBucket,
  renameBucket,
  setBucketQuota,
  type SettingsBucket,
} from "@/app/actions/buckets";
import { SaveStatus, useAutosave, type SaveState } from "@/components/autosave";
import { IN_FLIGHT, MoveButton, edgeVerdict } from "@/components/settings/move-button";
import { Refusal } from "@/components/settings/refusal";
import { RemoveConfirm } from "@/components/settings/remove-confirm";
import {
  BUCKET_NAME_MAX,
  MAX_QUOTA,
  parseQuotaInput,
  quotaText,
  unfiledSentence,
} from "@/lib/bucket-settings";
import type { BucketAxis } from "@/lib/buckets";

import type { EditableBucket } from "./types";

/**
 * One bucket: its place on the axis, its name, its quota, what is filed
 * under it, and a way to remove it.
 *
 * ## Which control is which kind of edit
 *
 * - **The arrows** (`MoveButton`, the area's one reorder control) move it
 *   one place on its axis — one row or column on the matrix, one place in
 *   the pickers. The list owns the order, so the arrows report up and the
 *   answer replaces the axis.
 * - **The name** is a label. Videos carry the bucket's id, so a rename
 *   re-files nothing; it saves on blur or Enter through `useAutosave`, the
 *   one save queue, and a name the axis already has is refused with the
 *   reason on the row.
 * - **The quota** is the matrix's denominator for this month. The box is a
 *   number or nothing: nothing means no quota (a count and no bar), and zero
 *   is refused here before the request is made — `check (monthly_quota > 0)`
 *   would refuse it too, in words nobody can read.
 * - **Remove** is behind a second click (`RemoveConfirm`, the area's one
 *   such control, which also owns where focus goes between the two) that
 *   says, with the count, what it does to the videos filed under the bucket:
 *   they are unfiled on this axis, and nothing else about them changes.
 */
export function BucketRow({
  bucket,
  axis,
  index,
  total,
  busy,
  onMove,
  onChanged,
  onRemoved,
  moveButtonRef,
}: {
  bucket: EditableBucket;
  axis: BucketAxis;
  index: number;
  total: number;
  /** A reorder is in flight; the arrows wait, the fields do not. */
  busy: boolean;
  onMove: (direction: "up" | "down") => void;
  /** The axis as the server now holds it, after a name or quota write. */
  onChanged: (buckets: readonly SettingsBucket[]) => void;
  onRemoved: (
    buckets: readonly SettingsBucket[],
    removed: { name: string; unfiled: number; archived: number },
  ) => void;
  moveButtonRef: (direction: "up" | "down") => RefObject<HTMLButtonElement | null>;
}) {
  const nameId = useId();
  const quotaId = useId();
  const statusId = useId();

  /* ---------------------------------------------------------------- name -- */

  const name = useAutosave({
    initial: bucket.name,
    save: async (next) => {
      const result = await renameBucket({ bucketId: bucket.id, name: next });
      if (!result.ok) return { ok: false, error: result.error };
      onChanged(result.buckets);
      const stored = result.buckets.find((row) => row.id === bucket.id);
      return { ok: true, value: stored?.name ?? next };
    },
  });

  function onNameKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      name.commit();
    } else if (event.key === "Escape") {
      // Consumed: reverting the name is all Escape means here.
      event.preventDefault();
      name.setValue(bucket.name);
    }
  }

  /* --------------------------------------------------------------- quota -- */

  const quota = useAutosave({
    initial: quotaText(bucket.monthlyQuota),
    save: async (raw) => {
      // Refused here, in words, before the database's CHECK is reached.
      const parsed = parseQuotaInput(raw);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      const result = await setBucketQuota({ bucketId: bucket.id, monthlyQuota: parsed.value });
      if (!result.ok) return { ok: false, error: result.error };
      onChanged(result.buckets);
      const stored = result.buckets.find((row) => row.id === bucket.id);
      return { ok: true, value: quotaText(stored?.monthlyQuota ?? parsed.value) };
    },
  });

  function onQuotaKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      quota.commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      quota.setValue(quotaText(bucket.monthlyQuota));
    }
  }

  /* -------------------------------------------------------------- remove -- */

  const [removing, setRemoving] = useState<"idle" | "confirm" | "busy">("idle");
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function remove(): Promise<void> {
    setRemoving("busy");
    setRemoveError(null);
    try {
      const result = await removeBucket({ bucketId: bucket.id });
      if (!result.ok) {
        setRemoving("idle");
        setRemoveError(result.error);
        return;
      }
      onRemoved(result.buckets, result.removed);
    } catch {
      setRemoving("idle");
      setRemoveError("Could not reach the server, so nothing was removed. Try again.");
    }
  }

  /* -------------------------------------------------------------- render -- */

  const status = combine(name.state, quota.state);
  const filed = bucket.filed;

  return (
    <li
      data-testid="bucket-row"
      data-bucket-id={bucket.id}
      data-bucket-name={bucket.name}
      data-axis={axis}
      data-position={index + 1}
      data-quota={bucket.monthlyQuota ?? ""}
      data-filed={filed}
      // Below `md` the filed count and Remove drop under the name, and the
      // name takes its own line above the quota — the treatment the stage row
      // got. Beside them the name was 47px wide at 390 and 17px at 360, one
      // glyph a row (M9 review).
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-4 gap-y-2 rounded-card border border-border bg-surface px-4 py-3 max-md:grid-cols-[auto_minmax(0,1fr)] max-md:gap-x-3"
    >
      <div className="flex flex-col gap-1 pt-0.5">
        <MoveButton
          direction="up"
          subject={bucket.name}
          verdict={busy ? IN_FLIGHT : edgeVerdict(bucket.name, index, total, "up")}
          onClick={() => onMove("up")}
          buttonRef={moveButtonRef("up")}
          testIdPrefix="bucket"
        />
        <MoveButton
          direction="down"
          subject={bucket.name}
          verdict={busy ? IN_FLIGHT : edgeVerdict(bucket.name, index, total, "down")}
          onClick={() => onMove("down")}
          buttonRef={moveButtonRef("down")}
          testIdPrefix="bucket"
        />
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label htmlFor={nameId} className="sr-only">
            Name of {axis === "vertical" ? "pillar" : "format"} {index + 1} of {total}
          </label>
          <input
            id={nameId}
            data-testid="bucket-name"
            value={name.value}
            maxLength={BUCKET_NAME_MAX}
            onChange={(event) => name.setValue(event.target.value)}
            onBlur={name.commit}
            onKeyDown={onNameKey}
            // The user's word for the bucket: the reading face, like a title.
            className="min-w-0 flex-1 basis-32 rounded-input border border-transparent bg-transparent px-1.5 py-0.5 font-display text-[17px] max-md:basis-full leading-tight outline-none hover:border-border focus-visible:border-border focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11"
          />

          <div className="flex shrink-0 items-center gap-1.5">
            {/* The row's name is in the control's name — eight "a month"
                spinbuttons are eight of nothing to a screen reader — and the
                visible word stays the unit. */}
            <label htmlFor={quotaId} className="text-[12px] text-muted">
              <span className="sr-only">Monthly quota for {bucket.name}, </span>a month
            </label>
            <input
              id={quotaId}
              data-testid="bucket-quota"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_QUOTA}
              step={1}
              value={quota.value}
              placeholder="—"
              aria-invalid={quota.state.kind === "error" ? true : undefined}
              aria-describedby={quota.state.kind === "error" ? statusId : undefined}
              onChange={(event) => quota.setValue(event.target.value)}
              onBlur={quota.commit}
              onKeyDown={onQuotaKey}
              title="Monthly quota: how many videos a month should carry this bucket. Empty means no quota."
              className="w-16 rounded-input border border-border bg-background px-2 py-1 text-right font-mono text-[12px] leading-5 outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent max-md:text-base thumb:text-base thumb:min-h-11"
            />
          </div>
        </div>

        <SaveStatus id={statusId} state={status} testId="bucket-status" />

        {removeError ? <Refusal testId="bucket-remove-error" message={removeError} /> : null}
      </div>

      <div className="flex flex-col items-end gap-2 max-md:col-start-2 max-md:flex-row max-md:flex-wrap max-md:items-center max-md:gap-x-4">
        <span
          data-testid="bucket-filed"
          data-count={filed}
          title={
            filed === 0
              ? "No videos filed here"
              : `${filed} ${filed === 1 ? "video" : "videos"} filed here (archived ones not counted)`
          }
          className="font-mono text-[11px] text-muted"
        >
          {filed === 0 ? "nothing filed" : `${filed} ${filed === 1 ? "video" : "videos"}`}
        </span>

        <RemoveConfirm
          state={removing}
          onAsk={() => setRemoving("confirm")}
          onConfirm={() => void remove()}
          onKeep={() => setRemoving("idle")}
          confirmLabel={filed === 0 ? "Yes, remove" : `Remove and unfile ${filed === 1 ? "it" : "them"}`}
          question={unfiledSentence(axis, bucket.name, filed)}
          subject={bucket.name}
          testIdPrefix="bucket"
        />
      </div>
    </li>
  );
}

/**
 * One status line for a row with two fields. A failure on either is the
 * line; otherwise the one that is doing something; otherwise idle.
 */
function combine(a: SaveState<string>, b: SaveState<string>): SaveState<string> {
  if (a.kind === "error") return a;
  if (b.kind === "error") return b;
  if (a.kind === "saving" || b.kind === "saving") return { kind: "saving" };
  if (a.kind === "saved" || b.kind === "saved") return { kind: "saved" };
  return { kind: "idle" };
}
