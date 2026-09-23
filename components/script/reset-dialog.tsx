"use client";

import type { RefObject } from "react";

import type { ScriptFromTemplateResult } from "@/app/actions/videos";
import { Modal } from "@/components/modal";
import { HOOK_PLACEHOLDER } from "@/lib/channel-settings";
import { countWords } from "@/lib/script";

/**
 * "Replace the script?" — the question Reset asks before it overwrites
 * anything, in the application's one modal.
 *
 * It says exactly what goes and what comes: how much of the person's own
 * writing is about to be replaced, which template it comes from, and what will
 * stand where `{{hook}}` is — the chosen hook verbatim, or, when none is
 * chosen, that the Hook section will come out empty. That last case is the one
 * reset exists for as much as any: a video that skipped the gate reached
 * Scripting with no hook, and once one is chosen this is how it gets written
 * in. The structure and end-screen fields are not touched, and the sentence
 * says so, because they sit right above the box being replaced.
 *
 * Nothing here writes. Confirming hands control back to the editor, which puts
 * the text in the box and saves it through its one queue, and keeps the old
 * text for Undo.
 */
export function ResetScriptDialog({
  current,
  reset,
  returnFocusRef,
  onConfirm,
  onCancel,
}: {
  /** What is in the box now — the text that would be replaced. */
  current: string;
  reset: Extract<ScriptFromTemplateResult, { ok: true }>;
  returnFocusRef: RefObject<HTMLElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const words = countWords(current);

  return (
    <Modal
      title="Replace the script with the template?"
      testId="script-reset-dialog"
      returnFocusRef={returnFocusRef}
      onClose={onCancel}
    >
      <div className="flex flex-col gap-3 text-sm">
        <p data-testid="script-reset-what">
          Everything in the script now —{" "}
          <span className="font-mono text-[13px]">
            {words.toLocaleString("en-US")} {words === 1 ? "word" : "words"}
          </span>{" "}
          — is replaced by {reset.channelName}&rsquo;s current script template.
        </p>

        <p data-testid="script-reset-hook" className="text-muted">
          {!reset.templateHasHook ? (
            <>
              The template has no <code className="font-mono">{HOOK_PLACEHOLDER}</code>, so no
              hook is written in.
            </>
          ) : reset.hook === null || reset.hook.trim() === "" ? (
            <>
              No hook is chosen, so the Hook section will be empty. Choose one on the
              Packaging tab first if you want it written in.
            </>
          ) : (
            <>
              The chosen hook goes where the template says{" "}
              <code className="font-mono">{HOOK_PLACEHOLDER}</code>:{" "}
              <q className="font-display text-base text-foreground">{reset.hook}</q>
            </>
          )}
        </p>

        <p className="text-muted">
          Structure and end-screen target stay as they are. Until you leave this
          page, Undo puts back the script you have now.
        </p>

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            data-testid="script-reset-confirm"
            onClick={onConfirm}
            className="rounded-button border border-border bg-background px-3 py-1.5 text-sm font-medium outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11"
          >
            Replace script
          </button>
          <button
            type="button"
            // Focus starts on the answer that loses nothing: Enter on an
            // unread dialog must not be the keystroke that overwrites a script.
            autoFocus
            data-testid="script-reset-cancel"
            onClick={onCancel}
            className="rounded-button px-3 py-1.5 text-sm text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11"
          >
            Keep my script
          </button>
        </div>
      </div>
    </Modal>
  );
}
