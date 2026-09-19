"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";

import { addBucket, moveBucketAction, type SettingsBucket } from "@/app/actions/buckets";
import { useMoveFocus } from "@/components/settings/move-button";
import { Refusal } from "@/components/settings/refusal";
import {
  BUCKET_NAME_MAX,
  MAX_QUOTA,
  axisCountSentence,
  axisStanding,
  bucketNameTaken,
  duplicateSentence,
  parseQuotaInput,
  sortBuckets,
} from "@/lib/bucket-settings";
import { AXIS_LABEL, type BucketAxis } from "@/lib/buckets";

import { BucketRow } from "./bucket-row";
import type { BucketsChannel, EditableBucket } from "./types";

/**
 * One axis of one channel's buckets — the topic pillars, or the formats —
 * editable in place.
 *
 * ## What this component owns
 *
 * The list. Each row owns its own name, quota and removal (`BucketRow`), but
 * the *order* is a property of the list and so is adding to it, so the arrows
 * report up to here, `moveBucketAction` is called from here, and the answer
 * — the whole axis, renumbered by the database — replaces what is on screen.
 * Nothing is moved optimistically: a reorder is one round trip, and a row
 * that jumped and then jumped back would be worse than a row that took 200ms
 * to move. Focus after a move is `useMoveFocus`'s job, shared with the stages
 * and template editors. Every other write also answers with the whole axis, and the same
 * replacement happens; the per-row `filed` counts the page loaded with are
 * carried across, because no write here moves a video.
 *
 * A server render is still authoritative. When the set it sends differs from
 * the set last adopted — a bucket added in another tab — the list is replaced
 * wholesale. Local state is only ever the delta this screen produced.
 *
 * ## Why the shape of the axis is on the heading
 *
 * BRIEF.md's matrix is 3–5 pillars by 8–12 formats, and the matrix M5 built
 * is only as good as this list. So the heading says where the axis stands
 * against that shape, in one sentence that changes as buckets are added, and
 * a channel with no pillars — every channel, on the day it is made — is told
 * so here rather than only on the matrix's empty state.
 */
export function AxisEditor({
  channel,
  axis,
  buckets,
}: {
  channel: BucketsChannel;
  axis: BucketAxis;
  buckets: readonly EditableBucket[];
}) {
  const router = useRouter();
  const headingId = useId();

  const serverKey = keyOf(buckets);
  const [adoptedKey, setAdoptedKey] = useState(serverKey);
  const [list, setList] = useState<readonly EditableBucket[]>(() => sortBuckets(buckets));
  if (adoptedKey !== serverKey) {
    setAdoptedKey(serverKey);
    setList(sortBuckets(buckets));
  }

  const [moving, setMoving] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [removedNote, setRemovedNote] = useState<string | null>(null);

  const focus = useMoveFocus(
    [list, moving],
    (bucketId) => `[data-bucket-id="${bucketId}"] [data-testid="bucket-name"]`,
  );

  /* ------------------------------------------------------------- adopting -- */

  /** The server's axis, with this screen's `filed` counts carried across. */
  function adopt(next: readonly SettingsBucket[]): void {
    setList((current) => {
      const counts = new Map(current.map((bucket) => [bucket.id, bucket.filed]));
      return sortBuckets(next.map((bucket) => ({ ...bucket, filed: counts.get(bucket.id) ?? 0 })));
    });
  }

  /* ---------------------------------------------------------------- moves -- */

  async function move(bucketId: string, direction: "up" | "down"): Promise<void> {
    if (moving !== null) return;
    setMoving(bucketId);
    setMoveError(null);
    setRemovedNote(null);
    try {
      const result = await moveBucketAction({ bucketId, direction });
      if (!result.ok) {
        setMoveError(result.error);
        return;
      }
      focus.requestFocus(bucketId, direction);
      adopt(result.buckets);
      router.refresh();
    } catch {
      setMoveError("Could not reach the server, so the order is unchanged. Try again.");
    } finally {
      setMoving(null);
    }
  }

  /* --------------------------------------------------------------- render -- */

  const standing = axisStanding(axis, list.length);

  return (
    <section
      data-testid="bucket-axis"
      data-axis={axis}
      data-count={list.length}
      data-standing={standing}
      aria-labelledby={headingId}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-display text-[17px] leading-tight font-semibold tracking-tight">
            {axis === "vertical" ? "Topic pillars" : "Formats"}
          </span>
          <span className="text-[12px] font-normal text-muted">
            {axis === "vertical" ? "verticals — the rows" : "horizontals — the columns"}
          </span>
        </h2>
        <p data-testid="bucket-axis-count" className="text-[12px] leading-5 text-muted">
          {axisCountSentence(axis, list.length)}{" "}
          {axis === "vertical"
            ? "A pillar is a topic this channel keeps coming back to — the three to five things it is about."
            : "A format is the shape a video takes: tutorial, review, vlog. The eight a new channel starts with are the brief's list; rename or remove any of them."}
        </p>
      </div>

      {moveError ? <Refusal testId="bucket-move-error" message={moveError} /> : null}

      {list.length === 0 ? (
        <p data-testid="bucket-axis-empty" className="text-[13px] leading-5 text-muted">
          {axis === "vertical" ? (
            <>
              No pillars yet, so the{" "}
              <Link
                href={`/c/${channel.slug}/ideas?view=matrix`}
                className="underline decoration-border underline-offset-2 hover:decoration-current"
              >
                matrix
              </Link>{" "}
              has no rows and nothing to cross the formats with. Name the first one below.
            </>
          ) : (
            <>
              No formats, so the matrix has no columns. Add one below — the brief&rsquo;s
              list is tutorial, listicle, review, self-experiment, vlog, reaction, case
              study and interview.
            </>
          )}
        </p>
      ) : (
        <ol
          data-testid="bucket-list"
          aria-label={`${AXIS_LABEL[axis]}s, in matrix order`}
          className="flex flex-col gap-2"
        >
          {list.map((bucket, index) => (
            <BucketRow
              key={bucket.id}
              bucket={bucket}
              axis={axis}
              index={index}
              total={list.length}
              busy={moving !== null}
              onMove={(direction) => void move(bucket.id, direction)}
              onChanged={(next) => {
                setRemovedNote(null);
                adopt(next);
                router.refresh();
              }}
              onRemoved={(next, removed) => {
                adopt(next);
                setRemovedNote(
                  removed.unfiled === 0
                    ? `Removed “${removed.name}”. No video was filed under it.`
                    : `Removed “${removed.name}” and unfiled ${removed.unfiled === 1 ? "one video" : `${removed.unfiled} videos`} — they keep everything else and can be filed again by hand.`,
                );
                router.refresh();
              }}
              moveButtonRef={(direction) => focus.buttonRef(bucket.id, direction)}
            />
          ))}
        </ol>
      )}

      {removedNote ? (
        <p role="status" data-testid="bucket-removed-note" className="text-[12px] leading-5 text-muted">
          {removedNote}
        </p>
      ) : null}

      <AddBucketForm
        channel={channel}
        axis={axis}
        taken={list}
        onAdded={(next) => {
          setRemovedNote(null);
          adopt(next);
          router.refresh();
        }}
      />
    </section>
  );
}

/** A key that changes when the server's set does, in any way the list shows. */
function keyOf(buckets: readonly EditableBucket[]): string {
  return buckets
    .map(
      (bucket) =>
        `${bucket.id}|${bucket.name}|${bucket.position}|${bucket.monthlyQuota ?? ""}|${bucket.filed}`,
    )
    .join(";");
}

/**
 * Adding a bucket: a name, an optional quota, one button, appended at the
 * end of the axis. A duplicate name is refused before the button is pressed
 * and again by the action; a quota of zero is refused before the request
 * exists.
 */
function AddBucketForm({
  channel,
  axis,
  taken,
  onAdded,
}: {
  channel: BucketsChannel;
  axis: BucketAxis;
  taken: readonly { name: string }[];
  onAdded: (buckets: readonly SettingsBucket[]) => void;
}) {
  const nameId = useId();
  const quotaId = useId();
  const [name, setName] = useState("");
  const [quota, setQuota] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const trimmed = name.trim();
  const duplicate = trimmed !== "" && bucketNameTaken(trimmed, taken);
  const label = AXIS_LABEL[axis].toLowerCase();
  const refused = error ?? (duplicate ? duplicateSentence(axis, trimmed) : null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (trimmed === "" || duplicate || busy) return;
    const parsedQuota = parseQuotaInput(quota);
    if (!parsedQuota.ok) {
      setError(parsedQuota.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await addBucket({
        channelId: channel.id,
        axis,
        name: trimmed,
        monthlyQuota: parsedQuota.value,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onAdded(result.buckets);
      setName("");
      setQuota("");
      input.current?.focus();
    } catch {
      setError("Could not reach the server, so nothing was added. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      // The browser's own constraint validation would stop a quota of 0 at
      // the `min` with a tooltip and no submit; the refusal is this form's,
      // in a sentence, so the native one is off.
      noValidate
      data-testid={`add-bucket-${axis}`}
      className="flex flex-col gap-2 rounded-card border border-dashed border-border px-4 py-3"
    >
      <label htmlFor={nameId} className="text-[13px] font-medium">
        Add a {label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={nameId}
          ref={input}
          data-testid="add-bucket-name"
          value={name}
          maxLength={BUCKET_NAME_MAX}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          placeholder={axis === "vertical" ? "e.g. productivity" : "e.g. tier list"}
          className="min-w-0 flex-1 rounded-input border border-border bg-background px-3 py-2 text-[13px] outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent"
        />
        <div className="flex items-center gap-1.5">
          <label htmlFor={quotaId} className="text-[12px] text-muted">
            quota
          </label>
          <input
            id={quotaId}
            data-testid="add-bucket-quota"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_QUOTA}
            step={1}
            value={quota}
            placeholder="—"
            onChange={(event) => {
              setQuota(event.target.value);
              setError(null);
            }}
            className="w-16 rounded-input border border-border bg-background px-2 py-2 text-right font-mono text-[12px] outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent"
          />
          <span className="text-[12px] text-muted">a month</span>
        </div>
        <button
          type="submit"
          data-testid="add-bucket-submit"
          disabled={busy || trimmed === "" || duplicate}
          className="shrink-0 rounded-button border border-border px-3 py-2 text-[13px] font-medium outline-none enabled:hover:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
        >
          {busy ? "Adding…" : `Add ${label}`}
        </button>
      </div>
      {refused ? (
        <Refusal testId="add-bucket-status" message={refused} />
      ) : (
        <p data-testid="add-bucket-status" className="text-[12px] leading-5 text-muted">
          It goes at the end of the {axis === "vertical" ? "rows" : "columns"} and is on
          the matrix and in the pickers at once. A quota is optional: leave it empty for a
          count with no target.
        </p>
      )}
    </form>
  );
}
