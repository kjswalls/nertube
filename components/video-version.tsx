"use client";

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

/**
 * The version of the row `/videos/[id]` is editing, shared by everything on the
 * page that writes to it.
 *
 * ## The hole this closes
 *
 * Every patch this page sends carries *absolute* values — the whole title, the
 * whole hook list — computed by diffing the editor against a copy of the row it
 * was rendered with. With two tabs open on one video that copy can be minutes
 * stale, and the write is unconditional: tab two adds a hook, PATCHes
 * `hooks: [its own]` over whatever is there, and tab one's hook is gone from the
 * database while still drawn on tab one's screen. Nothing errors, nothing is
 * marked, and the next thing tab one touches deletes tab two's hook in the same
 * way. There is no version column in the schema and no re-read after mount, so
 * neither side can tell.
 *
 * `updated_at` is already stamped by every write on this page and already read
 * by the page's own query, so it is the precondition: a write says which version
 * it was computed against, and the update matches on it. A write against a
 * version the row has moved past touches zero rows, and *that* is reported —
 * "this video changed somewhere else, reload" — instead of landing.
 *
 * ## Why it is one token for the whole page and not one per block
 *
 * Five things on this page write the row: the packaging block, the four flow
 * fields, the archive button, the concept-sketch recorder and `move_video`
 * behind the stage select. All five stamp `updated_at`. A token held per block
 * would go stale the moment a *different* block on the same page wrote, and
 * every save after that would report a conflict that is not one — which is far
 * worse than the bug. So there is one token, seeded from the server render, and
 * every one of those five hands back the `updated_at` its write produced.
 *
 * ## Why the prop is read once
 *
 * A `revalidatePath` from any of those actions re-renders this page on the
 * server and the new `updated_at` arrives as a prop. Adopting it would undo the
 * whole mechanism: an *external* write would hand this tab a fresh token while
 * its editors still hold the old row, and the next save would clobber with the
 * precondition satisfied. The token only ever advances by way of an answer to
 * one of this page's own writes.
 */
export interface VideoVersion {
  /**
   * The `updated_at` this page believes the row holds:
   *
   * - a timestamp — send it as the precondition,
   * - `null` — the row has never been written (`capture_video` leaves the
   *   column NULL), so the precondition is "still NULL",
   * - `undefined` — no provider, so no precondition. Rendering an editor
   *   outside the page is not a reason to refuse its writes.
   */
  readonly peek: () => string | null | undefined;
  /** Record the `updated_at` a write on this page just produced. */
  readonly adopt: (updatedAt: string | null) => void;
  /**
   * Record it only if the row was at this page's version just before that
   * write (`previous`), and say whether it was.
   *
   * For the writes that carry **no** precondition — a stage move, a thumbnail,
   * the concept sketch — which land whatever the row holds. Adopting their
   * answer unconditionally would hand a stale tab a token newer than a write
   * it has never seen, and its next script or packaging save would overwrite
   * that write under a "Saved" line (M10 review). Left stale instead, the next
   * save is refused as "changed somewhere else", which is the truth.
   */
  readonly advance: (previous: string | null, next: string | null) => boolean;
  /**
   * An editor on the page that can be asked to send what it holds and report
   * when its saves have settled. Returns the unregister function.
   */
  readonly register: (settle: () => Promise<boolean>) => () => void;
  /**
   * Ask every registered editor to send what it holds, and wait for all of
   * them: `true` when every save landed. The stage select waits on this before
   * moving, so a move never races the save typed just before it (M10 review:
   * a move back to Packaging that landed first made the script save refused,
   * and the editor unmounted with the text in it).
   */
  readonly settle: () => Promise<boolean>;
}

const NO_VERSION: VideoVersion = {
  peek: () => undefined,
  adopt: () => {},
  advance: () => true,
  register: () => () => {},
  settle: () => Promise.resolve(true),
};

/**
 * Two `updated_at` renderings name the same instant — compared to the
 * microsecond, so a difference in how the offset is spelled (`Z` or
 * `+00:00`) or in trailing zeros does not read as a different version.
 */
export function sameVersion(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  if (a === b) return true;
  return micros(a) === micros(b);
}

function micros(value: string): number | null {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? "";
  const extra = Number((fraction + "000000").slice(3, 6));
  return ms * 1000 + extra;
}

const VideoVersionContext = createContext<VideoVersion>(NO_VERSION);

export function VideoVersionProvider({
  updatedAt,
  children,
}: {
  /** `videos.updated_at` as the server render read it. */
  updatedAt: string | null;
  children: ReactNode;
}) {
  const seen = useRef<string | null>(updatedAt);
  const settlers = useRef(new Set<() => Promise<boolean>>());

  const value = useMemo<VideoVersion>(
    () => ({
      peek: () => seen.current,
      adopt: (next) => {
        seen.current = next;
      },
      advance: (previous, next) => {
        if (!sameVersion(previous, seen.current)) return false;
        seen.current = next;
        return true;
      },
      register: (settle) => {
        settlers.current.add(settle);
        return () => {
          settlers.current.delete(settle);
        };
      },
      settle: async () => {
        const results = await Promise.all(
          [...settlers.current].map((settle) => settle().catch(() => false)),
        );
        return results.every(Boolean);
      },
    }),
    [],
  );

  return (
    <VideoVersionContext.Provider value={value}>
      {children}
    </VideoVersionContext.Provider>
  );
}

export function useVideoVersion(): VideoVersion {
  return useContext(VideoVersionContext);
}
