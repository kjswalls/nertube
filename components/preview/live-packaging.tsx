"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * What the packaging editor currently holds, published to the parts of the page
 * that are *about* it rather than in it.
 *
 * ## Why a context and not a prop
 *
 * Three things on this page have to know the title as it is being typed: the
 * preview (that is the whole point of a preview), the truncation warning, and
 * the readiness ratio on the Packaging tab. None of them is inside the
 * packaging block, and none of them can be handed a callback by the page —
 * `/videos/[id]` is a Server Component and functions do not cross that
 * boundary.
 *
 * So the block publishes, and whoever cares subscribes. The alternative — the
 * page passing a render prop — is not available; the alternative after that —
 * the preview reading the input's value out of the DOM — would be a second
 * source of truth for the draft, which is the bug this application has spent
 * two milestones not having.
 *
 * ## The fallback is the row, not an empty string
 *
 * Before the block's first effect runs there is no draft, and consumers read
 * `null`. Every one of them falls back to the value the *server* rendered, so
 * the first paint shows the saved title rather than a blank frame that fills in
 * a moment later.
 */

/** The packaging fields the rest of the page renders something about. */
export interface PackagingDraft {
  /** `videos.title` as typed — the title the preview draws. */
  readonly title: string;
  /** The written concept, trimmed to null the way the column stores it. */
  readonly thumbnailConcept: string | null;
  /** The candidate list, as typed. The warning measures every one of them. */
  readonly candidates: readonly { readonly id: string; readonly text: string; readonly chosen: boolean }[];
  /** How many hooks are ticked. The gate wants exactly one. */
  readonly chosenHooks: number;
  /** Has the gate been deliberately skipped? */
  readonly skipped: boolean;
}

const DraftContext = createContext<PackagingDraft | null>(null);

type Publish = (draft: PackagingDraft | null) => void;

/** Separate from the value so publishing does not re-render the publisher. */
const PublishContext = createContext<Publish>(() => {});

/** Wraps the whole video page; see the note on `PackagingDraft`. */
export function PackagingLiveProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<PackagingDraft | null>(null);

  return (
    <PublishContext.Provider value={setDraft}>
      <DraftContext.Provider value={draft}>{children}</DraftContext.Provider>
    </PublishContext.Provider>
  );
}

/**
 * Publish the editor's current draft. Called by the packaging block, once.
 *
 * In an effect rather than during render because a component may not set
 * another component's state while rendering. The cost is that consumers are one
 * commit behind the input — which is a frame, before paint in practice, and
 * nowhere near perceptible while typing.
 *
 * The draft is `useMemo`'d on its own fields so that a re-render which changed
 * nothing about packaging does not re-publish and re-measure.
 */
export function usePublishPackagingDraft(draft: PackagingDraft): void {
  const publish = useContext(PublishContext);

  const stable = useMemo(
    () => draft,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      draft.title,
      draft.thumbnailConcept,
      draft.candidates,
      draft.chosenHooks,
      draft.skipped,
    ],
  );

  useEffect(() => {
    publish(stable);
  }, [publish, stable]);

  // Unmount only — deliberately a second effect. Clearing in the first one's
  // cleanup would publish `null` between every two keystrokes, and every
  // consumer would fall back to the server's title for that commit: a preview
  // that flickered back to the saved value while being typed into.
  useEffect(() => {
    return () => publish(null);
  }, [publish]);
}

/** The live draft, or `null` before the editor has published one. */
export function usePackagingDraft(): PackagingDraft | null {
  return useContext(DraftContext);
}
