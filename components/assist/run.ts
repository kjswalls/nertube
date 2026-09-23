"use client";

import { useCallback, useRef, useState } from "react";

import type { AssistErrorCode, AssistMeta } from "@/lib/assist/types";

/**
 * One in-flight state for every assist control in the app.
 *
 * M8's task brief is blunt about this: *if you find yourself writing a second
 * in-flight state, a second error presentation or a second accept path, stop
 * and use the existing one.* There are four pills on four different screens —
 * titles and hooks beside the packaging fields, concepts beside the written
 * thumbnail concept, a critique in the assets section — and every one of them
 * does the same four things: ask, wait visibly, fail in a sentence, and say
 * what just happened. This is that, once.
 *
 * ## What it owns, and what it deliberately does not
 *
 * It owns the *conversation*: which request is still wanted, whether one is in
 * flight, when it started, what it failed with, and the one-line notice under
 * the panel. It does not own the answer's shape — that is the `T` — and it does
 * not render anything. `components/assist/chrome.tsx` renders the three states
 * this produces, and it is the only thing that does.
 *
 * ## Why "cancel" is a client-side word — and why the answer is still kept
 *
 * A server action cannot be recalled. By the time somebody presses Cancel the
 * model is already thinking and, for the kinds that persist, the row will still
 * be written. So cancelling here means *stop waiting for this answer*: nothing
 * is dropped into a panel the person has moved on from, the notice says so in
 * as many words, and the spending carries on whatever the panel does. Closing
 * a panel does the same thing.
 *
 * What it does **not** mean any more is throwing the answer away. Cancel used
 * to move the request id and ignore the reply outright, which made its own
 * notice false in the most expensive way available: "if the answer did arrive
 * it is kept — it will be here, as from earlier, next time you open this" was
 * true of `videos.brainstorm_last` and false of this page, because the run
 * still had `data: null`, so reopening asked again and paid for a second
 * answer to a question already answered. A cancelled request is now *retained*
 * — when it lands it settles in quietly as `fresh: false`, exactly what the
 * notice promises — and `outstanding` says one is still on its way, so a panel
 * reopened in the gap waits rather than asking twice. A late **failure** after
 * a cancel is still dropped: nobody wants an alert about something they
 * already walked away from.
 *
 * ## Why asking happens in a handler and never in an effect
 *
 * A model call is slow and metered. An effect that fetches on mount fires twice
 * in development, again on every remount, and once more whenever a parent
 * re-renders in a way nobody predicted. Every ask in this app is the direct
 * consequence of somebody pressing a button.
 */

/** A failure, as the panel shows it. `lib/assist/types.ts` writes the sentence. */
export interface AssistFailureView {
  readonly code: AssistErrorCode;
  /** Already a sentence for a person: rendered as-is, never looked up. */
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  /**
   * Which implementation failed — `"fake"` when it was the fixtures.
   *
   * The failure sentences no longer name a vendor, and this is the other half
   * of that fix: a refusal that came from `lib/assist/fake.ts` reads exactly
   * like a refusal from a model, and a refusal reads as a judgement about
   * *your* notes. The panel renders the fixtures notice from this, so a
   * keyless deployment admits it on a failure as it already did on an answer.
   * `null` when the request never reached the server and there is nothing
   * honest to say about who would have answered it.
   */
  readonly provider: string | null;
}

/**
 * What just happened, in a line — an acceptance, a cancel, a replacement.
 *
 * `undo` is the reason this is an object rather than a string: accepting a
 * concept *replaces* a field the person may have written in, and a replacement
 * with no way back is a destructive click. Where there is nothing to undo the
 * notice is just its text.
 */
export interface AssistNotice {
  readonly text: string;
  readonly undo?: () => void;
  /** The label on the undo control, when there is one. */
  readonly undoLabel?: string;
}

/**
 * One attempt's outcome, as an action hands it back.
 *
 * Deliberately the same shape the assist server actions already return
 * (`app/actions/assist.ts`), so a call site maps rather than translates, and a
 * new kind of assist cannot invent a fifth way to say "it failed".
 */
export type AssistAttempt<T> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly meta: AssistMeta;
      /** False when the answer could not be stored for next time. */
      readonly persisted: boolean;
    }
  | ({ readonly ok: false } & AssistFailureView);

export interface AssistRunState<T> {
  /** The answer on screen, from this sitting or from the column. */
  readonly data: T | null;
  /** Asked for in this sitting, rather than read back out of storage. */
  readonly fresh: boolean;
  readonly meta: AssistMeta | null;
  readonly persisted: boolean;
  readonly pending: boolean;
  /** When the in-flight ask started, for the elapsed counter. */
  readonly startedAt: number | null;
  readonly failure: AssistFailureView | null;
  readonly notice: AssistNotice | null;
  /**
   * A request nobody is waiting for any more, which has not landed yet.
   *
   * Cancelled or closed, so `pending` is false and no spinner is shown — but
   * the call is still running and its answer is still coming, so asking the
   * same question again would buy a second copy of it. Callers read this
   * before deciding whether pressing a pill should cost a call.
   */
  readonly outstanding: boolean;
}

function emptyRun<T>(data: T | null = null): AssistRunState<T> {
  return {
    data,
    fresh: false,
    meta: null,
    persisted: true,
    pending: false,
    startedAt: null,
    failure: null,
    notice: null,
    outstanding: false,
  };
}

/**
 * The sentence for a request that never reached the server at all.
 *
 * The assist actions never throw — every model failure comes back as data — so
 * a rejected promise here is the transport underneath: the browser offline, the
 * deployment restarting mid-request. It is still a failure a person can act on,
 * and it still has to say that nothing was changed.
 */
export const TRANSPORT_FAILURE: AssistFailureView = {
  code: "unreachable",
  message:
    "The request never reached the server. Nothing was changed — check the connection and ask again.",
  retryable: true,
  retryAfterSeconds: null,
  provider: null,
};

/**
 * What Cancel, and closing a panel mid-flight, leaves behind.
 *
 * Every clause of this is now something the code does. The waiting stops; the
 * call does not, and saying so is the difference between "cancelled" and what
 * actually happened; and the answer really does turn up here, marked "from
 * earlier", because `ask` retains a cancelled request rather than discarding
 * its reply.
 */
export const CANCELLED_NOTICE =
  "Stopped waiting — though the request itself carries on, so this one is still paid for. If the answer arrives it is kept, and it will appear here as “from earlier” rather than being asked for again.";

export interface AssistRun<T> {
  readonly state: AssistRunState<T>;
  /** Ask. An earlier ask stops driving this panel the moment this one starts. */
  ask(attempt: () => Promise<AssistAttempt<T>>): Promise<void>;
  /**
   * Stop waiting for whatever is in flight. Does not stop the model, and does
   * not throw the answer away: it lands as "from earlier" if it arrives.
   */
  cancel(notice?: string): void;
  /** Say what just happened, under the panel. */
  note(notice: AssistNotice | string | null): void;
  /**
   * Forget that anything is in flight without a notice: what closing a panel
   * does when nothing was waiting.
   */
  settle(): void;
  /**
   * Throw the answer away as well.
   *
   * For an assist whose answer goes stale on its own — the thumbnail critique
   * judges the bytes that were in the bucket when it ran — reopening a panel
   * that still shows the old verdict would be showing a stale judgement as a
   * current one. Keeping it would only save a call at the cost of the one
   * thing the panel promises.
   */
  forget(): void;
}

export function useAssistRun<T>(initial: T | null = null): AssistRun<T> {
  const [state, setState] = useState<AssistRunState<T>>(() => emptyRun<T>(initial));

  /**
   * Which request this component is still interested in.
   *
   * A ref rather than state: it moves inside handlers, nothing renders from it,
   * and a stale closure reading it would defeat the whole point.
   */
  const wanted = useRef(0);

  /**
   * The one request that stopped being *waited for* without being replaced:
   * cancelled, or left behind by a closing panel. Its answer is still wanted;
   * only the spinner is not. A second cancel replaces it, because there can
   * only be one in flight at a time from this run.
   */
  const retained = useRef<number | null>(null);

  /**
   * Which request is actually in flight, or null. A ref rather than reading
   * `state.pending`, because Cancel has to know it synchronously, inside the
   * handler, before any re-render — and because reading state from inside a
   * `setState` updater to get at it would be a side effect in a function React
   * is allowed to call twice.
   */
  const inFlight = useRef<number | null>(null);

  /**
   * The newest request whose answer has actually landed on screen.
   *
   * A retained (cancelled) reply must not overwrite something newer, and
   * "newer" cannot be read off `fresh`: `ask()` leaves the previous answer's
   * `fresh` alone while it waits, so a second ask that is cancelled would find
   * `fresh: true` from the *first* one and skip itself. Comparing request ids
   * says what was actually meant.
   */
  const landed = useRef(0);

  const patch = useCallback((next: Partial<AssistRunState<T>>) => {
    setState((previous) => ({ ...previous, ...next }));
  }, []);

  const ask = useCallback(
    async (attempt: () => Promise<AssistAttempt<T>>) => {
      const id = wanted.current + 1;
      wanted.current = id;
      inFlight.current = id;
      retained.current = null;
      patch({
        pending: true,
        failure: null,
        notice: null,
        startedAt: Date.now(),
        outstanding: false,
      });

      let answer: AssistAttempt<T>;
      try {
        answer = await attempt();
      } catch {
        if (inFlight.current === id) inFlight.current = null;
        if (wanted.current !== id) {
          if (retained.current === id) {
            retained.current = null;
            patch({ outstanding: false });
          }
          return;
        }
        patch({ pending: false, failure: TRANSPORT_FAILURE });
        return;
      }

      if (inFlight.current === id) inFlight.current = null;

      if (wanted.current !== id) {
        /*
          Nobody is waiting for this one. If it was *cancelled* rather than
          superseded, it is still the answer to the last question asked, it is
          already in `videos.brainstorm_last`, and it has already been paid
          for — so it settles in quietly, as "from earlier", which is what the
          cancel notice says will happen. Two guards, inside the updater so
          they read the state that actually exists: a newer ask in flight owns
          the panel, and an answer that has already landed is newer than this
          one. A late failure is dropped either way.
        */
        if (retained.current !== id) return;
        retained.current = null;
        patch({ outstanding: false });
        // A late *failure* is dropped: nobody wants an alert about a request
        // they already walked away from.
        if (!answer.ok) return;
        // A newer ask is in flight, or a newer answer is already on screen.
        if (inFlight.current !== null || landed.current > id) return;
        landed.current = id;
        patch({
          data: answer.data,
          fresh: false,
          meta: answer.meta,
          persisted: answer.persisted,
        });
        return;
      }

      if (!answer.ok) {
        const { code, message, retryable, retryAfterSeconds, provider } = answer;
        patch({
          pending: false,
          failure: { code, message, retryable, retryAfterSeconds, provider },
        });
        return;
      }

      landed.current = id;
      patch({
        pending: false,
        data: answer.data,
        fresh: true,
        meta: answer.meta,
        persisted: answer.persisted,
        failure: null,
      });
    },
    [patch],
  );

  /**
   * Stop waiting for whatever is in flight, but keep wanting its answer.
   * Returns whether there was anything to stop waiting for.
   */
  const stopWaiting = useCallback((): boolean => {
    const id = inFlight.current;
    wanted.current += 1;
    inFlight.current = null;
    if (id === null) return false;
    retained.current = id;
    return true;
  }, []);

  const cancel = useCallback(
    (notice: string = CANCELLED_NOTICE) => {
      const outstanding = stopWaiting();
      patch({ pending: false, notice: { text: notice }, outstanding });
    },
    [patch, stopWaiting],
  );

  const note = useCallback(
    (notice: AssistNotice | string | null) => {
      patch({ notice: typeof notice === "string" ? { text: notice } : notice });
    },
    [patch],
  );

  const settle = useCallback(() => {
    // Closing a panel mid-flight is the same bargain as Cancel without the
    // sentence: the waiting ends, the answer is still wanted, and reopening
    // must not buy a second copy of it.
    const outstanding = stopWaiting();
    patch({ pending: false, fresh: false, outstanding });
  }, [patch, stopWaiting]);

  const forget = useCallback(() => {
    wanted.current += 1;
    inFlight.current = null;
    retained.current = null;
    landed.current = wanted.current;
    setState(emptyRun<T>());
  }, []);

  return { state, ask, cancel, note, settle, forget };
}
