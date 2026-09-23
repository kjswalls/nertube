"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  scriptFromTemplate,
  updateVideo,
  type ScriptFromTemplateResult,
} from "@/app/actions/videos";
import { SaveStatus, useSaveQueue, useUnsavedGuard } from "@/components/autosave";
import { useVideoVersion } from "@/components/video-version";
import {
  countWords,
  MAX_END_SCREEN_TARGET_LENGTH,
  SCRIPT_STRUCTURE_LABEL,
  SCRIPT_STRUCTURES,
  scriptForColumn,
  type ScriptStructure,
} from "@/lib/script";
import { cleanProse } from "@/lib/text";
import { diagnoseWriteFailure, failureSentence } from "@/lib/write-failure";

import { ResetScriptDialog } from "./reset-dialog";

/**
 * The Script tab's editor: the script itself, its structure and the video the
 * end screen points at — three columns, one save queue.
 *
 * ## One queue for three fields
 *
 * Every write on `/videos/[id]` carries the row's version (`updated_at`) as a
 * precondition, and every write moves it. Three fields with a queue each would
 * put two writes on the wire with the same precondition the moment someone
 * finished a paragraph and tabbed to the end-screen box, and the second would
 * be refused as "changed somewhere else" by this very page. So the section
 * keeps one draft of all three, diffs it against what the row will hold once
 * everything on the wire has landed, and sends the difference through
 * `useSaveQueue` — the packaging block's shape, at a smaller size.
 *
 * ## Saving while typing
 *
 * The rest of the page saves on blur. A script is an evening's writing in one
 * box that may never lose focus, so it also saves after a short pause in the
 * typing (`PAUSE_MS`), and on blur, and — through `useUnsavedGuard`, the same
 * two guards every autosaved field has — when the page is left: a client-side
 * navigation sends it, and a reload or a closed tab makes the browser ask
 * first. A save that fails leaves the text exactly where it is and says why;
 * a save refused because another tab wrote first says that, with a Reload.
 *
 * The text is sent **as written**, never trimmed (`scriptForColumn`), because
 * it saves mid-sentence: trimming would remove the newline just typed and the
 * caret would jump. The box never takes the server's copy back while it is
 * being typed in — the comparison is made on the stored form instead, so a
 * box and a column that differ only in a trailing blank line are not "dirty".
 *
 * ## Reset from template
 *
 * `scriptFromTemplate` builds what `move_video` would write now; the dialog
 * says what it will replace; on yes the text is put in the box and saved like
 * any other edit, and the previous text is held here so Undo can put it back
 * the same way, for as long as the page is open. See `reset-dialog.tsx`.
 */

/** How long a pause in typing is before the script is saved. */
const PAUSE_MS = 1200;

type Structure = ScriptStructure | "";

interface Draft {
  readonly script: string;
  readonly structure: Structure;
  readonly endScreenTarget: string;
}

/** What the row holds, in the column's own form. */
interface Stored {
  readonly script: string | null;
  readonly structure: ScriptStructure | null;
  readonly endScreenTarget: string | null;
}

interface Patch {
  script?: string | null;
  scriptStructure?: ScriptStructure | null;
  endScreenTarget?: string | null;
}

/** `NullableText`'s rule for the one-line field, in the browser. */
function endScreenForColumn(value: string): string | null {
  const trimmed = cleanProse(value).trim();
  return trimmed === "" ? null : trimmed;
}

function storedOf(draft: Draft): Stored {
  return {
    script: scriptForColumn(draft.script),
    structure: draft.structure === "" ? null : draft.structure,
    endScreenTarget: endScreenForColumn(draft.endScreenTarget),
  };
}

/** What would make the row match the draft, or `null` when nothing would. */
function diffOf(draft: Draft, base: Stored): Patch | null {
  const next = storedOf(draft);
  const patch: Patch = {};
  let any = false;
  if (next.script !== base.script) {
    patch.script = next.script;
    any = true;
  }
  if (next.structure !== base.structure) {
    patch.scriptStructure = next.structure;
    any = true;
  }
  if (next.endScreenTarget !== base.endScreenTarget) {
    patch.endScreenTarget = next.endScreenTarget;
    any = true;
  }
  return any ? patch : null;
}

/** The row as it will be once this patch lands on it. */
function applyPatch(base: Stored, patch: Patch): Stored {
  return {
    script: patch.script === undefined ? base.script : patch.script,
    structure:
      patch.scriptStructure === undefined ? base.structure : patch.scriptStructure,
    endScreenTarget:
      patch.endScreenTarget === undefined ? base.endScreenTarget : patch.endScreenTarget,
  };
}

/** What the reset has done, for the line under the toolbar. */
type ResetNotice =
  | { readonly kind: "replaced"; readonly previous: string }
  | { readonly kind: "started" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "restored" }
  | { readonly kind: "failed"; readonly message: string };

type ReadyReset = Extract<ScriptFromTemplateResult, { ok: true }>;

export function ScriptEditor({
  videoId,
  initialScript,
  initialStructure,
  initialEndScreenTarget,
  scriptingName,
}: {
  videoId: string;
  initialScript: string | null;
  initialStructure: ScriptStructure | null;
  initialEndScreenTarget: string | null;
  /** The channel's name for its scripting-kind stage. */
  scriptingName: string;
}) {
  const version = useVideoVersion();
  const scriptId = useId();
  const structureId = useId();
  const endScreenId = useId();
  const statusId = useId();

  const initialDraft: Draft = {
    script: initialScript ?? "",
    structure: initialStructure ?? "",
    endScreenTarget: initialEndScreenTarget ?? "",
  };

  /*
    The draft is state for rendering and a ref for the handlers, which must
    read what is in the boxes *now* — a blur straight after a keystroke would
    otherwise see the render before it. The same split `useAutosave` makes.
  */
  const [draft, setDraftState] = useState<Draft>(initialDraft);
  const draftRef = useRef<Draft>(initialDraft);
  /** What the row last confirmed. Rendered (the idle hint), so also state. */
  const savedRef = useRef<Stored>(storedOf(initialDraft));
  const [saved, setSaved] = useState<Stored>(() => storedOf(initialDraft));

  const queue = useSaveQueue<Patch>({
    save: async (patch) => {
      const expected = version.peek();
      const result = await updateVideo({
        videoId,
        ...(expected === undefined ? {} : { expectedUpdatedAt: expected }),
        ...patch,
      });
      if (!result.ok) {
        return { ok: false, error: result.error, conflict: result.conflict };
      }
      version.adopt(result.video.updatedAt);
      const stored: Stored = {
        script: result.video.script,
        structure: result.video.scriptStructure,
        endScreenTarget: result.video.endScreenTarget,
      };
      savedRef.current = stored;
      setSaved(stored);
      return { ok: true };
    },
  });
  const { send, touch, peekPending } = queue;

  /** What the row will hold once everything already sent has landed. */
  const baseline = useCallback((): Stored => {
    const pending = peekPending();
    return pending === null ? savedRef.current : applyPatch(savedRef.current, pending);
  }, [peekPending]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPause = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const commit = useCallback(() => {
    cancelPause();
    const patch = diffOf(draftRef.current, baseline());
    if (patch !== null) send(patch);
  }, [baseline, cancelPause, send]);

  const isDirty = useCallback(
    () => diffOf(draftRef.current, baseline()) !== null,
    [baseline],
  );

  useUnsavedGuard({
    isDirty,
    flush: commit,
    busy: () => peekPending() !== null,
  });

  useEffect(() => cancelPause, [cancelPause]);

  const setDraft = useCallback(
    (next: Partial<Draft>) => {
      const merged = { ...draftRef.current, ...next };
      draftRef.current = merged;
      setDraftState(merged);
      touch();
    },
    [touch],
  );

  /** Typing in the script: save after a pause, not per keystroke. */
  const typeScript = (value: string) => {
    setDraft({ script: value });
    cancelPause();
    timer.current = setTimeout(() => {
      timer.current = null;
      commit();
    }, PAUSE_MS);
  };

  /* ------------------------------------------------------------------ */
  /* Reset from template                                                 */
  /* ------------------------------------------------------------------ */

  const [reading, setReading] = useState(false);
  const [confirming, setConfirming] = useState<ReadyReset | null>(null);
  const [notice, setNotice] = useState<ResetNotice | null>(null);
  const resetButton = useRef<HTMLButtonElement>(null);

  /** Put this text in the box and save it now: a reset, or its undo. */
  const replaceScript = (text: string) => {
    setDraft({ script: text });
    commit();
  };

  async function askForReset() {
    if (reading) return;
    setReading(true);
    setNotice(null);
    let result: ScriptFromTemplateResult;
    try {
      result = await scriptFromTemplate(videoId);
    } catch {
      const why = await diagnoseWriteFailure();
      result = {
        ok: false,
        error: failureSentence(
          why,
          "Could not reach the server to read the template. Nothing has changed.",
        ),
      };
    }
    setReading(false);

    if (!result.ok) {
      setNotice({ kind: "failed", message: result.error });
      return;
    }
    const current = draftRef.current.script;
    if (current === result.script) {
      setNotice({ kind: "unchanged" });
      return;
    }
    // Nothing to replace, so nothing to ask: the empty box simply starts from
    // the template. Undo would put back an empty box, which is not worth a
    // button.
    if (scriptForColumn(current) === null) {
      replaceScript(result.script);
      setNotice({ kind: "started" });
      return;
    }
    setConfirming(result);
  }

  function confirmReset(rebuilt: string) {
    const previous = draftRef.current.script;
    setConfirming(null);
    replaceScript(rebuilt);
    setNotice({ kind: "replaced", previous });
  }

  function undoReset(previous: string) {
    replaceScript(previous);
    setNotice({ kind: "restored" });
  }

  /* ------------------------------------------------------------------ */

  // True once this is running in the browser — the handlers exist — and false
  // in the server's HTML. For the specs, which must not type into a box whose
  // onChange is not attached yet (`e2e/hydration.ts` has the argument).
  const live = useSyncExternalStore(noSubscription, () => true, () => false);

  const words = countWords(draft.script);
  const pendingSave = diffOf(draft, saved) !== null;

  return (
    <section
      data-testid="script-section"
      data-editable="true"
      data-live={live ? "true" : "false"}
      aria-labelledby={`${scriptId}-heading`}
      className="flex flex-col gap-4"
    >
      {/*
        The toolbar stays on screen while the script scrolls under it — below
        the phone's 57px bar, at the top of the window from `md` — so the save
        state and Reset are never a scroll away from the line being typed.
      */}
      <div
        data-testid="script-toolbar"
        className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border bg-background px-1 py-2 max-md:top-[57px]"
      >
        <div className="flex items-baseline gap-3">
          <h2 id={`${scriptId}-heading`} className="text-sm font-semibold">
            Script
          </h2>
          <span data-testid="script-words" className="font-mono text-xs text-muted">
            {words.toLocaleString("en-US")} {words === 1 ? "word" : "words"}
          </span>
        </div>

        <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
          <SaveStatus
            id={statusId}
            state={queue.state}
            testId="script-status"
            idle={pendingSave ? "Saves when you pause" : ""}
            onRetry={() => commit()}
          />
          <button
            ref={resetButton}
            type="button"
            data-testid="script-reset"
            aria-busy={reading || undefined}
            onClick={() => void askForReset()}
            className="rounded-button border border-border px-3 py-1.5 text-sm outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11"
          >
            {reading ? (
              "Reading…"
            ) : (
              <>
                {/*
                  One word on a phone, so the toolbar stays one row and the
                  script keeps the height the on-screen keyboard leaves it.
                  The accessible name is the full phrase at every width.
                */}
                <span aria-hidden="true" className="sm:hidden">
                  Reset
                </span>
                <span className="max-sm:sr-only">Reset from template</span>
              </>
            )}
          </button>
        </div>
      </div>

      <ResetNoticeLine notice={notice} onUndo={undoReset} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-1">
          <label htmlFor={structureId} className="text-xs font-medium text-muted">
            Structure
          </label>
          <select
            id={structureId}
            data-testid="script-structure"
            value={draft.structure}
            onChange={(event) => {
              setDraft({ structure: event.target.value as Structure });
              commit();
            }}
            className={`${FIELD_CLASS} thumb:min-h-11`}
          >
            <option value="">Not chosen</option>
            {SCRIPT_STRUCTURES.map((structure) => (
              <option key={structure} value={structure}>
                {SCRIPT_STRUCTURE_LABEL[structure]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={endScreenId} className="text-xs font-medium text-muted">
            End screen points at
          </label>
          <input
            id={endScreenId}
            type="text"
            data-testid="script-end-screen"
            value={draft.endScreenTarget}
            maxLength={MAX_END_SCREEN_TARGET_LENGTH}
            placeholder="One specific video, by name"
            autoComplete="off"
            onChange={(event) => setDraft({ endScreenTarget: event.target.value })}
            onBlur={() => {
              // Shown as it will be stored, the way every one-line field is.
              const trimmed = draftRef.current.endScreenTarget.trim();
              if (trimmed !== draftRef.current.endScreenTarget) {
                setDraft({ endScreenTarget: trimmed });
              }
              commit();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
            }}
            className={`${FIELD_CLASS} font-display placeholder:font-sans placeholder:text-sm thumb:min-h-11`}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={scriptId} className="sr-only">
          Script
        </label>
        <GrowingTextarea
          id={scriptId}
          value={draft.script}
          describedBy={statusId}
          invalid={queue.state.kind === "error"}
          onChange={typeScript}
          onBlur={commit}
        />
        <p className="text-xs text-muted">
          Markdown text, kept exactly as written. It started from the channel&rsquo;s
          template when this video moved into {scriptingName}.
        </p>
      </div>

      {confirming ? (
        <ResetScriptDialog
          current={draft.script}
          reset={confirming}
          returnFocusRef={resetButton}
          onConfirm={() => confirmReset(confirming.script)}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </section>
  );
}

/** Nothing to subscribe to: the snapshot only differs between server and client. */
const noSubscription = () => () => {};

/** 16px everywhere, which is what stops iOS zooming the page on focus. */
const FIELD_CLASS =
  "w-full rounded-input border border-border bg-background px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-accent";

/* -------------------------------------------------------------------------- */
/* The box                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A textarea as tall as its text.
 *
 * A long script in a fixed box is a document read through a letterbox, with a
 * second scrollbar inside the page's. This one grows instead, so the page is
 * the only thing that scrolls and the browser's own "keep the caret in view"
 * scrolls the page as the text grows under the on-screen keyboard.
 *
 * How it grows: an invisible copy of the text sits in the same grid cell with
 * exactly the textarea's font, padding, border and wrapping, and the cell is
 * as tall as the copy. No measuring in JavaScript — `height: auto` then
 * `scrollHeight` briefly collapses the box on every keystroke, and near the
 * bottom of a long page that makes the whole page jump. `field-sizing:
 * content` would do it in CSS alone, but Safari and Firefox do not have it.
 *
 * It is never shorter than most of a screen (`svh`, the small viewport, so
 * the on-screen keyboard does not resize it mid-sentence): a new script
 * should look like a page to write on, not a form field.
 */
function GrowingTextarea({
  id,
  value,
  describedBy,
  invalid,
  onChange,
  onBlur,
}: {
  id: string;
  value: string;
  describedBy: string;
  invalid: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  // Shared by the box and its copy: if these two ever differ, the box and the
  // text inside it wrap at different points and the last line is cut off.
  const metrics =
    "col-start-1 row-start-1 min-h-[max(18rem,calc(100svh-20rem))] w-full rounded-input border px-4 py-3 font-display text-base leading-relaxed whitespace-pre-wrap break-words";

  return (
    <div className="grid min-w-0">
      <div aria-hidden="true" className={`${metrics} invisible border-transparent`}>
        {/* The space keeps a trailing newline's empty line in the copy. */}
        {value}{" "}
      </div>
      <textarea
        id={id}
        data-testid="script-editor"
        value={value}
        spellCheck
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        placeholder="Write the script here. The hook word for word, the body as bullets, the end screen pointing at one named video."
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        className={`${metrics} resize-none overflow-hidden border-border bg-background outline-none placeholder:font-sans placeholder:text-sm placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent`}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* What the reset did                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The line that says what Reset did, with the Undo beside it.
 *
 * The same shape as an accepted concept's notice (`AssistNoticeLine`): the
 * way back sits next to the thing that happened. Undo lasts until the page is
 * left or the next reset, which is what "the previous text is kept" means for
 * an app with no history of a field — the text is held here, in memory.
 */
function ResetNoticeLine({
  notice,
  onUndo,
}: {
  notice: ResetNotice | null;
  onUndo: (previous: string) => void;
}) {
  if (notice === null) return null;

  const failed = notice.kind === "failed";
  const text =
    notice.kind === "replaced"
      ? "Replaced with the template."
      : notice.kind === "started"
        ? "Started from the template."
        : notice.kind === "unchanged"
          ? "The script already matches the template — nothing to replace."
          : notice.kind === "restored"
            ? "Your previous script is back."
            : notice.message;

  return (
    <p
      data-testid="script-reset-notice"
      data-kind={notice.kind}
      className={[
        "-mt-2 flex flex-wrap items-center gap-2 text-xs",
        failed ? "text-attention" : "text-muted",
      ].join(" ")}
    >
      <span role={failed ? "alert" : "status"}>{text}</span>
      {notice.kind === "replaced" ? (
        <button
          type="button"
          data-testid="script-reset-undo"
          onClick={() => onUndo(notice.previous)}
          className="rounded-button border border-border px-2 py-0.5 text-xs text-foreground outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent thumb:min-h-11 thumb:px-3"
        >
          Undo
        </button>
      ) : null}
    </p>
  );
}
