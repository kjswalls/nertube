"use client";

import { useId, useRef, useState, useTransition } from "react";

import { updateWorkingTitle } from "@/app/actions/videos";

/**
 * The working title, autosaved on blur.
 *
 * Blur and not keystroke: a title is written by thinking, deleting and
 * rewriting, and saving each keystroke would put a dozen rows of nonsense
 * through the network and into `updated_at` (which the board's Idea column
 * sorts by) for one edit. Enter blurs the field, so the keyboard path is
 * "type, Enter" and the mouse path is "type, click away" — both end in exactly
 * one save.
 *
 * `savedRef` holds what the server last confirmed, so tabbing through an
 * untouched field writes nothing at all.
 *
 * Clearing the title is allowed. PLAN.md wants an empty title to surface as
 * "Complete packaging" at the gate, not to be refused by a form — the gate is
 * the one place that decides whether a title is required.
 */
export function TitleField({
  videoId,
  initialTitle,
}: {
  videoId: string;
  initialTitle: string;
}) {
  const inputId = useId();
  const [value, setValue] = useState(initialTitle);
  const savedRef = useRef(initialTitle);
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "saved" } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [pending, startTransition] = useTransition();

  function save() {
    const next = value.trim();
    if (next !== value) setValue(next);
    if (next === savedRef.current) return;

    startTransition(async () => {
      try {
        const result = await updateWorkingTitle({ videoId, title: next });
        if (result.ok) {
          savedRef.current = result.title;
          setValue(result.title);
          setState({ kind: "saved" });
        } else {
          setState({ kind: "error", message: result.error });
        }
      } catch {
        // The action never reached the server, or its answer never came back.
        // Uncaught, that rejection is rethrown into the nearest error boundary
        // and the whole route — including the title being edited — is replaced
        // by an error screen. Here the typed title stays in the field and the
        // next blur tries again.
        setState({
          kind: "error",
          message:
            "Could not reach the server, so this title is not saved yet. It is still here — try again.",
        });
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium text-muted">
        Working title
      </label>

      <input
        id={inputId}
        name="title"
        type="text"
        value={value}
        placeholder="Untitled"
        autoComplete="off"
        maxLength={300}
        onChange={(event) => {
          setValue(event.target.value);
          if (state.kind !== "idle") setState({ kind: "idle" });
        }}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            // Blur does the saving, so Enter and clicking away are one path.
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        // 16px so iOS does not zoom the page when it is focused.
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
      />

      <p
        // Polite, not an alert: this narrates a save nobody asked to be
        // interrupted about. The failure below uses `alert` instead.
        role={state.kind === "error" ? "alert" : "status"}
        data-testid="title-status"
        className={[
          "min-h-4 text-xs",
          state.kind === "error" ? "text-amber-700 dark:text-amber-400" : "text-muted",
        ].join(" ")}
      >
        {pending
          ? "Saving…"
          : state.kind === "saved"
            ? "Saved"
            : state.kind === "error"
              ? state.message
              : ""}
      </p>
    </div>
  );
}
