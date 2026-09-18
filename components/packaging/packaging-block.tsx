"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { updateVideo } from "@/app/actions/videos";
import { SaveStatus, useSaveQueue } from "@/components/autosave";
import { usePublishPackagingDraft } from "@/components/preview/live-packaging";
import { useVideoVersion } from "@/components/video-version";
import {
  GATE_ANCHOR,
  HookListSchema,
  newId,
  packagingGate,
  PACKAGING_ANCHOR,
  readHooks,
  readTitleCandidates,
  SKIP_ANCHOR,
  TitleCandidateListSchema,
  type Hook,
  type TitleCandidate,
} from "@/lib/packaging";
import { MAX_CONCEPT_LENGTH, type VideoPatchInput } from "@/lib/video-fields";

import { GateIndicator } from "./gate-indicator";
import type { RowIssue } from "./row-issue";
import { focusAnchorId, useHashTarget } from "./hash-focus";
import { HooksEditor } from "./hooks-editor";
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
 * - **The editor and the column** go through `updateVideo`, the detail page's
 *   one write path, validated by the one schema in `lib/video-fields.ts`.
 * - **The fields and each other**: choosing a title candidate changes the
 *   candidate list *and* the working title, and it does so in one patch, so
 *   they cannot land half-applied.
 *
 * ## What "saved" means here
 *
 * Text fields save on blur, structural changes (adding, removing, choosing)
 * save immediately, and both go through the shared queue in
 * `components/autosave.tsx` — one write on the wire at a time, later ones
 * merged and sent after, because every patch carries absolute values and two in
 * flight is an ordering hazard rather than a merge.
 *
 * A failed save **never** reverts what is on screen. The editor is the source
 * of truth for what you typed; `saved` is a separate copy of what the row last
 * confirmed; and the indicator says "not saved yet" whenever they differ, so a
 * green "ready" can never quietly mean "ready in this browser tab only".
 *
 * ## The concept sketch sits inside it
 *
 * `sketch` is the M1 upload component, rendered next to the *written* concept
 * rather than in a section of its own. They are a pair — a description and a
 * reference picture of the same thumbnail — and separating them is what let an
 * M1 reviewer read the sketch as the thing the gate wants. Side by side, with
 * the text labelled as the gate's field and the picture labelled as reference,
 * the relationship is on the screen instead of in a comment.
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

/**
 * The packaging half of the row, as the server last confirmed it.
 *
 * `updateVideo` answers with the whole `VideoState` from `app/actions/videos.ts`
 * (the flow columns too, because one action writes them all); this is the slice
 * this block compares itself against, and that answer satisfies it structurally.
 */
interface SavedPackaging {
  readonly title: string;
  readonly thumbnailConcept: string | null;
  readonly titleCandidates: readonly TitleCandidate[];
  readonly hooks: readonly Hook[];
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

type Patch = Omit<VideoPatchInput, "videoId" | "expectedUpdatedAt">;

/** The saved row as a `Draft`, so every comparison is draft-against-draft. */
const viewOf = (saved: SavedPackaging): Draft => ({
  title: saved.title,
  thumbnailConcept: saved.thumbnailConcept ?? "",
  candidates: saved.titleCandidates,
  hooks: saved.hooks,
});

/**
 * What would have to be written to make the row match the editor — or `null`
 * when nothing would.
 *
 * Diffing rather than sending everything keeps a blurred concept box to one
 * column, and, more usefully, makes "does this need saving at all" the same
 * question as "what would be saved". Tabbing through untouched fields writes
 * nothing.
 *
 * `base` is **what the row will hold once everything already on the wire has
 * landed**, not what it last confirmed. Diffed against the confirmed values, an
 * edit that undoes an in-flight change produces an empty patch: nothing is
 * queued, the abandoned value lands, and the row keeps it under a line saying
 * "Saved". See `peekPending` in `components/autosave.tsx`.
 */
function diffOf(draft: Draft, base: Draft): Patch | null {
  const patch: Patch = {};
  let any = false;

  const title = draft.title.trim();
  if (title !== base.title.trim()) {
    patch.title = title;
    any = true;
  }

  const concept = conceptForColumn(draft.thumbnailConcept);
  if (concept !== conceptForColumn(base.thumbnailConcept)) {
    patch.thumbnailConcept = concept;
    any = true;
  }

  if (!sameCandidates(draft.candidates, base.candidates)) {
    patch.titleCandidates = draft.candidates as TitleCandidate[];
    any = true;
  }

  if (!sameHooks(draft.hooks, base.hooks)) {
    patch.hooks = draft.hooks as Hook[];
    any = true;
  }

  return any ? patch : null;
}

/** The draft a base would become if this patch landed on it. */
function applyPatch(base: Draft, patch: Patch): Draft {
  return {
    title: patch.title ?? base.title,
    thumbnailConcept:
      patch.thumbnailConcept === undefined
        ? base.thumbnailConcept
        : (patch.thumbnailConcept ?? ""),
    candidates: (patch.titleCandidates as TitleCandidate[] | undefined) ?? base.candidates,
    hooks: (patch.hooks as Hook[] | undefined) ?? base.hooks,
  };
}

/**
 * Take the lists that will not validate out of the patch, and say which row is
 * at fault.
 *
 * Every packaging field shares one patch and one queue, so before this existed
 * a single blank candidate text — select-all, delete, Tab — made the working
 * title, the concept and the hooks *permanently* unsavable: the whole patch was
 * refused by `TitleCandidateListSchema`, and the shared status line told
 * somebody typing a title that "a title candidate needs some text", with no
 * indication which one. The same wedge was reachable from data this app did not
 * write, since the readers are lenient and the writers are strict.
 *
 * So the columns are decoupled: a list that fails its own schema is dropped
 * from the patch and reported against its own row, and everything else in the
 * patch still goes. Nothing invalid is ever written — the rule is unchanged —
 * but it no longer takes the rest of the block down with it. Dropping the key
 * also leaves it out of `saved` and out of the pending baseline, so the next
 * commit re-offers it and it saves the moment the row is fixed.
 */
function withoutInvalidLists(patch: Patch): {
  readonly patch: Patch;
  readonly candidateIssue: RowIssue | null;
  readonly hookIssue: RowIssue | null;
} {
  const kept: Patch = { ...patch };
  let candidateIssue: RowIssue | null = null;
  let hookIssue: RowIssue | null = null;

  if (patch.titleCandidates !== undefined) {
    const parsed = TitleCandidateListSchema.safeParse(patch.titleCandidates);
    if (!parsed.success) {
      delete kept.titleCandidates;
      candidateIssue = issueOf(parsed.error.issues[0], patch.titleCandidates);
    }
  }

  if (patch.hooks !== undefined) {
    const parsed = HookListSchema.safeParse(patch.hooks);
    if (!parsed.success) {
      delete kept.hooks;
      hookIssue = issueOf(parsed.error.issues[0], patch.hooks);
    }
  }

  return { patch: kept, candidateIssue, hookIssue };
}

/** Turn zod's `path: [index, key]` back into the id of the row that failed. */
function issueOf(
  issue: { path: PropertyKey[]; message: string },
  list: readonly { id?: unknown }[],
): RowIssue {
  const index = typeof issue.path[0] === "number" ? issue.path[0] : null;
  const row = index === null ? undefined : list[index];
  const id = typeof row?.id === "string" ? row.id : null;
  return { id, message: issue.message };
}

/**
 * Un-choose any candidate that is no longer the working title.
 *
 * Choosing a candidate copies its text into `videos.title`, because the gate
 * reads the column and not the list — and un-choosing deliberately leaves the
 * title alone, since it has been committed to. What neither of those covers is
 * the working title being *edited* afterwards: the candidate kept its green
 * "Chosen" badge while the field the gate reads held something else, which is
 * the same lie as a tick that left the title behind, reached from the other
 * direction. Applied on every commit, so an edit to the candidate's own text
 * closes the same gap.
 */
function unchooseStaleCandidates(draft: Draft): Draft {
  const title = draft.title.trim();
  let changed = false;

  const candidates = draft.candidates.map((candidate) => {
    const chosen = candidate.chosen && title !== "" && candidate.text.trim() === title;
    if (chosen === candidate.chosen) return candidate;
    changed = true;
    return { ...candidate, chosen };
  });

  return changed ? { ...draft, candidates } : draft;
}

/**
 * The right-hand end of a field's row, where the thing that will one day write
 * into that field sits. Renders nothing at all when the slot is empty, so a
 * page that passes no assists gets no stray flex container.
 */
function AssistRow({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <div className="-mt-2 flex justify-end">{children}</div>;
}

export function PackagingBlock({
  videoId,
  initial,
  sketch,
  titleWarning,
  assist,
}: {
  videoId: string;
  initial: PackagingInitial;
  /** The concept sketch uploader, rendered beside the written concept. */
  sketch?: ReactNode;
  /**
   * The feed-truncation warning, rendered under the candidate list it is about.
   *
   * A slot rather than an import, for the same reason `sketch` is one: this
   * block owns the three fields and the gate, and knows nothing about YouTube's
   * layout. It reads the live draft out of
   * `components/preview/live-packaging.tsx`, which this block publishes to.
   */
  titleWarning?: ReactNode;
  /**
   * The inert M8 assist controls, one per field that will get one. Slots, so
   * that the block does not import a component whose only job is to be
   * disabled, and so that M8 can replace them without touching this file.
   */
  assist?: {
    readonly candidates?: ReactNode;
    readonly concept?: ReactNode;
    readonly hooks?: ReactNode;
  };
}) {
  /**
   * The row as last confirmed by the server. `useState` and not a ref: the
   * "not saved yet" caveat is derived from it on every render.
   */
  const [saved, setSaved] = useState<SavedPackaging>(() => ({
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

  /** The same, for the confirmed row: read inside handlers, not only in render. */
  const savedRef = useRef(saved);
  const setSavedBoth = useCallback((next: SavedPackaging) => {
    savedRef.current = next;
    setSaved(next);
  }, []);

  /**
   * Which row, exactly, the elements that will not validate are in.
   *
   * Shown against the offending row rather than in the shared status line,
   * because the shared line is where somebody typing a *title* would read "a
   * title candidate needs some text" and have no idea which one.
   */
  const [candidateIssue, setCandidateIssue] = useState<RowIssue | null>(null);
  const [hookIssue, setHookIssue] = useState<RowIssue | null>(null);

  /** The precondition every write on this page carries; see `video-version.tsx`. */
  const version = useVideoVersion();

  /**
   * One save on the wire at a time; see `components/autosave.tsx`. The queue
   * owns the ordering and the status line, and this owns what to do with the
   * answer.
   */
  const { state: saveState, send, touch, peekPending } = useSaveQueue<Patch>({
    save: async (patch) => {
      // The draft as it was when this save left, so the answer is only allowed
      // to overwrite the editor if the editor has not moved on since.
      const sentDraft = draftRef.current;
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
      setSavedBoth(result.video);

      /*
        Adopt the server's normalisation (trimmed text, dropped empty notes)
        only if nothing has been typed since — otherwise the newer thing on
        screen wins, because it is what the person is looking at.

        And only for the columns *this patch carried*. It used to replace the
        whole draft, which meant a patch about `packaging_skipped_at` — which
        never goes near the text fields — answered with a row that does not
        contain the concept typed while the wifi was down, and wiped it off the
        screen and out of the only warning about it, under a line reading
        "Saved".
      */
      if (draftRef.current === sentDraft) {
        const adopted: Draft = {
          title: patch.title === undefined ? sentDraft.title : result.video.title,
          thumbnailConcept:
            patch.thumbnailConcept === undefined
              ? sentDraft.thumbnailConcept
              : (result.video.thumbnailConcept ?? ""),
          candidates:
            patch.titleCandidates === undefined
              ? sentDraft.candidates
              : result.video.titleCandidates,
          hooks: patch.hooks === undefined ? sentDraft.hooks : result.video.hooks,
        };
        setDraftBoth(adopted);
      }

      return { ok: true };
    },
  });

  /**
   * What the row will hold once everything already on the wire has landed.
   *
   * Not what it last *confirmed*: diffed against that, an edit made while a
   * save is in flight that returns a field to its last confirmed value comes
   * out as "nothing changed", so nothing is queued and the in-flight write —
   * the value the user has just abandoned — is the one that lands. The screen,
   * the row and the board then disagree permanently, with the status line
   * saying "Saved".
   */
  const baseline = useCallback((): Draft => {
    const pending = peekPending();
    const confirmed = viewOf(savedRef.current);
    return pending ? applyPatch(confirmed, pending) : confirmed;
  }, [peekPending]);

  /**
   * Build the patch for a draft, drop any list that will not validate, and put
   * the rest on the wire. `extra` is for the writes that are not a field edit
   * (the skip pair), which ride along in the same patch so they cannot discard
   * what has been typed and not yet saved.
   */
  const push = useCallback(
    (next: Draft, extra?: Patch): void => {
      const tidied = unchooseStaleCandidates(next);
      setDraftBoth(tidied);

      const full = diffOf(tidied, baseline());
      const split = full
        ? withoutInvalidLists(full)
        : { patch: {} as Patch, candidateIssue: null, hookIssue: null };

      setCandidateIssue(split.candidateIssue);
      setHookIssue(split.hookIssue);

      const patch: Patch = { ...split.patch, ...extra };
      if (Object.keys(patch).length > 0) send(patch);
    },
    [baseline, send, setDraftBoth],
  );

  /** Apply an edit and save whatever it changed, in one go. */
  const commit = useCallback((next: Draft) => push(next), [push]);

  /** A keystroke: update what is on screen, save nothing, clear a stale line. */
  const edit = useCallback(
    (next: Draft) => {
      setDraftBoth(next);
      touch();
    },
    [setDraftBoth, touch],
  );

  /* -------------------------------------------------------------- anchors -- */

  /**
   * A link into a field focuses that field.
   *
   * The skip anchor is handled by `SkipPackaging` itself, because getting there
   * means opening a disclosure first and only then focusing the box inside it.
   */
  const hash = useHashTarget();
  const skipRequest = hash?.id === SKIP_ANCHOR ? hash.nonce : 0;

  useEffect(() => {
    if (!hash || hash.id === SKIP_ANCHOR) return;
    focusAnchorId(hash.id);
  }, [hash]);

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

  const unsaved = diffOf(draft, viewOf(saved)) !== null;

  /*
    Publish the draft to the rest of the page.

    The preview, the truncation warning and the Packaging tab's ratio are all
    about these fields and none of them is inside this block. They read what is
    being typed, not what was last saved — a preview of the saved title while a
    new one is on screen would be a preview of the wrong thing. The one-way
    publish keeps this block the only owner of the draft; see
    `components/preview/live-packaging.tsx`.
  */
  usePublishPackagingDraft({
    title: draft.title,
    thumbnailConcept: conceptForColumn(draft.thumbnailConcept),
    candidates: draft.candidates,
    chosenHooks: status.chosenHooks,
    skipped: saved.packagingSkippedAt !== null,
  });

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

  /*
    A skip is not a separate write path.

    It used to call `send({ packagingSkip })` on its own, which meant the answer
    — a row that knows nothing about the concept typed thirty seconds earlier
    while the connection was down — came back and overwrote the editor with it.
    Folding the outstanding diff into the same patch means the skip carries
    whatever is unsaved with it, exactly like every other edit on the block.
  */
  const skip = (reason: string) => push(draft, { packagingSkip: { reason } });
  const unskip = () => push(draft, { packagingSkip: null });

  /* -------------------------------------------------------------- render -- */

  return (
    <section
      id={PACKAGING_ANCHOR}
      data-testid="packaging-block"
      aria-labelledby="packaging-heading"
      className="flex scroll-mt-4 flex-col gap-4 rounded-card border border-border p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="packaging-heading" className="text-sm font-semibold">
          Packaging — the gate
        </h2>
        <p className="text-xs text-muted">
          Title, thumbnail concept and hook — decided here, before a word of
          script is written. About a fifth of the work, and most of the result.
          Nothing leaves Packaging until these three are filled in or the gate
          is deliberately skipped.
        </p>
      </div>

      <GateIndicator
        status={status}
        unsaved={unsaved}
        skipReason={saved.packagingSkipReason}
      />

      <WorkingTitle
        anchorId={GATE_ANCHOR.title}
        value={draft.title}
        onChange={(title) => edit({ ...draft, title })}
        onCommit={() => commit(draft)}
      />

      <TitleCandidates
        candidates={draft.candidates}
        issue={candidateIssue}
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

      <AssistRow>{assist?.candidates}</AssistRow>

      {/* What the feed would cut, under the list it is about. */}
      {titleWarning}

      {/*
        Concept and reference, as one thing.

        `videos.thumbnail_concept` (written, left) is what the gate reads;
        `videos.thumbnail_concept_path` (uploaded, right) is a picture to look
        at while writing it. Two columns on a wide screen, stacked on a phone,
        one heading over both — so the sketch reads as *support for* the
        concept and never as a rival field that might also satisfy the gate.
      */}
      <div
        data-testid="thumbnail-pair"
        className="grid items-start gap-4 rounded-card border border-border/60 bg-surface/40 p-3 md:grid-cols-2"
      >
        <ThumbnailConcept
          anchorId={GATE_ANCHOR.thumbnail_concept}
          value={draft.thumbnailConcept}
          maxLength={MAX_CONCEPT_LENGTH}
          onChange={(thumbnailConcept) => edit({ ...draft, thumbnailConcept })}
          onCommit={() => commit(draft)}
        />
        {sketch}
      </div>

      <AssistRow>{assist?.concept}</AssistRow>

      <HooksEditor
        anchorId={GATE_ANCHOR.hook}
        hooks={draft.hooks}
        issue={hookIssue}
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

      <AssistRow>{assist?.hooks}</AssistRow>

      <SaveStatus state={saveState} testId="packaging-save-status" onRetry={send} />

      <SkipPackaging
        anchorId={SKIP_ANCHOR}
        focusRequest={skipRequest}
        skippedAt={saved.packagingSkippedAt}
        skipReason={saved.packagingSkipReason}
        onSkip={skip}
        onUnskip={unskip}
      />
    </section>
  );
}
