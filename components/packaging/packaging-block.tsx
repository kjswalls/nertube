"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

import {
  updateVideo,
  type PackagingState,
  type UpdateVideoInputShape,
} from "@/app/actions/videos";
import {
  newId,
  packagingGate,
  readHooks,
  readTitleCandidates,
  type Hook,
  type TitleCandidate,
} from "@/lib/packaging";

import { GateIndicator } from "./gate-indicator";
import { HooksEditor } from "./hooks-editor";
import { SaveStatus, type SaveState } from "./save-status";
import { SkipPackaging } from "./skip-packaging";
import { ThumbnailConcept } from "./thumbnail-concept";
import { TitleCandidates } from "./title-candidates";
import { WorkingTitle } from "./working-title";

/**
 * The packaging block — the title/thumbnail/hook gate, made visible and
 * editable.
 *
 * BRIEF.md principle 1 is that packaging is decided *before* scripting and
 * filming, that it is roughly 20% of the effort for 80% of the result, and that
 * the tool should make skipping it structurally awkward. Everything in this
 * directory is that sentence turned into a screen: the three fields the gate
 * reads sit together at the top of the video, a live indicator says what the
 * gate would decide right now, and the way out is a disclosure that demands a
 * typed reason.
 *
 * ## One state, one predicate, one save path
 *
 * The three things that could disagree with each other are deliberately made
 * from the same parts:
 *
 * - **The indicator and the board's refusal** come from `packagingGate()` in
 *   `lib/packaging.ts`, which is a transcription of the gate block inside
 *   `move_video`. This component computes nothing about readiness itself.
 * - **The editor and the column** go through one server action, `updateVideo`,
 *   which validates with the schemas in the same file. There is no second
 *   writer and no second set of rules.
 * - **The fields and each other**: choosing a title candidate changes the
 *   candidate list *and* the working title, and it does so in one patch, so
 *   they cannot land half-applied.
 *
 * ## What "saved" means here
 *
 * Text fields save on blur (M1's pattern, `app/videos/[id]/title-field.tsx`:
 * a title is written by deleting and rewriting, and saving each keystroke puts
 * a dozen half-titles through `updated_at`, which the board sorts by).
 * Structural changes — adding, removing, choosing — save immediately, because
 * they have no blur to wait for and no half-finished state to protect.
 *
 * A failed save **never** reverts what is on screen. The editor is the source
 * of truth for what you typed; `saved` is a separate copy of what the row last
 * confirmed; and the indicator says "not saved yet" whenever they differ, so a
 * green "ready" can never quietly mean "ready in this browser tab only".
 */

export interface PackagingInitial {
  /** `videos.title` — the gate's first field. */
  readonly title: string;
  /** `videos.thumbnail_concept` — the WRITTEN concept, not the sketch. */
  readonly thumbnailConcept: string | null;
  /** `videos.title_candidates`, raw jsonb. Read leniently; see `lib/packaging.ts`. */
  readonly titleCandidates: unknown;
  /** `videos.hooks`, raw jsonb. */
  readonly hooks: unknown;
  readonly packagingSkippedAt: string | null;
  readonly packagingSkipReason: string | null;
}

/** Only the fields with a typing phase. The skip is not edited in place. */
interface Draft {
  readonly title: string;
  readonly thumbnailConcept: string;
  readonly candidates: readonly TitleCandidate[];
  readonly hooks: readonly Hook[];
}

/**
 * Is this list the same list the row holds?
 *
 * Compared through a fixed key order rather than `JSON.stringify` of the
 * objects as they happen to be built. Spreading an edit over an object appends
 * a key that was previously absent, so an otherwise identical candidate could
 * serialise as `{id,text,chosen,source,note}` here and `{id,text,note,chosen,
 * source}` there and read as "changed" for ever. The only thing that matters is
 * the values.
 */
const sameCandidates = (
  a: readonly TitleCandidate[],
  b: readonly TitleCandidate[],
): boolean =>
  a.length === b.length &&
  a.every((item, index) => {
    const other = b[index];
    return (
      item.id === other.id &&
      item.text === other.text &&
      (item.note ?? "") === (other.note ?? "") &&
      item.chosen === other.chosen &&
      item.source === other.source
    );
  });

const sameHooks = (a: readonly Hook[], b: readonly Hook[]): boolean =>
  a.length === b.length &&
  a.every((item, index) => {
    const other = b[index];
    return (
      item.id === other.id && item.text === other.text && item.chosen === other.chosen
    );
  });

/** Trim-then-null, the same normalisation `updateVideo` applies to the column. */
const conceptForColumn = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

type Patch = Omit<UpdateVideoInputShape, "videoId">;

/**
 * What would have to be written to make the row match the editor — or `null`
 * when nothing would.
 *
 * Diffing rather than sending everything keeps a blurred concept box to one
 * column, and, more usefully, makes "does this need saving at all" the same
 * question as "what would be saved". Tabbing through untouched fields writes
 * nothing.
 */
function diffOf(draft: Draft, saved: PackagingState): Patch | null {
  const patch: Patch = {};
  let any = false;

  const title = draft.title.trim();
  if (title !== saved.title) {
    patch.title = title;
    any = true;
  }

  const concept = draft.thumbnailConcept.trim();
  if (conceptForColumn(concept) !== saved.thumbnailConcept) {
    patch.thumbnailConcept = concept;
    any = true;
  }

  if (!sameCandidates(draft.candidates, saved.titleCandidates)) {
    patch.titleCandidates = draft.candidates as TitleCandidate[];
    any = true;
  }

  if (!sameHooks(draft.hooks, saved.hooks)) {
    patch.hooks = draft.hooks as Hook[];
    any = true;
  }

  return any ? patch : null;
}

export function PackagingBlock({
  videoId,
  initial,
}: {
  videoId: string;
  initial: PackagingInitial;
}) {
  /**
   * The row as last confirmed by the server. `useState` and not a ref: the
   * "not saved yet" caveat is derived from it on every render.
   */
  const [saved, setSaved] = useState<PackagingState>(() => ({
    title: initial.title,
    thumbnailConcept: initial.thumbnailConcept,
    titleCandidates: readTitleCandidates(initial.titleCandidates),
    hooks: readHooks(initial.hooks),
    packagingSkippedAt: initial.packagingSkippedAt,
    packagingSkipReason: initial.packagingSkipReason,
  }));

  const [draft, setDraft] = useState<Draft>(() => ({
    title: initial.title,
    thumbnailConcept: initial.thumbnailConcept ?? "",
    candidates: readTitleCandidates(initial.titleCandidates),
    hooks: readHooks(initial.hooks),
  }));

  /** Read inside the async save callback, where `draft` would be a stale closure. */
  const draftRef = useRef(draft);
  const setDraftBoth = useCallback((next: Draft) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  /** Carries the patch that failed, so Retry re-sends exactly that patch. */
  const [saveState, setSaveState] = useState<SaveState<Patch>>({ kind: "idle" });
  const [, startTransition] = useTransition();

  /**
   * One save on the wire at a time.
   *
   * The fast path this block is designed around — type a candidate, Enter, type
   * the next — puts a save in flight every second or so, and on any real
   * network two of them overlap. Each patch carries *absolute* values (the whole
   * list, the whole title), never a delta, so two in flight is not a merge
   * problem: it is an ordering problem. If `[c1]` and `[c1, c2]` are both sent
   * and the slower one is the first, the row ends up holding `[c1]` and the
   * second candidate is gone from the database while still on screen.
   *
   * So a save that arrives while one is in flight is *queued* rather than sent,
   * merged key-by-key over anything already queued (a later value for a column
   * wins, which is exactly right for absolute values), and sent when the wire is
   * free. What is on screen is never delayed by this — only the write is.
   */
  const inFlightRef = useRef(false);
  const queuedRef = useRef<Patch | null>(null);
  /** `send` calling itself, without a self-referencing `useCallback`. */
  const sendRef = useRef<((patch: Patch) => void) | null>(null);

  const send = useCallback(
    (patch: Patch) => {
      if (inFlightRef.current) {
        queuedRef.current = { ...queuedRef.current, ...patch };
        return;
      }
      inFlightRef.current = true;

      const payload: UpdateVideoInputShape = { videoId, ...patch };
      // The draft as it was when this save left, so the answer is only allowed
      // to overwrite the editor if the editor has not moved on since.
      const sentDraft = draftRef.current;
      setSaveState({ kind: "saving" });

      startTransition(async () => {
        try {
          const result = await updateVideo(payload);
          if (!result.ok) {
            setSaveState({ kind: "error", message: result.error, payload: patch });
            return;
          }

          setSaved(result.packaging);

          // Adopt the server's normalisation (trimmed text, dropped empty
          // notes) only if nothing has been typed since — otherwise the newer
          // thing on screen wins, because it is what the person is looking at.
          if (draftRef.current === sentDraft) {
            setDraftBoth({
              title: result.packaging.title,
              thumbnailConcept: result.packaging.thumbnailConcept ?? "",
              candidates: result.packaging.titleCandidates,
              hooks: result.packaging.hooks,
            });
          }
          setSaveState({ kind: "saved" });
        } catch {
          // The action never reached the server, or its answer never came back.
          // Uncaught, that rejection goes to the nearest error boundary and
          // replaces the whole page — including everything typed into it (M1
          // review finding 10). Here it is a line, and the editor is untouched.
          setSaveState({
            kind: "error",
            message:
              "Could not reach the server, so this is not saved. Nothing you typed has been lost — press Retry.",
            payload: patch,
          });
        } finally {
          inFlightRef.current = false;
          const queued = queuedRef.current;
          queuedRef.current = null;
          if (queued) sendRef.current?.(queued);
        }
      });
    },
    [setDraftBoth, videoId],
  );

  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  /** Apply an edit and save whatever it changed, in one go. */
  const commit = useCallback(
    (next: Draft) => {
      setDraftBoth(next);
      const patch = diffOf(next, saved);
      if (patch) send(patch);
    },
    [saved, send, setDraftBoth],
  );

  /** A keystroke: update what is on screen, save nothing. */
  const edit = useCallback(
    (next: Draft) => {
      setDraftBoth(next);
      if (saveState.kind !== "idle") setSaveState({ kind: "idle" });
    },
    [saveState.kind, setDraftBoth],
  );

  /* ---------------------------------------------------------------- gate -- */

  /**
   * The values the *next save* will put in the row, judged by the same
   * predicate `move_video` uses. Trimmed here because trimming is what the save
   * does — the predicate itself does not trim, exactly as the SQL does not.
   */
  const status = useMemo(
    () =>
      packagingGate({
        title: draft.title.trim(),
        thumbnailConcept: conceptForColumn(draft.thumbnailConcept),
        hooks: draft.hooks,
        packagingSkippedAt: saved.packagingSkippedAt,
      }),
    [draft.hooks, draft.thumbnailConcept, draft.title, saved.packagingSkippedAt],
  );

  const unsaved = diffOf(draft, saved) !== null;

  /* ------------------------------------------------------------ handlers -- */

  const addCandidate = (text: string) =>
    commit({
      ...draft,
      candidates: [
        ...draft.candidates,
        { id: newId(), text, chosen: false, source: "manual" },
      ],
    });

  const toggleCandidate = (id: string) => {
    const target = draft.candidates.find((candidate) => candidate.id === id);
    if (!target) return;
    const choosing = !target.chosen;
    const candidates = draft.candidates.map((candidate) => ({
      ...candidate,
      // Exclusive by construction: there is no sequence of clicks that leaves
      // two ticked, so the invalid state is unreachable rather than validated.
      chosen: choosing && candidate.id === id,
    }));
    commit({
      ...draft,
      candidates,
      // Choosing *means* "this is the title" — the gate reads `videos.title`,
      // not the list, so a tick that left the title alone would be a decision
      // the gate does not believe in. Un-choosing leaves the title where it is:
      // it has been committed to, and silently blanking it would be a
      // destructive surprise.
      title: choosing ? target.text : draft.title,
    });
  };

  const addHook = (text: string) =>
    commit({
      ...draft,
      hooks: [...draft.hooks, { id: newId(), text, chosen: false }],
    });

  const toggleHook = (id: string) => {
    const target = draft.hooks.find((hook) => hook.id === id);
    if (!target) return;
    const choosing = !target.chosen;
    commit({
      ...draft,
      hooks: draft.hooks.map((hook) => ({
        ...hook,
        chosen: choosing && hook.id === id,
      })),
    });
  };

  /* --------------------------------------------------------------- skip --- */

  const skip = (reason: string) => send({ packagingSkip: { reason } });
  const unskip = () => send({ packagingSkip: null });

  /* -------------------------------------------------------------- render -- */

  return (
    <section
      id="packaging"
      data-testid="packaging-block"
      aria-labelledby="packaging-heading"
      className="flex scroll-mt-4 flex-col gap-4 rounded-lg border border-border p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="packaging-heading" className="text-sm font-semibold">
          Packaging
        </h2>
        <p className="text-xs text-muted">
          Title, thumbnail concept and hook — decided here, before a word of
          script is written. About a fifth of the work, and most of the result.
        </p>
      </div>

      <GateIndicator
        status={status}
        unsaved={unsaved}
        skipReason={saved.packagingSkipReason}
      />

      <WorkingTitle
        value={draft.title}
        onChange={(title) => edit({ ...draft, title })}
        onCommit={() => commit(draft)}
      />

      <TitleCandidates
        candidates={draft.candidates}
        onAdd={addCandidate}
        onEditText={(id, text) =>
          edit({
            ...draft,
            candidates: draft.candidates.map((candidate) =>
              candidate.id === id ? { ...candidate, text } : candidate,
            ),
          })
        }
        onEditNote={(id, note) =>
          edit({
            ...draft,
            candidates: draft.candidates.map((candidate) =>
              candidate.id === id
                ? { ...candidate, ...(note.trim() === "" ? { note: undefined } : { note }) }
                : candidate,
            ),
          })
        }
        onCommit={() => commit(draft)}
        onToggleChosen={toggleCandidate}
        onRemove={(id) =>
          commit({
            ...draft,
            candidates: draft.candidates.filter((candidate) => candidate.id !== id),
          })
        }
      />

      <ThumbnailConcept
        value={draft.thumbnailConcept}
        maxLength={2000}
        onChange={(thumbnailConcept) => edit({ ...draft, thumbnailConcept })}
        onCommit={() => commit(draft)}
      />

      <HooksEditor
        hooks={draft.hooks}
        onAdd={addHook}
        onEditText={(id, text) =>
          edit({
            ...draft,
            hooks: draft.hooks.map((hook) =>
              hook.id === id ? { ...hook, text } : hook,
            ),
          })
        }
        onCommit={() => commit(draft)}
        onToggleChosen={toggleHook}
        onRemove={(id) =>
          commit({ ...draft, hooks: draft.hooks.filter((hook) => hook.id !== id) })
        }
      />

      <SaveStatus state={saveState} onRetry={send} />

      <SkipPackaging
        skippedAt={saved.packagingSkippedAt}
        skipReason={saved.packagingSkipReason}
        onSkip={skip}
        onUnskip={unskip}
        busy={saveState.kind === "saving"}
      />
    </section>
  );
}
