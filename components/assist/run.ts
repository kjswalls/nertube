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
 * ## Why "cancel" is a client-side word
 *
 * A server action cannot be recalled. By the time somebody presses Cancel the
 * model is already thinking and, for the kinds that persist, the row will still
 * be written. So cancelling here means *stop waiting for this answer*: the
 * request id moves, a late reply is ignored rather than dropped into a panel
 * the person has moved on from, and the notice says so in as many words instead
 * of implying the call was called off. Closing a panel does the same thing.
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
};

/** What Cancel, and closing a panel mid-flight, leaves behind. */
export const CANCELLED_NOTICE =
  "Stopped waiting. If the answer did arrive it is kept — it will be here, as “from earlier”, next time you open this.";

export interface AssistRun<T> {
  readonly state: AssistRunState<T>;
  /** Ask. Any answer to an earlier ask is already being ignored. */
  ask(attempt: () => Promise<AssistAttempt<T>>): Promise<void>;
  /** Stop waiting for whatever is in flight. Does not stop the model. */
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

  const patch = useCallback((next: Partial<AssistRunState<T>>) => {
    setState((previous) => ({ ...previous, ...next }));
  }, []);

  const ask = useCallback(
    async (attempt: () => Promise<AssistAttempt<T>>) => {
      const id = wanted.current + 1;
      wanted.current = id;
      patch({ pending: true, failure: null, notice: null, startedAt: Date.now() });

      let answer: AssistAttempt<T>;
      try {
        answer = await attempt();
      } catch {
        if (wanted.current !== id) return;
        patch({ pending: false, failure: TRANSPORT_FAILURE });
        return;
      }

      if (wanted.current !== id) return;

      if (!answer.ok) {
        const { code, message, retryable, retryAfterSeconds } = answer;
        patch({
          pending: false,
          failure: { code, message, retryable, retryAfterSeconds },
        });
        return;
      }

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

  const cancel = useCallback(
    (notice: string = CANCELLED_NOTICE) => {
      wanted.current += 1;
      patch({ pending: false, notice: { text: notice } });
    },
    [patch],
  );

  const note = useCallback(
    (notice: AssistNotice | string | null) => {
      patch({ notice: typeof notice === "string" ? { text: notice } : notice });
    },
    [patch],
  );

  const settle = useCallback(() => {
    wanted.current += 1;
    patch({ pending: false, fresh: false });
  }, [patch]);

  const forget = useCallback(() => {
    wanted.current += 1;
    setState(emptyRun<T>());
  }, []);

  return { state, ask, cancel, note, settle, forget };
}
