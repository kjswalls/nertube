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
  /** `videos.published_at`. */
  readonly published: boolean;
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

  const thumbnails: SectionReadiness = !reached(facts.stageKind, "editing")
    ? { kind: "locked", why: "Not at Editing yet, and thumbnail roles arrive in M4." }
    : { kind: "locked", why: "Thumbnail roles and the swap log arrive in M4." };

  const schedule: SectionReadiness = facts.targetDateSet
    ? { kind: "done", why: "A target publish date is set." }
    : { kind: "quiet", why: "No target publish date yet." };

  const publish: SectionReadiness = !facts.published
    ? { kind: "locked", why: "Not published yet, and the post-publish block arrives in M4." }
    : { kind: "locked", why: "The 24-hour metrics and the swap prompt arrive in M4." };

  return { packaging, script, thumbnails, schedule, publish };
}

/** `videos.stage.kind` as read from the row, without trusting it to be a kind. */
export function stageKindOf(value: unknown): StageKind | null {
  return isStageKind(value) ? value : null;
}
