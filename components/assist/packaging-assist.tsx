"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { Hook, TitleCandidate } from "@/lib/packaging";

import type { StoredAssistKind } from "./stored";

/**
 * The seam between the brainstorm panel and the packaging block.
 *
 * ## Why the panel does not write anything itself
 *
 * `components/packaging/packaging-block.tsx` owns the packaging draft, the
 * diff, the one save queue and the one `updateVideo` call. A panel that called
 * `updateVideo` on its own would be a *second* write path over the same four
 * columns: two patches in flight, each carrying absolute values, and a save
 * status line that knows about one of them. Seven milestones of reviewers have
 * policed the rule that there is one queue; accepting a suggestion is an
 * ordinary packaging edit and goes through the ordinary packaging edit.
 *
 * So the block passes its own `addCandidates` / `addHook` down through this
 * context, and the panel — which is handed to the block as a slot element from
 * a server component, and so cannot receive props from it — reads them here.
 * The block never imports the panel and the panel never imports the block.
 *
 * ## Why the open state lives here too
 *
 * There are two ways into the same panel: the pill beside the candidate list
 * and the pill beside the hooks. One panel, one answer, one stored
 * `brainstorm_last` — two panels showing the same suggestions would be two
 * places to accept the same title twice.
 */

/** What happened when a batch of suggestions was accepted. */
export interface AcceptOutcome {
  readonly added: number;
  /** Skipped because the candidate list already says the same thing. */
  readonly duplicates: number;
  /** Skipped because the list is at its ceiling. */
  readonly noRoom: number;
}

export interface AssistTarget {
  readonly candidates: readonly TitleCandidate[];
  readonly hooks: readonly Hook[];
  /** `videos.thumbnail_concept` as the draft has it — the written concept. */
  readonly concept: string;
  /** How many more candidates the list can take before its ceiling. */
  readonly candidateRoom: number;
  /** How many more hooks the column can take. Three is a CHECK, not a habit. */
  readonly hookRoom: number;
  /**
   * Add suggestions as candidates, in one edit and therefore one save.
   * Duplicates and overflow are reported, never silently dropped.
   */
  addCandidates(items: readonly { text: string; note?: string }[]): AcceptOutcome;
  /** Add one suggestion as a hook, or say why it could not be added. */
  addHook(text: string): { ok: boolean; reason: string | null };
  /**
   * Take a proposed thumbnail concept — the one acceptance that *replaces*.
   *
   * The concept is a single field rather than a list, so accepting a proposal
   * overwrites whatever is in it, which may be a sentence the person wrote.
   * `previous` comes back for exactly that reason: the control that called
   * this offers it as an undo for as long as its panel is open. Refusals are
   * the field's own rules — blank, over the column's cap, or the same text
   * that is already there.
   */
  acceptConcept(text: string): {
    ok: boolean;
    previous: string;
    reason: string | null;
  };
  /**
   * Put a previous concept back, verbatim, including an empty one.
   *
   * Separate from `acceptConcept` because an undo is not an acceptance: it
   * restores a value that was already the person's, it is allowed to be blank,
   * and it must not be refused for being a duplicate of something.
   */
  restoreConcept(text: string): void;
}

interface PanelControl {
  readonly open: boolean;
  /** Which question the panel is on: twenty titles, or three spoken hooks. */
  readonly kind: StoredAssistKind;
  /** Increments on every open request, so the panel can re-focus itself. */
  readonly nonce: number;
  /** Open (or re-aim) the panel. Bumps the nonce. */
  show(kind: StoredAssistKind): void;
  /**
   * What a pill presses: open the panel *and*, if there is nothing to show,
   * ask. The component that owns the answers registers itself below; until it
   * has, this is just `show`, so a pill can never be a button that does nothing.
   */
  request(kind: StoredAssistKind): void;
  /**
   * The panel's owner registers how to open-and-ask, and unregisters on
   * unmount. A ref rather than state: the two pills are siblings, only one of
   * them holds the conversation with the server, and the other still has to be
   * able to start it.
   */
  register(open: (kind: StoredAssistKind) => void): () => void;
  /** Switch question without re-opening: the panel's own tabs. */
  setKind(kind: StoredAssistKind): void;
  hide(): void;
}

const TargetContext = createContext<AssistTarget | null>(null);
const PanelContext = createContext<PanelControl | null>(null);

export function PackagingAssistProvider({
  target,
  children,
}: {
  target: AssistTarget;
  children: ReactNode;
}) {
  const [state, setState] = useState<{
    open: boolean;
    kind: StoredAssistKind;
    nonce: number;
  }>({ open: false, kind: "titles", nonce: 0 });

  const show = useCallback((kind: StoredAssistKind) => {
    setState((previous) => ({ open: true, kind, nonce: previous.nonce + 1 }));
  }, []);

  const setKind = useCallback((kind: StoredAssistKind) => {
    setState((previous) => ({ ...previous, kind }));
  }, []);

  const hide = useCallback(() => {
    setState((previous) => ({ ...previous, open: false }));
  }, []);

  const opener = useRef<((kind: StoredAssistKind) => void) | null>(null);

  const register = useCallback((open: (kind: StoredAssistKind) => void) => {
    opener.current = open;
    return () => {
      if (opener.current === open) opener.current = null;
    };
  }, []);

  const request = useCallback(
    (kind: StoredAssistKind) => {
      const open = opener.current;
      if (open) open(kind);
      else show(kind);
    },
    [show],
  );

  const panel = useMemo<PanelControl>(
    () => ({
      open: state.open,
      kind: state.kind,
      nonce: state.nonce,
      show,
      request,
      register,
      setKind,
      hide,
    }),
    [hide, register, request, setKind, show, state.kind, state.nonce, state.open],
  );

  return (
    <TargetContext.Provider value={target}>
      <PanelContext.Provider value={panel}>{children}</PanelContext.Provider>
    </TargetContext.Provider>
  );
}

/**
 * The packaging fields, as something to write into.
 *
 * Returns `null` outside the provider rather than throwing: the assist slots
 * are optional, and a page that renders one without the block around it should
 * show a disabled control, not a crashed section.
 */
export function useAssistTarget(): AssistTarget | null {
  return useContext(TargetContext);
}

export function useAssistPanel(): PanelControl | null {
  return useContext(PanelContext);
}
