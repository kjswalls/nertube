"use client";

import { useId, useRef, useState } from "react";

import { MAX_HOOK_LENGTH, MAX_HOOKS, type Hook } from "@/lib/packaging";

/**
 * The hook list: three variants, one chosen.
 *
 * The course guidance behind BRIEF.md is to write three openings and pick the
 * strongest, and the schema follows it literally — `0001_init.sql` carries
 * `jsonb_array_length(hooks) <= 3`, so a fourth hook is refused by Postgres
 * whatever the browser thinks. This component refuses it one layer earlier and
 * *says why*, because a constraint violation surfacing as "that did not save"
 * is the worst version of a rule that is actually good advice.
 *
 * ## Choosing is exclusive by construction
 *
 * There is no way to express "two chosen hooks" here: choosing one clears the
 * rest in the same state update, so the invalid state is unreachable rather
 * than validated-against. `lib/packaging.ts` still refuses two on the way to the
 * column — belt and braces, because this component is not the only thing that
 * will ever write this list (M8's brainstorm panel adds "Use as hook") and the
 * gate's whole behaviour hangs on the count being exactly one.
 *
 * Un-choosing is allowed. The gate wants exactly one chosen hook, and a person
 * who has changed their mind mid-decision should be able to be in the "none
 * chosen" state honestly rather than having to pick a hook they do not want.
 * The indicator says so while they are there.
 */
export function HooksEditor({
  hooks,
  onAdd,
  onEditText,
  onCommit,
  onToggleChosen,
  onRemove,
}: {
  hooks: readonly Hook[];
  onAdd: (text: string) => void;
  onEditText: (id: string, text: string) => void;
  onCommit: () => void;
  onToggleChosen: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const addId = useId();
  const noticeId = useId();
  const addRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const atLimit = hooks.length >= MAX_HOOKS;
  const chosen = hooks.filter((hook) => hook.chosen).length;

  function add() {
    const text = draft.trim();
    if (atLimit) {
      // Deliberately reachable rather than a disabled button: a control that
      // does nothing and says nothing is how "why can't I add a hook?" happens.
      // The reason is stated, and it is the real one.
      setNotice(
        `Three hooks is the limit — the course asks for three and the database refuses a fourth. Remove one to make room.`,
      );
      return;
    }
    if (text === "") {
      setNotice("Type the hook first — an empty hook cannot be the one you picked.");
      return;
    }
    setNotice(null);
    setDraft("");
    onAdd(text);
    addRef.current?.focus();
  }

  return (
    <section className="flex flex-col gap-2" aria-labelledby={`${addId}-heading`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={`${addId}-heading`} className="text-xs font-medium text-muted">
          Hooks
        </h3>
        <p data-testid="hook-count" className="text-xs text-muted">
          <span data-testid="hook-count-number">{hooks.length}</span>/{MAX_HOOKS} written
          {chosen === 1 ? " · one chosen" : chosen === 0 ? " · none chosen" : ` · ${chosen} chosen`}
        </p>
      </div>

      <p className="text-xs text-muted">
        Write three openings and pick the strongest. The chosen one is what gets
        spliced into the script template at Scripting, and it is what the gate
        counts.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
        className="flex gap-2"
      >
        <label htmlFor={addId} className="sr-only">
          Add a hook
        </label>
        <textarea
          id={addId}
          ref={addRef}
          value={draft}
          rows={2}
          placeholder="The first fifteen seconds, verbatim…"
          maxLength={MAX_HOOK_LENGTH}
          aria-describedby={noticeId}
          data-testid="hook-input"
          onChange={(event) => {
            setDraft(event.target.value);
            if (notice) setNotice(null);
          }}
          onKeyDown={(event) => {
            // A hook is one or two sentences, so Enter adds it rather than
            // making a newline — same gesture as the candidate list next door.
            // Shift+Enter is the escape hatch for a deliberate line break.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              add();
            }
          }}
          className="min-w-0 flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-foreground/40"
        />
        <button
          type="submit"
          data-testid="hook-add"
          className="h-fit shrink-0 rounded-md border border-border px-3 py-2 text-sm font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-foreground/40"
        >
          Add
        </button>
      </form>

      <p
        id={noticeId}
        role="status"
        data-testid="hook-notice"
        className="min-h-4 text-xs text-amber-700 dark:text-amber-400"
      >
        {notice ?? ""}
      </p>

      {hooks.length === 0 ? null : (
        <ul data-testid="hook-list" className="flex flex-col gap-2">
          {hooks.map((hook, index) => (
            <li
              key={hook.id}
              data-testid="hook-row"
              data-chosen={hook.chosen ? "true" : "false"}
              className={[
                "flex items-start gap-2 rounded-md border px-2 py-2",
                hook.chosen ? "border-emerald-600/60 bg-emerald-600/5" : "border-border",
              ].join(" ")}
            >
              <label className="sr-only" htmlFor={`${addId}-text-${hook.id}`}>
                Hook {index + 1}
              </label>
              <textarea
                id={`${addId}-text-${hook.id}`}
                value={hook.text}
                rows={2}
                maxLength={MAX_HOOK_LENGTH}
                data-testid="hook-text"
                onChange={(event) => onEditText(hook.id, event.target.value)}
                onBlur={onCommit}
                className="min-w-0 flex-1 resize-y rounded border border-transparent bg-transparent px-1 py-1 text-base outline-none hover:border-border focus-visible:ring-2 focus-visible:ring-foreground/40"
              />

              <button
                type="button"
                aria-pressed={hook.chosen}
                data-testid="hook-choose"
                title={
                  hook.chosen
                    ? "This is the chosen hook. Click to un-choose it."
                    : "Make this the chosen hook."
                }
                onClick={() => onToggleChosen(hook.id)}
                className={[
                  "shrink-0 rounded border px-2 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-foreground/40",
                  hook.chosen
                    ? "border-emerald-600/60 bg-emerald-600/10"
                    : "border-border hover:bg-surface",
                ].join(" ")}
              >
                {hook.chosen ? "Chosen" : "Choose"}
              </button>

              <button
                type="button"
                data-testid="hook-remove"
                aria-label={`Remove hook ${index + 1}`}
                onClick={() => onRemove(hook.id)}
                className="shrink-0 rounded border border-border px-2 py-1 text-xs outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-foreground/40"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
