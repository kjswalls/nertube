"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

/**
 * Autosave-on-blur, factored out of the title field M1 shipped
 * (`app/videos/[id]/title-field.tsx`).
 *
 * Every editable field on the detail page behaves the same way, and it is a
 * behaviour with four parts that are easy to get subtly different in five
 * copies:
 *
 * 1. **Blur, not keystroke.** A note is written by typing, deleting and
 *    rewriting. Saving each keystroke would put a row of nonsense per character
 *    through the network and into `updated_at` — which the board's Idea column
 *    sorts by — for one edit.
 * 2. **Nothing is sent when nothing changed.** `savedRef` holds what the server
 *    last confirmed, so tabbing through an untouched field is silent.
 * 3. **A failure keeps what was typed.** The value in the box is the user's,
 *    not the server's: on a refusal it stays exactly as typed so the next blur
 *    can try again, and the message says what happened. Losing an unsaved
 *    sponsor read because the wifi dropped is the one outcome this must not
 *    have.
 * 4. **A rejected promise is caught.** Uncaught, it is rethrown into the
 *    nearest error boundary and the whole route — including the text being
 *    edited — is replaced by an error screen.
 *
 * The success path re-reads the value from the server's answer rather than
 * trusting the local string, so a field cannot drift from the column: whatever
 * the action says is stored is what ends up in the box.
 */

export type SaveState =
  | { kind: "idle" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * What a field's `save` must answer with.
 *
 * `value` is what the server stored, which is not always what was sent — empty
 * becomes NULL, which comes back as `""`.
 */
export type SaveOutcome =
  | { ok: true; value: string }
  | { ok: false; error: string };

export interface Autosave {
  value: string;
  /** Type into the field. Clears any stale "Saved"/error line. */
  setValue: (next: string) => void;
  /**
   * Save, if there is anything to save. Call from `onBlur` — and from
   * `onChange` for a control whose whole interaction is one click (a date
   * picker, a select): it is a no-op when the value already matches the server.
   */
  commit: () => void;
  state: SaveState;
  pending: boolean;
}

export function useAutosave({
  initial,
  save,
  trim = true,
}: {
  initial: string;
  save: (next: string) => Promise<SaveOutcome>;
  /** Whitespace-only is empty for every field here; a textarea keeps its shape. */
  trim?: boolean;
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
  const savedRef = useRef(initial);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  // The caller's `save` closes over its own props and is rebuilt every render.
  // Held in a ref so `commit` can stay stable without every field having to
  // remember to `useCallback` its saver — a stale closure here would write last
  // render's value.
  const saveRef = useRef(save);
  // Written in an effect rather than during render: a ref assignment in the
  // render body runs on a render React may throw away, and lint says so.
  // Effects are flushed before the next user event, so a blur always sees the
  // saver its own render built.
  useEffect(() => {
    saveRef.current = save;
  });

  const setValue = useCallback((next: string) => {
    valueRef.current = next;
    setValueState(next);
    setState((current) => (current.kind === "idle" ? current : { kind: "idle" }));
  }, []);

  const commit = useCallback(() => {
    const next = trim ? valueRef.current.trim() : valueRef.current;
    if (next !== valueRef.current) {
      valueRef.current = next;
      setValueState(next);
    }
    if (next === savedRef.current) return;

    startTransition(async () => {
      try {
        const result = await saveRef.current(next);
        if (result.ok) {
          savedRef.current = result.value;
          valueRef.current = result.value;
          setValueState(result.value);
          setState({ kind: "saved" });
        } else {
          // The typed text stays, and the baseline is left alone so the next
          // blur tries again rather than deciding nothing has changed.
          setState({ kind: "error", message: result.error });
        }
      } catch {
        setState({
          kind: "error",
          message:
            "Could not reach the server, so this is not saved yet. What you typed is still here — try again.",
        });
      }
    });
  }, [trim]);

  return { value, setValue, commit, state, pending };
}

/**
 * The one-line saved/saving/failed indicator under a field.
 *
 * `role="status"` while things are going well — a save nobody asked to be
 * interrupted about — and `role="alert"` when one failed, because that is the
 * case where something the user typed is not where they think it is.
 */
export function SaveStatus({
  state,
  pending,
  testId,
  idle = "",
}: {
  state: SaveState;
  pending: boolean;
  testId: string;
  /** Shown when there is nothing to report; usually a hint about the field. */
  idle?: string;
}) {
  const failed = state.kind === "error";

  return (
    <p
      role={failed ? "alert" : "status"}
      data-testid={testId}
      data-state={pending ? "saving" : state.kind}
      className={[
        "min-h-4 text-xs",
        failed ? "text-amber-700 dark:text-amber-400" : "text-muted",
      ].join(" ")}
    >
      {pending
        ? "Saving…"
        : state.kind === "saved"
          ? "Saved"
          : state.kind === "error"
            ? state.message
            : idle}
    </p>
  );
}
