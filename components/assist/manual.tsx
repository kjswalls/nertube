"use client";

import { useEffect, useId, useRef, useState } from "react";

import { ROLE_LABEL } from "@/components/thumbnails/roles";
import type { ThumbnailRole } from "@/lib/storage";

import type { AssistFailureView } from "./run";

/**
 * "Open in Claude" — the manual path, as one block every assist panel renders
 * (M11).
 *
 * Anthropic does not allow a claude.ai subscription to power a server-side
 * app, so the subscription path is done by hand and this component is the
 * whole of the hand part: it asks the server for the prompt, copies it, opens
 * claude.ai in a new tab, says in one sentence what to do there, and takes the
 * reply back in a box. It never talks to claude.ai, and nothing of claude.ai's
 * — no cookie, no token — is ever read, kept or sent by this app. The only
 * thing that crosses between the two is text the person carries themselves.
 *
 * ## What it does not own
 *
 * The answer. Pressing Read hands the pasted text to the panel's own
 * `useAssistRun` (`run.ts`) through a server action that returns exactly what
 * the API path returns, so the proposals, the accept buttons, the clamp line,
 * the provenance and `brainstorm_last` are the ones the panel already had.
 * This draws the two steps around them and nothing else.
 *
 * ## Primary or quiet
 *
 * With no API key (`selectAssistMode` in `lib/assist/select.ts`) this is the
 * panel's primary action, open from the start with both steps showing — the
 * paste box is there even before anything was copied, because a phone that
 * reloads the page while the person is in claude.ai must still let them paste
 * the reply they came back with. With a key it is a quiet disclosure under
 * the panel's own "Ask", always available, and pressing it never copies over
 * a reply that may already be on the clipboard: it only opens the steps.
 *
 * ## The order of the three browser calls, and why
 *
 * Fetch the prompt, copy it, then open the tab. Copying first is what makes
 * the copy work: `navigator.clipboard.writeText` needs the document to have
 * focus, and a new tab takes it. Opening after an `await` is inside the click's
 * user activation in every current browser for a round trip this short, and
 * when a browser blocks it anyway the sentence says so and the link beside it
 * is a plain `target="_blank"` anchor, which is never blocked. When the copy
 * is refused, the prompt appears in a read-only box, already selected, so the
 * person's next gesture is the copy the browser would not do.
 */

export const CLAUDE_NEW_URL = "https://claude.ai/new";

/** What the server hands back when Open in Claude is pressed. */
export type ManualPromptAnswer =
  | {
      ok: true;
      prompt: string;
      /** The critique's files, to attach by hand. */
      images?: readonly { role: ThumbnailRole; url: string | null }[];
    }
  | { ok: false; message: string };

type Step =
  | { kind: "idle" }
  | { kind: "fetching" }
  | { kind: "copied"; opened: boolean }
  | { kind: "refused"; opened: boolean }
  | { kind: "failed"; message: string };

const QUIET_BUTTON =
  "rounded-button border border-border px-2 py-1 text-xs outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50 thumb:min-h-11 thumb:px-3";

const PRIMARY_BUTTON =
  "rounded-button bg-foreground px-3 py-2 text-[13px] font-medium text-background outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60 thumb:min-h-11";

export function OpenInClaude({
  prefix,
  primary,
  what,
  getPrompt,
  onRead,
  reading,
  busy = reading,
  failure,
  images: attach = false,
}: {
  /** The panel's test-id prefix: `brainstorm`, `concept-assist`, `critique`. */
  prefix: string;
  /** Open in Claude is the panel's main action (no API key), or a quiet one. */
  primary: boolean;
  /** What Claude will be asked for, in a few words: "twenty titles". */
  what: string;
  getPrompt: () => Promise<ManualPromptAnswer>;
  /** Read the pasted reply. Resolves true when it became proposals. */
  onRead: (reply: string) => Promise<boolean>;
  /** A pasted reply is being read right now. */
  reading: boolean;
  /**
   * Anything is in flight on this question — a read, or an API ask. Read waits
   * for it: two answers racing for one panel (and one `brainstorm_last` key)
   * would leave whichever lands last, not whichever was meant.
   */
  busy?: boolean;
  /** The last read's failure, when it was the paste that failed. */
  failure: AssistFailureView | null;
  /** The critique: claude.ai needs the images attached by hand. */
  images?: boolean;
}) {
  const [shown, setShown] = useState(primary);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [prompt, setPrompt] = useState<string | null>(null);
  const [files, setFiles] = useState<
    readonly { role: ThumbnailRole; url: string | null }[]
  >([]);
  const [reply, setReply] = useState("");
  /*
    After a reply has become proposals, the steps fold to one row (M11
    integration): the proposals are what the person came for, and on a phone
    the spent instructions and an empty paste box pushed them a third of a
    screen down. Either button unfolds it again.
  */
  const [folded, setFolded] = useState(false);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const pasteId = useId();
  const nextId = useId();

  /*
    The prompt the browser would not copy, selected, so the next gesture is
    the copy. A subscription to the step rather than a state write: nothing
    here sets state.
  */
  useEffect(() => {
    if (step.kind !== "refused") return;
    const box = fallbackRef.current;
    if (!box) return;
    box.focus({ preventScroll: false });
    box.select();
  }, [step]);

  async function openInClaude() {
    setFolded(false);
    setStep({ kind: "fetching" });
    let answer: ManualPromptAnswer;
    try {
      answer = await getPrompt();
    } catch {
      setStep({
        kind: "failed",
        message:
          "The prompt could not be fetched — the request never reached the server. Check the connection and press Open in Claude again.",
      });
      return;
    }
    if (!answer.ok) {
      setStep({ kind: "failed", message: answer.message });
      return;
    }
    setPrompt(answer.prompt);
    setFiles(answer.images ?? []);

    let copied = false;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(answer.prompt);
      copied = true;
    } catch {
      copied = false;
    }

    let opened = false;
    try {
      const tab = window.open(CLAUDE_NEW_URL, "_blank");
      if (tab) {
        // The new tab must not be able to reach back into this one.
        try {
          tab.opener = null;
        } catch {
          /* a browser that will not let us is one that already severed it */
        }
        opened = true;
      }
    } catch {
      opened = false;
    }

    setStep(copied ? { kind: "copied", opened } : { kind: "refused", opened });
  }

  async function read() {
    const text = reply;
    if (text.trim() === "") return;
    const ok = await onRead(text);
    // The box keeps what was pasted until it has become proposals: a reply
    // that could not be read is the person's to fix, not ours to throw away.
    if (ok) {
      setReply("");
      setStep({ kind: "idle" });
      setFolded(true);
    }
  }

  if (!shown) {
    return (
      <div data-testid={`${prefix}-manual`} data-mode="secondary" className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>Or ask in your own claude.ai conversation, at no cost to this app:</span>
        <button
          type="button"
          data-testid={`${prefix}-manual-toggle`}
          aria-expanded={false}
          onClick={() => setShown(true)}
          className={QUIET_BUTTON}
        >
          Open in Claude…
        </button>
      </div>
    );
  }

  if (folded) {
    return (
      <div
        data-testid={`${prefix}-manual`}
        data-mode={primary ? "primary" : "secondary"}
        data-step="read"
        className="flex flex-wrap items-center gap-2"
      >
        <button
          type="button"
          data-testid={`${prefix}-open-in-claude`}
          onClick={() => void openInClaude()}
          className={QUIET_BUTTON}
        >
          Open in Claude again
        </button>
        <button
          type="button"
          data-testid={`${prefix}-paste-another`}
          onClick={() => setFolded(false)}
          className={QUIET_BUTTON}
        >
          Paste another reply
        </button>
      </div>
    );
  }

  const next =
    step.kind === "copied" || step.kind === "refused" ? step : null;

  return (
    <div
      data-testid={`${prefix}-manual`}
      data-mode={primary ? "primary" : "secondary"}
      data-step={step.kind}
      className="flex flex-col gap-3 rounded-input border border-border bg-background/40 px-3 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid={`${prefix}-open-in-claude`}
          onClick={() => void openInClaude()}
          disabled={step.kind === "fetching"}
          aria-describedby={next ? nextId : undefined}
          className={PRIMARY_BUTTON}
        >
          {step.kind === "fetching" ? "Writing the prompt…" : "Open in Claude"}
        </button>
        {!primary ? (
          <button
            type="button"
            data-testid={`${prefix}-manual-toggle`}
            aria-expanded={true}
            onClick={() => setShown(false)}
            className={QUIET_BUTTON}
          >
            Hide
          </button>
        ) : null}
      </div>

      {step.kind === "idle" || step.kind === "fetching" ? (
        <p className="text-xs text-muted">
          Copies a prompt for {what} — written from this video, the channel’s
          voice guide and what it has published — and opens claude.ai in a new
          tab. It runs in your own conversation; this app sends nothing there.
        </p>
      ) : null}

      {step.kind === "failed" ? (
        <p data-testid={`${prefix}-manual-failure`} role="alert" className="text-xs text-attention">
          {step.message}
        </p>
      ) : null}

      {next ? (
        <p
          id={nextId}
          data-testid={`${prefix}-manual-next`}
          role="status"
          className="text-xs"
        >
          {next.kind === "copied"
            ? `The prompt is copied${next.opened ? " and claude.ai is open in a new tab" : ""}. Paste it there${attach ? ", attach the images below" : ""} and send it, then copy Claude’s whole reply and paste it here.`
            : `This browser would not let the page copy, so the prompt is below, selected — copy it, paste it into claude.ai${attach ? ", attach the images below" : ""} and send it, then paste Claude’s whole reply here.`}{" "}
          {next.opened ? (
            <a
              href={CLAUDE_NEW_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted underline underline-offset-2 hover:text-foreground"
            >
              claude.ai again ↗
            </a>
          ) : (
            <a
              data-testid={`${prefix}-manual-link`}
              href={CLAUDE_NEW_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline underline-offset-2 thumb:inline-flex thumb:min-h-11 thumb:items-center"
            >
              The new tab was blocked — open claude.ai ↗
            </a>
          )}
        </p>
      ) : null}

      {step.kind === "refused" && prompt !== null ? (
        <textarea
          ref={fallbackRef}
          data-testid={`${prefix}-manual-fallback`}
          aria-label="The prompt, to copy by hand"
          readOnly
          value={prompt}
          rows={6}
          onFocus={(event) => event.currentTarget.select()}
          className="w-full resize-y rounded-input border border-border bg-background px-2 py-1.5 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent max-md:text-base thumb:text-base"
        />
      ) : null}

      {attach && files.length > 0 ? (
        <div data-testid={`${prefix}-manual-images`} className="flex flex-col gap-1">
          <p className="text-xs text-muted">
            This app cannot attach images to claude.ai, so attach these by hand,
            in this order — save each one, then add it to the message:
          </p>
          <ol className="flex flex-wrap gap-2">
            {files.map((file, index) => (
              <li key={file.role}>
                {file.url ? (
                  <a
                    data-testid={`${prefix}-manual-image`}
                    data-role={file.role}
                    href={file.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    download={`${index + 1}-${file.role.replace("_", "-")}`}
                    className={`${QUIET_BUTTON} inline-flex items-center`}
                  >
                    {index + 1}. {ROLE_LABEL[file.role]} ↓
                  </a>
                ) : (
                  <span data-testid={`${prefix}-manual-image`} data-role={file.role} className="text-xs text-attention">
                    {index + 1}. {ROLE_LABEL[file.role]} — could not be linked; save it from the slot above.
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      ) : attach ? (
        <p className="text-xs text-muted">
          claude.ai needs the images themselves, which this app cannot attach
          for you: the steps name them once the prompt is copied.
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={pasteId} className="text-xs font-medium">
          Paste Claude’s reply
        </label>
        <textarea
          id={pasteId}
          data-testid={`${prefix}-paste`}
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          rows={4}
          placeholder={
            attach
              ? "WILD CARD || reads: yes || adds: no || …"
              : "1. … || why it works"
          }
          aria-describedby={failure ? `${pasteId}-failure` : undefined}
          className="w-full resize-y rounded-input border border-border bg-background px-2 py-1.5 text-[13px] outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent max-md:text-base thumb:text-base thumb:min-h-11"
        />
        {failure ? (
          <div
            id={`${pasteId}-failure`}
            data-testid={`${prefix}-paste-failure`}
            data-code={failure.code}
            role="alert"
            className="flex flex-col gap-1 rounded-input border border-attention/50 bg-attention/[0.06] px-3 py-2 text-xs"
          >
            <p>{failure.message}</p>
            <p className="text-muted">
              Nothing was changed. What you pasted is still in the box.
            </p>
          </div>
        ) : null}
        <div>
          <button
            type="button"
            data-testid={`${prefix}-read`}
            onClick={() => void read()}
            disabled={busy || reply.trim() === ""}
            className={QUIET_BUTTON}
          >
            {reading ? "Reading…" : "Read"}
          </button>
        </div>
      </div>
    </div>
  );
}
