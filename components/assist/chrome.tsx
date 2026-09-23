"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { formatAge } from "@/components/video-detail/age";
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
          ? ` It asked for ${failure.retryAfterSeconds} seconds before another try.`
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
  marksFallback = true,
}: {
  prefix: string;
  meta: AssistMeta | null;
  /**
   * Whether this panel marks a fallback when the model's own pick is dropped.
   *
   * The ranked-list panels do — the list is still in order, so the first
   * survivor is an honest substitute and gets the badge. The critique does
   * not: "would ship" is a claim about a specific image, and the one thing it
   * must never do is land on an image the same answer just called illegible.
   * One sentence per case, so neither panel describes the other's behaviour.
   */
  marksFallback?: boolean;
}) {
  const line = describeMeta(meta, marksFallback);
  if (line === null) return null;
  return (
    <p data-testid={`${prefix}-meta`} className="text-xs text-muted">
      {line}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Where the answer came from                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The line under a panel's heading: when this was asked for, what it was
 * written against, and — the part that matters most — *who answered*.
 *
 * ## Why it says when a fixture answered
 *
 * `ASSIST_PROVIDER=fake` selects `lib/assist/fake.ts`, which returns plausible
 * titles with plausible reasons and no network at all. That is what makes this
 * feature testable forever and runnable in a container with no key, and it is
 * also the one failure in this app nobody can notice from the outside: fixtures
 * read exactly like an answer. A person who believed a model wrote these would
 * be wrong about the only thing the panel is for. So whenever the answer came
 * from the fixtures the panel says so, in as many words, every time — and the
 * sentence names the variable, because the fix is one line of environment.
 *
 * ## Why it does not name the environment variable
 *
 * PLAN.md's review item for M8 is that the key never reaches the client
 * bundle, checked by grepping the build output for `ANTHROPIC_API_KEY`,
 * `api.anthropic.com` and `x-api-key`. This file is a client component, so a
 * sentence here spelling that variable puts the string into `.next/static` —
 * harmless in itself (it is the name, never a value) and *fatal to the gate*,
 * which stops being "finds nothing" and becomes "finds one thing somebody has
 * to re-examine on every build". A gate with a known-benign hit is a gate
 * people learn to ignore. The sentence points at the README instead.
 *
 * Since the review, no *rendered* sentence anywhere names it. This comment
 * used to say `not_configured` and `unauthorized` in `lib/assist/types.ts`
 * did, which was half true — `not_configured` never had — and the half that
 * was true contradicted this milestone's own recorded decision by putting an
 * infrastructure variable in front of whoever happened to be using the app.
 * Both sentences are neutral now, and the variable's name lives only in
 * `AssistError.detail`, which is written on the server, logged there, and
 * never sent anywhere a person can read it.
 *
 * ## Why it is one component
 *
 * Both text panels used to compute this sentence themselves, from the same
 * fields, in two copies that happened to agree. A claim about provenance is
 * exactly the kind of thing that must not be able to disagree with itself.
 */
export function AssistProvenance({
  prefix,
  entry,
  pending,
  fresh,
  now,
}: {
  prefix: string;
  /** The answer on screen, or null when nothing has been asked for yet. */
  entry: {
    readonly at: string;
    readonly provider: string;
    readonly voiceGuide: boolean;
  } | null;
  pending: boolean;
  /** Asked for in this sitting, rather than read back out of the column. */
  fresh: boolean;
  /** The clock, read when the panel was opened. Never during render. */
  now: number;
}) {
  const voice = entry?.voiceGuide
    ? fresh
      ? "Written against this channel’s voice guide."
      : "It used the voice guide as it was then."
    : fresh
      ? "This channel has no voice guide, so this is generic advice — write one in settings and ask again."
      : "It was written without a voice guide.";

  return (
    <>
      <p data-testid={`${prefix}-provenance`} className="text-xs text-muted">
        {pending
          ? "Asking now…"
          : entry === null
            ? "Nothing asked for yet."
            : fresh
              ? `Fresh, just now. ${voice}`
              : `From earlier — asked for ${formatAge(entry.at, now) ?? "a while"} ago and kept, so reopening costs nothing. ${voice}`}
      </p>
      <AssistFixtureNotice prefix={prefix} provider={entry?.provider ?? null} />
    </>
  );
}

/**
 * "A fixture answered this", said out loud.
 *
 * Its own component because the thumbnail critique cannot use
 * {@link AssistProvenance}: its answer is deliberately never stored, so it has
 * no `at` to age and nothing to call "from earlier", and its line is about the
 * images rather than the voice guide. What it *does* share is the one sentence
 * that must never be missing from any of them — a panel that quietly showed
 * fixtures would be the only lie this app is capable of telling.
 *
 * `provider` comes from the stored entry for the text assists and from
 * `meta.provider` for the critique; either way it is what `lib/assist`
 * reported, not a guess from the environment.
 */
export function AssistFixtureNotice({
  prefix,
  provider,
  variant = "answer",
}: {
  prefix: string;
  /** `"fake"`, `"anthropic"`, or null when nothing has been asked for yet. */
  provider: string | null;
  /**
   * Whether this sits under an answer or under a failure.
   *
   * The failure case is the one the review found still open, and it is the
   * worse of the two. `lib/assist/fake.ts` can refuse, rate-limit and time
   * out; the sentence a refusal shows reads as a judgement about the notes
   * somebody just wrote, and on a keyless deployment no model had seen them.
   * The notice was rendered from the stored *entry*, which on a failure is
   * null, so it said nothing exactly where it mattered most.
   */
  variant?: "answer" | "failure";
}) {
  if (provider !== "fake") return null;
  return (
    <p data-testid={`${prefix}-fixtures`} className="text-xs text-attention">
      {variant === "failure"
        ? "That failure came from this app’s built-in fixtures, not from Claude — nothing was asked of a model, and this is not a judgement about your notes."
        : "These came from this app’s built-in fixtures, not from Claude — so nothing here is a model’s opinion of your video."}{" "}
      Giving this deployment an Anthropic API key is what makes these real; the
      README says which environment variables to set.
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
 * `components/preview/assist-pill.tsx` *was* the inert version M2 placed and
 * left disabled on purpose, with a doc comment explaining that *where the
 * button is* is a layout decision worth making early and that shipping a
 * listener for a button nobody can press would be shipping the illusion of a
 * feature. M8 deleted that file and this is what replaced it — same size, same
 * border, same place, now with something behind it — so its reasoning is
 * carried here rather than at a path that no longer exists.
 */
export function AssistPillButton({
  verb,
  label,
  title,
  expanded,
  disabled = false,
  badge,
  onClick,
}: {
  /**
   * The verb on the pill: "Suggest concepts", "Critique at tile size".
   *
   * Also the control's identity — it is what `data-assist` carries, and what
   * every spec locates it by — so it names the *assist*, not the state of its
   * panel. A pill whose identity changed when it was pressed would be a
   * different control depending on whether you had pressed it.
   */
  verb: string;
  /**
   * What the pill says, when that is not the verb. Only "Generate 20" uses
   * this, to say "Hide brainstorm" while its panel is open: the panel is the
   * tallest thing on the block and its pill is the way back out. The others
   * leave it alone and let `aria-expanded` carry the state.
   */
  label?: string;
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
      <span>{label ?? verb}</span>
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
