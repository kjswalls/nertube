import { compareKinds, isStageKind, type StageKind } from "@/lib/defaults";

/**
 * The video page's sections: what they are, which is showing, and what each one
 * says about itself on its tab.
 *
 * Pure and dependency-free on purpose — the server reads the URL with it, the
 * nav renders with it, and the client shell routes with it, so all three agree
 * about what `?section=script` means without any of them importing the others.
 *
 * ## Why the tab carries a state at all
 *
 * A row of five labels is a filing cabinet: the only way to find out whether
 * there is anything to do behind "Thumbnails" is to open it. The point of this
 * page is the opposite — the user has eight videos in flight and ten minutes,
 * so every tab says what it is holding before it is opened: how much of it is
 * done, a tick when it is finished, or a lock when the video has not got there
 * yet and there is genuinely nothing to decide.
 *
 * The lock never *blocks*. Packaging an idea before it is in Packaging is a
 * perfectly ordinary thing to do, and a tab that refused to open would be the
 * tool arguing with the user about their own process. It says "not yet", and
 * opens.
 */

/** The `?section=` key. One place, so the page and the nav cannot disagree. */
export const SECTION_PARAM = "section";

export interface VideoSectionDef {
  readonly id: string;
  /** The word on the tab. */
  readonly label: string;
  /**
   * The stage this section belongs to, or null when it belongs to no single
   * one. Reaching that stage is what unlocks the tab.
   */
  readonly kind: StageKind | null;
}

export const VIDEO_SECTIONS = [
  { id: "packaging", label: "Packaging", kind: null },
  { id: "script", label: "Script", kind: "scripting" },
  { id: "thumbnails", label: "Thumbnails", kind: "editing" },
  { id: "schedule", label: "Schedule", kind: null },
  { id: "publish", label: "Publish", kind: "published" },
] as const satisfies readonly VideoSectionDef[];

export type VideoSectionId = (typeof VIDEO_SECTIONS)[number]["id"];

/** Where the page opens when the URL says nothing: the gate, always. */
export const DEFAULT_SECTION: VideoSectionId = "packaging";

const IDS = VIDEO_SECTIONS.map((section) => section.id) as readonly string[];

export function isSectionId(value: unknown): value is VideoSectionId {
  return typeof value === "string" && IDS.includes(value);
}

/**
 * `?section=` as a section, tolerantly.
 *
 * A URL is typed by people and pasted by tools: `?section=` twice over, a
 * misspelling, a leftover from a renamed section. None of those is worth a 404
 * on a page that has a perfectly good default, so anything unrecognised opens
 * the gate — the same place a bare `/videos/[id]` opens.
 */
export function parseSection(raw: string | string[] | undefined): VideoSectionId {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return isSectionId(value) ? value : DEFAULT_SECTION;
}

/**
 * The href for a section. The default section is the bare URL, so the address
 * bar does not fill up with a parameter that says what it would have done
 * anyway, and so `/videos/x` and `/videos/x?section=packaging` are one page
 * rather than two links to it.
 */
export function sectionHref(pathname: string, id: VideoSectionId): string {
  return id === DEFAULT_SECTION ? pathname : `${pathname}?${SECTION_PARAM}=${id}`;
}

/* -------------------------------------------------------------------------- */
/* Readiness                                                                   */
/* -------------------------------------------------------------------------- */

export type SectionReadiness =
  /** `2/3`, drawn in the mono face because it is a measured value. */
  | { readonly kind: "ratio"; readonly done: number; readonly total: number; readonly why: string }
  /** A tick: everything this section wants is there. */
  | { readonly kind: "done"; readonly why: string }
  /** A lock: the video has not reached this stage, or the section is not built. */
  | { readonly kind: "locked"; readonly why: string }
  /** Nothing to say. No mark, no colour, no noise. */
  | { readonly kind: "quiet"; readonly why: string };

/** Everything the five tabs need to know about the row. */
export interface SectionFacts {
  /** The current stage's kind, or null for a user-added (inert) stage. */
  readonly stageKind: StageKind | null;
  /** The gate's three fields, as they stand *right now* (draft, not row). */
  readonly titleFilled: boolean;
  readonly conceptFilled: boolean;
  readonly chosenHooks: number;
  readonly packagingSkipped: boolean;
  /** `videos.script` — filled by `move_video` on first entry to Scripting. */
  readonly scriptFilled: boolean;
  /** `videos.target_publish_date`. */
  readonly targetDateSet: boolean;
  /**
   * How many of the three thumbnail slots hold an image, and whether one of
   * them is live (`videos.shipped_role`).
   *
   * Optional so that a caller which has not read those columns — a test
   * fixture, a future surface — reads as zero rather than having to say so.
   */
  readonly variantsReady?: number;
  readonly thumbnailShipped?: boolean;
  /** `videos.published_at`. */
  readonly published: boolean;
  /**
   * `videos.metrics_logged_at`, and whether the thumbnail question that follows
   * it has been answered — by "keep it" (`swap_dismissed_at`) or by a swap
   * logged since.
   *
   * Optional for the same reason the thumbnail facts are: a caller that has not
   * read those columns reads as "not yet" rather than having to say so.
   */
  readonly metricsLogged?: boolean;
  readonly swapDecided?: boolean;
}

/** Has this video reached the stage a section belongs to? */
function reached(stageKind: StageKind | null, sectionKind: StageKind | null): boolean {
  if (sectionKind === null) return true;
  // An inert stage (`kind = null`) has no place in the order, so nothing can be
  // said about what it has passed. Locking every tab on such a video would be a
  // guess dressed up as a fact; the tabs stay open and say nothing.
  if (stageKind === null) return true;
  return compareKinds(stageKind, sectionKind) >= 0;
}

/**
 * What each tab says, from one row.
 *
 * Kept as one function over a fact bag rather than a method per section so that
 * "what does the nav claim" is a single thing to read, and so the packaging
 * ratio can be recomputed from the live draft with the identical rule the
 * server used.
 */
export function sectionReadiness(
  facts: SectionFacts,
): Readonly<Record<VideoSectionId, SectionReadiness>> {
  const gateDone =
    (facts.titleFilled ? 1 : 0) +
    (facts.conceptFilled ? 1 : 0) +
    (facts.chosenHooks === 1 ? 1 : 0);

  const packaging: SectionReadiness = facts.packagingSkipped
    ? {
        kind: "quiet",
        why: "The gate was skipped deliberately. The three fields are still worth filling in.",
      }
    : gateDone === 3
      ? { kind: "done", why: "Title, thumbnail concept and one chosen hook: the gate is open." }
      : {
          kind: "ratio",
          done: gateDone,
          total: 3,
          why: `${gateDone} of the gate's three fields are filled in.`,
        };

  const script: SectionReadiness = !reached(facts.stageKind, "scripting")
    ? {
        kind: "locked",
        why: "Not at Scripting yet — the script is written from the channel's template on the way in.",
      }
    : facts.scriptFilled
      ? { kind: "done", why: "The script has something in it." }
      : { kind: "quiet", why: "No script yet." };

  /*
    Thumbnails: how many of the three slots are filled, and whether one is live.

    The tick is reserved for "all three exist *and* one of them is shipped",
    because those are two different pieces of BRIEF.md principle 7 and having
    the assets is only half of it — three images with nothing marked live means
    nobody knows which one is on YouTube. Three filled slots with nothing
    shipped therefore reads 3/3 without a tick, and the tooltip says why.
  */
  const variantsReady = facts.variantsReady ?? 0;
  const thumbnails: SectionReadiness = !reached(facts.stageKind, "editing")
    ? {
        kind: "locked",
        why: "Not at Editing yet — the three image files are made near publish, not at the gate.",
      }
    : variantsReady === 3 && facts.thumbnailShipped === true
      ? { kind: "done", why: "All three variants ready, and one of them is live." }
      : {
          kind: "ratio",
          done: variantsReady,
          total: 3,
          why:
            variantsReady === 3
              ? "All three variants ready — none of them is marked live yet."
              : `${variantsReady} of the three thumbnail variants have an image.`,
        };

  const schedule: SectionReadiness = facts.targetDateSet
    ? { kind: "done", why: "A target publish date is set." }
    : { kind: "quiet", why: "No target publish date yet." };

  /*
    Publish: has this video's first twenty-four hours been written down, and has
    the decision that follows been made?

    The lock is genuine here and not a "not built": before a video is live there
    is nothing to record, and a tab that claimed otherwise would be asking for
    numbers that do not exist. Once it is live the tab counts the two steps of
    BRIEF.md principle 8 — *check first-24h performance, swap thumbnail if
    needed* — because a logged number nobody has decided anything about is
    exactly the state the post-publish loop exists to get out of.

    "Decided" is `swap_dismissed_at` **or** a swap logged since the numbers
    were: keeping the thumbnail and changing it are both answers to the same
    question.

    **The lock lifts at Scheduled, not at Published.** Before this milestone it
    keyed on `published_at` alone, which made the tab read "nothing to do here"
    on exactly the video whose single most actionable control it was holding:
    `/now`'s rule 5 ranks "Confirm live + record URL" as Ready, and that button
    is in this section. A tab cannot say *locked* over the thing the rest of the
    app is asking the user to press. Once a video is Scheduled the section has
    something real in it, so the lock comes off and the tab says nothing until
    there is a number to count — the same treatment an inert stage gets, for the
    same reason: no claim is better than a wrong one.
  */
  const publish: SectionReadiness = !facts.published
    ? !reached(facts.stageKind, "scheduled")
      ? {
          kind: "locked",
          why: "Not live yet — the first twenty-four hours start when it is.",
        }
      : {
          kind: "quiet",
          why: "Scheduled, not live yet — confirming it live and recording the URL happens here.",
        }
    : !facts.metricsLogged
      ? {
          kind: "ratio",
          done: 0,
          total: 2,
          why: "The first twenty-four hours have not been written down yet.",
        }
      : facts.swapDecided
        ? { kind: "done", why: "The first 24 hours are logged and the thumbnail decision is made." }
        : {
            kind: "ratio",
            done: 1,
            total: 2,
            why: "Logged, but nothing has been decided about the thumbnail yet.",
          };

  return { packaging, script, thumbnails, schedule, publish };
}

/** `videos.stage.kind` as read from the row, without trusting it to be a kind. */
export function stageKindOf(value: unknown): StageKind | null {
  return isStageKind(value) ? value : null;
}
