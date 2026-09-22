"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import type { AssistMeta } from "@/lib/assist/types";

import { describeMeta } from "./acceptance";
import type { AssistFailureView, AssistNotice } from "./run";

/**
 * How every assist control in the app looks while it works, when it fails, and
 * when it has just done something.
 *
 * ## Why this is one file rather than one per panel
 *
 * M8's brief: *every pill should behave the same way — the same in-flight
 * treatment, the same error sentences, the same accept gesture, the same
 * keyboard path. A person who learns one has learned all of them.* Four
 * controls on three screens cannot learn that from a convention; they learn it
 * by rendering the same components. So the waiting row with its measured
 * seconds and its Cancel, the failure block with its retry, the notice line and
 * the "this is a proposal" frame are here, and the panels are what is left over
 * once those are taken out: the question, the answer, and what accepting means.
 *
 * ## The one boundary this file is really about
 *
 * The design rule signed off with the user is that generated text is *not* the
 * user's writing and the design must never let the two blur. Until it is
 * accepted a suggestion is drawn as the tool talking — a dashed frame, a quiet
 * surface, a "Proposal" chip, never the Newsreader face the person's own
 * writing is set in. The moment it is accepted it becomes an ordinary value in
 * an ordinary field and looks like everything else they wrote. {@link Proposal}
 * is that line, drawn in one place so it cannot be drawn differently twice.
 *
 * ## Why every element takes a `prefix`
 *
 * The test ids are `${prefix}-pending`, `${prefix}-failure` and so on. The
 * packaging panel shipped first, with `brainstorm-*` ids its suite already
 * asserts on; the controls added since use `assist-*`. Renaming the first set
 * would have meant editing another agent's spec while it was still being
 * written, which is how two half-landed slices become one broken one. The
 * prefix is the seam that let the markup converge without the ids having to.
 */

/* -------------------------------------------------------------------------- */
/* Waiting                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The in-flight row: what is happening, how long it has been happening, and a
 * way to stop waiting.
 *
 * The elapsed counter is a measured claim rather than a spinner. A model call
 * is the only part of this app that can take forty seconds, and the difference
 * between "12s" and a spinning circle is the difference between a person who
 * waits and a person who reloads the page.
 */
export function AssistPending({
  prefix,
  startedAt,
  what,
  onCancel,
}: {
  prefix: string;
  /** When the ask started; the counter is a subtraction from it. */
  startedAt: number | null;
  /** What is being waited for, in a sentence. */
  what: string;
  onCancel: () => void;
}) {
  /*
    The clock, ticked by an interval and subtracted during render.

    Keeping *now* in state rather than the elapsed seconds is what keeps the
    effect to a subscription: it starts a timer and stops it, and never sets
    state in its own body (`react-hooks/set-state-in-effect`, which is a lint
    error in this repo and a cascading render in principle). This component is
    mounted only while something is in flight, so mount time is the start.
  */
  const [now, setNow] = useState(() => Date.now());
  const elapsed =
    startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));

  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);

  return (
    <div
      data-testid={`${prefix}-pending`}
      role="status"
      className="flex flex-wrap items-center gap-3 rounded-input border border-dashed border-border px-3 py-2 text-xs"
    >
      <span>{what}</span>
      <span data-testid={`${prefix}-elapsed`} className="font-mono text-muted">
        {elapsed}s
      </span>
      <button
        type="button"
        data-testid={`${prefix}-cancel`}
        onClick={onCancel}
        className="rounded-button border border-border px-2 py-1 text-xs outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-accent"
      >
        Cancel
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Failing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every failure, as a sentence and an offer.
 *
 * Three things are always true here and are the reason this is a component
 * rather than a paragraph at each call site:
 *
 * - **The sentence comes from the module.** `lib/assist/types.ts` writes one
 *   per {@link AssistFailureView.code}; nothing here maps codes to prose, so a
 *   new failure mode cannot arrive with no words for it.
 * - **"Nothing was changed" is said out loud.** The question a person actually
 *   has when a model call fails is whether it half-happened.
 * - **A refusal offers "Try anyway", not "Try again".** The module marks
 *   `refused` as not retryable — the same prompt is declined the same way — but
 *   the button stays, because the person may have just edited the notes it was
 *   built from.
 */
export function AssistFailure({
  prefix,
  failure,
  onRetry,
  disabled = false,
}: {
  prefix: string;
  failure: AssistFailureView;
  onRetry: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      data-testid={`${prefix}-failure`}
      data-code={failure.code}
      role="alert"
      className="flex flex-col gap-2 rounded-input border border-attention/50 bg-attention/[0.06] px-3 py-2"
    >
      <p data-testid={`${prefix}-failure-message`} className="text-xs">
        {failure.message}
      </p>
      <p className="text-xs text-muted">
        Nothing was changed, and nothing was added to your fields.
        {failure.retryAfterSeconds
          ? ` The API asked for ${failure.retryAfterSeconds} seconds.`
          : ""}
      </p>
      <div>
        <button
          type="button"
          data-testid={`${prefix}-retry`}
          onClick={onRetry}
          disabled={disabled}
          className="rounded-button border border-border bg-background px-2 py-1 text-xs font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
        >
          {failure.retryable ? "Try again" : "Try anyway"}
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Saying what happened                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The line under the panel: what accepting just did, or what cancelling left
 * behind.
 *
 * `role="status"` rather than `alert`, because none of it is an error and an
 * assertive interruption after every accepted suggestion would make the panel
 * unusable with a screen reader open.
 *
 * The undo control is part of the notice on purpose. The one assist that
 * *replaces* rather than adds — a thumbnail concept, which is a single field —
 * would otherwise be a click that silently overwrites something the person
 * wrote, and an undo two lines below the button that caused it is the shortest
 * distance between the mistake and the fix.
 */
export function AssistNoticeLine({
  prefix,
  notice,
}: {
  prefix: string;
  notice: AssistNotice;
}) {
  return (
    <p
      data-testid={`${prefix}-notice`}
      role="status"
      className="flex flex-wrap items-center gap-2 text-xs text-muted"
    >
      <span>{notice.text}</span>
      {notice.undo ? (
        <button
          type="button"
          data-testid={`${prefix}-undo`}
          onClick={notice.undo}
          className="rounded-button border border-border px-2 py-0.5 text-xs text-foreground outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"
        >
          {notice.undoLabel ?? "Undo"}
        </button>
      ) : null}
    </p>
  );
}

/**
 * The clamp line, when there is one.
 *
 * PLAN.md's M8 review item is that a 21-title answer is *clamped, not
 * discarded* — and a clamp nobody is told about is indistinguishable from a
 * model that answered short. `lib/assist/clamp.ts` counts what it dropped and
 * `describeMeta` in `./acceptance.ts` turns those counts into a sentence; this
 * renders it, and there is deliberately no second copy of that wording here.
 * Nothing at all in the normal case, which deserves no line.
 */
export function AssistMetaLine({
  prefix,
  meta,
}: {
  prefix: string;
  meta: AssistMeta | null;
}) {
  const line = describeMeta(meta);
  if (line === null) return null;
  return (
    <p data-testid={`${prefix}-meta`} className="text-xs text-muted">
      {line}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* The line between a proposal and your writing                                */
/* -------------------------------------------------------------------------- */

/**
 * One proposal, drawn as the tool talking.
 *
 * Dashed border, quiet surface, a chip that says what it is. The accepted
 * version of the same text — in the candidate list, in the hooks, in the
 * concept box — carries none of this: it is a field the person owns, set like
 * everything else they wrote. That contrast is the whole design rule, and it
 * only works if the proposal side is drawn identically everywhere, which is
 * what this component is for.
 */
export function Proposal({
  testId = "assist-proposal",
  chip = "Proposal",
  picked = false,
  pickedLabel = "Its pick",
  pickedTestId = "assist-pick-badge",
  badge,
  children,
  ...data
}: {
  testId?: string;
  /** The chip in the corner: what kind of proposal this is. */
  chip?: string;
  /** The model's own recommendation, marked. */
  picked?: boolean;
  pickedLabel?: string;
  /** The pick badge's test id, for the panel whose suite named it first. */
  pickedTestId?: string;
  /** Whatever else belongs on the chip row — the text itself, a role name. */
  badge?: ReactNode;
  children: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <li
      data-testid={testId}
      data-recommended={picked ? "true" : "false"}
      {...data}
      className={[
        "flex flex-col gap-1 rounded-input border border-dashed px-3 py-2",
        picked ? "border-accent bg-accent/[0.06]" : "border-border bg-background/40",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-button border border-border px-1 text-[10px] uppercase tracking-wide text-muted">
          {chip}
        </span>
        {picked ? (
          <span
            data-testid={pickedTestId}
            className="rounded-button border border-accent px-1 text-[10px] uppercase tracking-wide text-accent"
          >
            {pickedLabel}
          </span>
        ) : null}
        {badge}
      </div>
      {children}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* The panel itself                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Where focus goes when a pill opens a panel.
 *
 * The pill is often far from what it opens — the critique pill is above three
 * thumbnail slots — so a panel that appears without taking focus is a panel a
 * keyboard user has to hunt for. The heading is made programmatically focusable
 * and takes it, which also announces what just opened. `nonce` moves on every
 * press, so pressing the pill again re-aims focus at a panel that is already
 * open rather than doing nothing.
 */
export function useAssistFocus<T extends HTMLElement>(
  /** Anything that changes when focus should move again: a count, a key. */
  nonce: number | string,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [nonce]);
  return ref;
}

/**
 * The panel shell: an inline region, not a dialog.
 *
 * PLAN.md budgets up to forty seconds for a model call, and a modal over the
 * page for forty seconds is a page you cannot use (BRIEF.md principle 6:
 * friction is the failure mode). So every assist panel in this app is inline,
 * the rest of the screen keeps working while it thinks, and Escape closes it
 * from anywhere inside.
 *
 * Escape's `stopPropagation` matters: `lib/shortcuts.ts` keeps a single
 * `keydown` listener on `document`, and without this an Escape meant for the
 * panel would also reach whatever else is listening.
 */
export function AssistPanel({
  testId,
  labelledBy,
  onClose,
  children,
  ...data
}: {
  testId: string;
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <section
      data-testid={testId}
      {...data}
      aria-labelledby={labelledBy}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      className="flex w-full flex-col gap-3 rounded-card border border-accent/40 bg-surface/50 p-4"
    >
      {children}
    </section>
  );
}

/**
 * The pill itself: one control, one look, four call sites.
 *
 * `components/preview/assist-pill.tsx` is the inert version M2 placed and left
 * disabled on purpose, with a doc comment explaining that *where the button is*
 * is a layout decision worth making early and that shipping a listener for a
 * button nobody can press would be shipping the illusion of a feature. This is
 * the other half of that comment: same size, same border, same place, now with
 * something behind it.
 */
export function AssistPillButton({
  verb,
  title,
  expanded,
  disabled = false,
  badge,
  onClick,
}: {
  /** The verb on the pill: "Suggest concepts", "Critique at tile size". */
  verb: string;
  /** What it will do, in a sentence, for the tooltip. */
  title: string;
  /** Whether the panel it opens is open. */
  expanded?: boolean;
  disabled?: boolean;
  /** A short mono word after the verb — "saved", "3 ready". */
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="assist-pill"
      data-assist={verb}
      aria-expanded={expanded}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-button border border-border px-2 py-1 text-xs outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
    >
      <span>{verb}</span>
      {badge ? (
        <span
          data-testid="assist-pill-badge"
          className="font-mono text-[11px] uppercase tracking-wide text-muted"
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}
