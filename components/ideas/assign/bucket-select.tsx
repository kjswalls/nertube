"use client";

import { useId } from "react";

import { AXIS_LABEL, UNFILED, type BucketAxis, type BucketOption } from "@/lib/buckets";

/**
 * One axis of the bucket picker: a native `<select>` holding one of this
 * channel's buckets on that axis, or nothing.
 *
 * ## Why a select, and why one per axis
 *
 * The task this control has is not "let the user choose a bucket" — it is
 * **make an invalid choice unrepresentable**. There are three ways a bucket
 * assignment can be wrong, and the control answers all three by construction:
 *
 * 1. *Two verticals at once.* A `<select>` without `multiple` holds one value.
 *    (`videos.vertical_id` is one column, so the database agrees.)
 * 2. *A bucket from another channel.* The options are a list the server built
 *    from one `channel_id`; nothing on this side can widen it.
 * 3. *A horizontal in the vertical slot.* There are two controls, each given
 *    one axis's options — `BucketChoices` is two lists precisely so a caller
 *    cannot hand this one a list it did not filter.
 *
 * The composite foreign key in `0001_init.sql` enforces all three anyway. That
 * is the point of doing it this way round: the guarantee is in the database, and
 * the picker's job is to make sure the person never runs into it.
 *
 * No combobox, no chips-with-a-menu. A native select is one tab stop, opens
 * with the keyboard, types-to-find, uses the platform's own picker on a phone,
 * and needs no library — and this build's dependency ceiling has no room for
 * one, nor any reason to want one for a list of three to twelve words.
 *
 * ## An axis with no buckets
 *
 * `lib/defaults.ts` seeds the eight formats from BRIEF.md and leaves the topic
 * pillars **empty on purpose**, so a new channel's vertical picker has nothing
 * to offer on the first day. It says so, in place, rather than rendering an
 * empty menu that looks broken: an empty list is the normal state of a new
 * channel, not a failure.
 */
export function BucketSelect({
  axis,
  options,
  value,
  onChange,
  name,
  disabled = false,
  testId,
  describedBy,
}: {
  axis: BucketAxis;
  options: readonly BucketOption[];
  /** The bucket's id, or `""` for not filed. */
  value?: string;
  /** Absent makes this an uncontrolled field — the shape a plain form posts. */
  onChange?: (next: string) => void;
  /** The form field name, when the control is part of a posted form. */
  name?: string;
  disabled?: boolean;
  testId?: string;
  describedBy?: string;
}) {
  const id = useId();
  const emptyId = `${id}-empty`;
  const empty = options.length === 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {AXIS_LABEL[axis]}
      </label>

      <select
        id={id}
        name={name}
        data-testid={testId}
        data-axis={axis}
        value={onChange ? (value ?? "") : undefined}
        defaultValue={onChange ? undefined : value}
        disabled={disabled || empty}
        onChange={(event) => onChange?.(event.target.value)}
        aria-describedby={
          [describedBy, empty ? emptyId : null].filter(Boolean).join(" ") ||
          undefined
        }
        className="w-full rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 thumb:min-h-11"
      >
        {/* Always first, always available: unfiling is as ordinary a decision
            as filing, and a picker you cannot back out of is one people stop
            using. */}
        <option value="">{UNFILED}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>

      {empty ? (
        <p id={emptyId} className="text-xs text-muted">
          {axis === "vertical"
            ? "No topic pillars yet — a new channel picks its own three to five."
            : "No formats on this channel yet."}
        </p>
      ) : null}
    </div>
  );
}
