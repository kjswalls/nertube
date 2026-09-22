"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

/**
 * The application's one autosave pattern.
 *
 * M2 arrived with two of these: a per-field blur-saver factored out of M1's
 * title field, and a block-level queue in the packaging editor that serialised
 * whole-patch writes. They agreed about nothing — different state shapes,
 * different status elements, different answers to "what happens when two saves
 * overlap" — for two halves of the same page. This is the merged one, and it is
 * what every editable field on `/videos/[id]` goes through.
 *
 * It is two layers, because the page genuinely has two shapes of edit:
 *
 * - `useSaveQueue` — **one save on the wire at a time.** Every patch this app
 *   sends carries *absolute* values (the whole title, the whole hook list),
 *   never a delta, so two in flight is not a merge problem: it is an ordering
 *   problem. If `[c1]` and `[c1, c2]` are both sent and the slower one is the
 *   first, the row ends up holding `[c1]` and the second candidate is gone from
 *   the database while it is still on screen. So a save that arrives while one
 *   is in flight is queued, merged over anything already queued, and sent when
 *   the wire is free. What is on screen is never delayed by this; only the
 *   write is. **A failure stops the queue** rather than draining it, so an
 *   error can never be overwritten by the write behind it.
 * - `useAutosave` — **one text field, saved on blur**, built on a queue of its
 *   own. Blur and not keystroke: a title is written by typing, deleting and
 *   rewriting, and saving each keystroke would put a row of nonsense per
 *   character through `updated_at`, which the board's Idea column sorts by.
 *
 * Both keep the four properties M1 established and neither half may lose:
 *
 * 1. **Nothing is sent when nothing changed.** Tabbing through an untouched
 *    field is silent.
 * 2. **A failure never reverts what is on screen.** The editor holds the
 *    user's text; `saved` is a separate copy of what the row last confirmed.
 *    Losing an unsaved sponsor read because the wifi dropped is the one outcome
 *    this must not have.
 * 3. **A rejected promise is caught.** Uncaught, a server action's rejection is
 *    rethrown into the nearest error boundary and the whole route — including
 *    the text being edited — is replaced by an error screen.
 * 4. **Success re-reads the value from the server's answer**, so a field cannot
 *    drift from its column: whatever the action says is stored is what ends up
 *    in the box — unless something has been typed since, in which case the
 *    newer thing on screen wins, because it is what the person is looking at.
 */

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What a save is doing, and — when it failed — what would have to be re-sent.
 *
 * The payload rides along in the state rather than in a ref, so the Retry
 * button is rendered from the same value that decides whether to render it at
 * all. (A ref read during render is also a React lint error, and for the usual
 * reason: the button would not appear until something else re-rendered.)
 */
export type SaveState<Payload = unknown> =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | {
      kind: "error";
      message: string;
      payload: Payload;
      /** The row moved under us; a retry would only overwrite the newer values. */
      conflict?: boolean;
    };

/**
 * What a `save` handed to `useSaveQueue` must answer with.
 *
 * The queue itself only needs to know whether the write landed and, if not,
 * what to say — it never looks at the stored value. (It used to carry one, in a
 * `Value` generic that two of the three call sites constructed for nobody.)
 *
 * `conflict` marks the one failure that retrying cannot fix: the row was
 * changed somewhere else, so what is on screen was computed against a version
 * of it that no longer exists. The status line offers a reload rather than a
 * retry for those.
 */
export type SaveResult<Patch = never> =
  | { ok: true }
  | {
      ok: false;
      error: string;
      conflict?: boolean;
      /**
       * The part of the patch that did not land, when a save is a *sequence*
       * and the first part of it did.
       *
       * The template editor sends a batch of operations and applies them one
       * at a time; when the third fails, the first two are already in the
       * table. A Retry that re-sent the whole batch inserted the landed add a
       * second time and swapped the landed move back (M7's review). When a
       * `save` reports `unsent`, the queue's Retry payload is that — plus
       * whatever was parked behind it — and never the whole patch.
       */
      unsent?: Patch;
    };

/**
 * What a *field's* save answers with.
 *
 * `value` is what the server stored, which is not always what was sent — an
 * emptied box becomes NULL, which comes back as `""`. Only `useAutosave` reads
 * it; the queue underneath does not.
 */
export type SaveOutcome<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: string; conflict?: boolean };

/** Said when the action never reached the server, or its answer never came back. */
const UNREACHABLE =
  "Could not reach the server, so this is not saved. Nothing you typed has been lost — try again.";

/* -------------------------------------------------------------------------- */
/* The queue                                                                   */
/* -------------------------------------------------------------------------- */

export interface SaveQueue<Patch> {
  readonly state: SaveState<Patch>;
  /** `state.kind === "saving"`, for the controls that grey out while it is. */
  readonly pending: boolean;
  /** Send this patch, or queue it if the wire is busy. */
  readonly send: (patch: Patch) => void;
  /** Typing resumed: clear a stale "Saved" or failure line. Stable. */
  readonly touch: () => void;
  /**
   * Everything that has been *sent* and not yet settled — the in-flight patch
   * merged with anything queued behind it — or `null` when the wire is idle.
   *
   * This is the baseline an editor must diff against, and getting it wrong was
   * the one way this page could lose a change with no error and no trace. Diff
   * against the last value the server *confirmed* and an edit that returns a
   * field to that value while a save carrying a different one is still on the
   * wire produces an empty diff: nothing is queued, the in-flight write lands,
   * and the row keeps the value the user just undid — under a status line
   * reading "Saved". Diffing against what has been sent makes that edit a real
   * patch, which the queue then merges and sends in order.
   *
   * A failed patch is *not* pending: the row never took it, so the baseline
   * drops back to what the server confirmed and the next blur retries.
   *
   * A function rather than a value because it is read inside event handlers,
   * where a value captured at render time would be one event stale, and because
   * nothing renders from it.
   */
  readonly peekPending: () => Patch | null;
}

/** Later values win, key by key — which is exactly right for absolute values. */
function mergePatches<Patch>(queued: Patch, next: Patch): Patch {
  return { ...queued, ...next };
}

export function useSaveQueue<Patch>({
  save,
  merge = mergePatches,
  onFailure,
}: {
  save: (patch: Patch) => Promise<SaveResult<Patch>>;
  /**
   * How a patch that arrives while one is in flight folds into whatever is
   * already queued. The default is an object merge; a field whose patch *is*
   * its value passes `(_, next) => next`.
   */
  merge?: (queued: Patch, next: Patch) => Patch;
  /**
   * A write failed, and this is whatever was queued behind it — `null` when
   * nothing was — and, second, the whole payload the Retry will carry (the
   * unsent part of the failed patch merged with the parked one).
   *
   * The queue **parks** that work rather than sending it (see the note in
   * `send`), so a caller that already applied it optimistically has to be told,
   * and this is where it puts the screen back — or, for a caller that keeps
   * the failed work on screen, where it learns exactly what is still unsent.
   * Called once per failure, before the error state lands, so the rollback and
   * the message are one batch.
   */
  onFailure?: (parked: Patch | null, payload: Patch) => void;
}): SaveQueue<Patch> {
  const [state, setState] = useState<SaveState<Patch>>({ kind: "idle" });
  const [, startTransition] = useTransition();

  const inFlight = useRef(false);
  /** Boxed, so "a queued patch that happens to be an empty string" is not `null`. */
  const queued = useRef<{ patch: Patch } | null>(null);
  /** The patch currently on the wire, boxed for the same reason. */
  const sent = useRef<{ patch: Patch } | null>(null);

  // The callers' functions close over their own props and are rebuilt every
  // render. Held in refs so `send` can stay stable — a stale closure here would
  // write last render's value — and written in an effect rather than during
  // render, because a ref assignment in a render body runs on a render React
  // may throw away. Effects are flushed before the next user event, so a blur
  // always sees the saver its own render built.
  const saveRef = useRef(save);
  const mergeRef = useRef(merge);
  const onFailureRef = useRef(onFailure);
  useEffect(() => {
    saveRef.current = save;
    mergeRef.current = merge;
    onFailureRef.current = onFailure;
  });

  /** `send` calling itself, without a self-referencing `useCallback`. */
  const sendRef = useRef<((patch: Patch) => void) | null>(null);

  const send = useCallback((patch: Patch) => {
    if (inFlight.current) {
      queued.current = {
        patch: queued.current
          ? mergeRef.current(queued.current.patch, patch)
          : patch,
      };
      return;
    }

    inFlight.current = true;
    sent.current = { patch };
    setState({ kind: "saving" });

    startTransition(async () => {
      let result: SaveResult<Patch>;
      try {
        result = await saveRef.current(patch);
      } catch {
        result = { ok: false, error: UNREACHABLE };
      }

      inFlight.current = false;
      // Cleared whether it landed or not. On success the row now holds it, so
      // the confirmed baseline has caught up; on failure the row never took
      // it, so the baseline must fall back rather than pretend it did.
      sent.current = null;

      if (result.ok) {
        setState({ kind: "saved" });
        const next = queued.current;
        queued.current = null;
        if (next) sendRef.current?.(next.patch);
        return;
      }

      /*
        A failure **stops** the queue. It used to drain it, and that was a way
        to lose a write under a "Saved" line: the error state and the follow-up
        `{kind:"saving"}` landed in the same React batch, so the failure was
        never rendered at all, and the batch behind it then succeeded and wrote
        "Saved". A caller that had already rolled its change back was left with
        no message, no Retry and no trace of it.

        So whatever was queued is *parked*: merged into the payload the error
        carries, so one Retry replays both, and handed to `onFailure`, so a
        caller that applied it optimistically can put the screen back for work
        that is now never going to be sent.
      */
      const parked = queued.current;
      queued.current = null;
      // What did not land: the whole patch unless the save says otherwise.
      const failed = result.unsent === undefined ? patch : result.unsent;
      const payload = parked ? mergeRef.current(failed, parked.patch) : failed;

      onFailureRef.current?.(parked ? parked.patch : null, payload);
      setState({
        kind: "error",
        message: result.error,
        payload,
        conflict: result.conflict,
      });
    });
  }, []);

  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  const touch = useCallback(() => {
    // "saving" is left alone: a save really is in flight, and hiding the line
    // because a key was pressed would be a lie about the wire.
    setState((current) =>
      current.kind === "saved" || current.kind === "error"
        ? { kind: "idle" }
        : current,
    );
  }, []);

  const peekPending = useCallback((): Patch | null => {
    const onWire = sent.current;
    const waiting = queued.current;
    if (onWire && waiting) {
      return mergeRef.current(onWire.patch, waiting.patch);
    }
    if (onWire) return onWire.patch;
    return waiting ? waiting.patch : null;
  }, []);

  return useMemo(
    () => ({
      state,
      pending: state.kind === "saving",
      send,
      touch,
      peekPending,
    }),
    [peekPending, send, state, touch],
  );
}

/* -------------------------------------------------------------------------- */
/* One field                                                                   */
/* -------------------------------------------------------------------------- */

export interface Autosave {
  readonly value: string;
  /** Type into the field. Clears any stale "Saved"/failure line. */
  readonly setValue: (next: string) => void;
  /**
   * Save, if there is anything to save. Call from `onBlur` — and from
   * `onChange` for a control whose whole interaction is one click (a date
   * picker, a select): it is a no-op when the value already matches the server.
   */
  readonly commit: () => void;
  readonly state: SaveState<string>;
  readonly pending: boolean;
}

export function useAutosave({
  initial,
  save,
}: {
  initial: string;
  save: (next: string) => Promise<SaveOutcome<string>>;
}): Autosave {
  const [value, setValueState] = useState(initial);
  /**
   * The current value, outside React state.
   *
   * `commit` is called from a blur handler and must read what is in the box
   * *now*; read from state it would close over whatever the last render saw,
   * which on a fast "type, Tab" is the string one keystroke ago. It cannot be
   * done inside a state updater either — that function has to be pure, and
   * React may call it twice, which would send the save twice.
   */
  const valueRef = useRef(initial);
  /** What the server last confirmed. The baseline "has anything changed" reads. */
  const savedRef = useRef(initial);

  const { state, send, touch, peekPending } = useSaveQueue<string>({
    // A field's patch *is* its value, so a queued save is simply replaced.
    merge: (_queued, next) => next,
    save: async (next) => {
      const result = await save(next);
      if (result.ok) {
        savedRef.current = result.value;
        // Adopt the server's normalisation only if nothing has been typed
        // since; otherwise what is on screen is newer and wins.
        if (valueRef.current === next) {
          valueRef.current = result.value;
          setValueState(result.value);
        }
        return { ok: true };
      }
      // On a refusal the baseline is deliberately left alone, so the next blur
      // tries again rather than deciding nothing has changed.
      return { ok: false, error: result.error, conflict: result.conflict };
    },
  });

  const setValue = useCallback(
    (next: string) => {
      valueRef.current = next;
      setValueState(next);
      touch();
    },
    [touch],
  );

  /**
   * Has something been typed that the row does not hold?
   *
   * The *raw* value against what the server confirmed (or what is on the
   * wire), not the trimmed one `commit` sends: a box showing a stored value
   * with a trailing newline is not dirty because trimming it would change
   * it, and a guard that thought so would re-save every untouched text on
   * every navigation away.
   */
  const isDirty = useCallback((): boolean => {
    const pendingValue = peekPending();
    return valueRef.current !== (pendingValue === null ? savedRef.current : pendingValue);
  }, [peekPending]);

  const commit = useCallback(() => {
    const next = valueRef.current.trim();
    if (next !== valueRef.current) {
      valueRef.current = next;
      setValueState(next);
    }
    /*
      The baseline is what has been *sent*, not what has been confirmed.

      While a save is in flight the confirmed value is one round trip out of
      date, so "type X, blur, change your mind, type the old value back, blur"
      diffed against it comes out empty — nothing is queued, X lands, and the
      row keeps a value the user deliberately undid while the line says
      "Saved". `peekPending()` is the value on the wire (merged with anything
      queued behind it) and drops back to `savedRef` the moment the wire
      settles, including after a failure.
    */
    const pendingValue = peekPending();
    const baseline = pendingValue === null ? savedRef.current : pendingValue;
    if (next === baseline) return;
    send(next);
  }, [peekPending, send]);

  /*
    Save on blur is the rule (PLAN.md), and a blur is what an in-app link
    click, a Tab-and-Enter and a section switch all cause. Two ways of leaving
    do not blur anything: the browser's Back button, which is a client-side
    popstate that unmounts this component with the text still in the box, and
    a reload or a closed tab, which unmount nothing. M7's review typed a page
    of voice guide and pressed Back, and it was gone with no warning.

    So, two guards on the one save queue, and therefore on every field:

    1. **Unmount commits.** The cleanup below runs on a client-side navigation
       away from the page; the action is sent before the component is gone,
       and the screen it lands on is not this one, so no state is set.
    2. **Unload asks.** While the box is dirty or a save is on the wire, a
       `beforeunload` handler makes the browser confirm a reload or a close —
       the standard "changes may not be saved" dialog — and sends the save
       first, so a person who then chooses to stay has already been saved.
       The dialog is the browser's, not the app's: it is the one dialog the
       app cannot draw, and its timing is the one moment `components/modal.tsx`
       could not be shown.
  */
  const commitRef = useRef(commit);
  const isDirtyRef = useRef(isDirty);
  useEffect(() => {
    commitRef.current = commit;
    isDirtyRef.current = isDirty;
  });

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!isDirtyRef.current() && peekPending() === null) return;
      commitRef.current();
      event.preventDefault();
      // Chromium ignores preventDefault alone; the legacy property is what
      // makes it ask.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (isDirtyRef.current()) commitRef.current();
    };
  }, [peekPending]);

  return { value, setValue, commit, state, pending: state.kind === "saving" };
}

/* -------------------------------------------------------------------------- */
/* The status line                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The one saved/saving/failed line.
 *
 * `role="status"` while things are going well — a save nobody asked to be
 * interrupted about — and `role="alert"` when one failed, because that is the
 * case where something the user typed is not where they think it is.
 *
 * `onRetry` exists for the saves that have no natural second chance. A failed
 * title save is retried by blurring the field again; a failed "remove this
 * hook" has no gesture to repeat, and the change is sitting in the editor
 * unsaved. Retry re-sends exactly the payload that failed.
 */
export function SaveStatus<Payload>({
  state,
  testId,
  idle = "",
  onRetry,
  id,
}: {
  state: SaveState<Payload>;
  testId: string;
  /** Shown when there is nothing to report; usually a hint about the field. */
  idle?: string;
  onRetry?: (payload: Payload) => void;
  /**
   * So a field can point at this line with `aria-describedby` when it is the
   * reason the field is `aria-invalid`: the alert is announced once when it
   * appears, and the association is how a screen reader re-reads it on
   * returning to the box.
   */
  id?: string;
}) {
  const failed = state.kind === "error";
  const conflict = state.kind === "error" && state.conflict === true;

  /*
    The live region holds the *save state* and nothing else.

    `idle` is a permanent hint about the field ("Plain text. Markdown is stored
    as written…"), and it used to be rendered inside the same `role="status"`
    element. `touch()` returns the state to idle on the first keystroke after a
    save, which put the hint back into a live region — so resuming typing
    announced the help paragraph. The hint is now a sibling of the live region
    rather than its content: still in the same paragraph visually, still read in
    document order, no longer something that gets spoken because a key was
    pressed.
  */
  return (
    <p
      id={id}
      data-testid={testId}
      data-state={state.kind}
      className={[
        "flex min-h-4 flex-wrap items-center gap-2 text-xs",
        failed ? "text-attention" : "text-muted",
      ].join(" ")}
    >
      <span role={failed ? "alert" : "status"}>
        {state.kind === "saving"
          ? "Saving…"
          : state.kind === "saved"
            ? "Saved"
            : state.kind === "error"
              ? state.message
              : ""}
      </span>

      {state.kind === "idle" && idle !== "" ? <span>{idle}</span> : null}

      {state.kind === "error" && conflict ? (
        // A retry would re-send exactly the patch the row has already moved
        // past, so the only honest offer is to go and look at what it holds now.
        <button
          type="button"
          data-testid={`${testId}-reload`}
          onClick={() => window.location.reload()}
          className="rounded-button border border-border px-2 py-0.5 font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"
        >
          Reload
        </button>
      ) : state.kind === "error" && onRetry ? (
        <button
          type="button"
          data-testid={`${testId}-retry`}
          onClick={() => onRetry(state.payload)}
          className="rounded-button border border-border px-2 py-0.5 font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"
        >
          Retry
        </button>
      ) : null}
    </p>
  );
}
