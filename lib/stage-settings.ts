import { z } from "zod";

import { kindOrder, type StageKind } from "./defaults";
import { moved, nameTaken, type MoveDirection } from "./ordering";
import { cleanLabel } from "./text";

// The order arithmetic and the name check are `lib/ordering.ts`'s, shared
// with the bucket and template editors; re-exported so this module stays the
// one import a stages screen needs.
export { moved, nameTaken, type MoveDirection };

/**
 * Everything about editing a channel's stages that is a rule rather than a
 * screen: what a stage may be called, which moves the order allows, what each
 * core kind *does* (so the settings screen can say it in a line of prose), and
 * the sentences a refusal is made of.
 *
 * Nothing in this file writes anything. `app/actions/stages.ts` applies these
 * rules on the server before calling the SQL functions in
 * `0007_stage_settings.sql`, which apply the load-bearing ones again — the
 * order rule and the occupancy rule are the database's, and this module is how
 * the screen knows what the database will say before it says it.
 *
 * ## The invariant this whole milestone rests on
 *
 * Behaviour binds to `kind` and to `CORE_KIND_ORDER`, never to `position` and
 * never to `name`. A stage's name is a label: renaming Packaging to "Packaging
 * & hook" changes the board's column heading, the stage select's option, the
 * gate refusal's "could not move to X" and nothing else, because the gate
 * itself compares `array_position(k_order, kind)` inside `move_video`. The
 * settings screen therefore treats the name as the one edit with no
 * consequences, and treats the *order* as the one edit with a rule: a core
 * stage never crosses another core stage, because the pipeline is a pipeline
 * and `position` is only how it is drawn.
 */

/* -------------------------------------------------------------------------- */
/* The name                                                                    */
/* -------------------------------------------------------------------------- */

/** Long enough for "Packaging (TTH)" twice over; short enough for a column heading. */
export const STAGE_NAME_MAX = 40;

export const StageNameSchema = z
  .string({ error: "A stage needs a name." })
  // Format characters (zero-width space, BOM, …) draw nothing, so a name made
  // of them is no name; `cleanLabel` removes them before the length rule
  // runs, and `has_visible_text()` refuses them again in the database.
  .transform(cleanLabel)
  .pipe(
    z
      .string()
      .min(1, "A stage needs a name — a column with no heading is one nobody can find.")
      .max(STAGE_NAME_MAX, `Keep a stage name under ${STAGE_NAME_MAX} characters; it is a column heading.`),
  );

/* -------------------------------------------------------------------------- */
/* The order                                                                   */
/* -------------------------------------------------------------------------- */

/** The least a stage has to be for the order rules to judge it. */
export interface OrderedStage {
  readonly id: string;
  readonly name: string;
  /** Null for a user-added, inert stage. */
  readonly kind: StageKind | null;
}

/**
 * True when the core stages in `stages`, read in display order, are in
 * `CORE_KIND_ORDER`. Inert stages are skipped: they may sit anywhere.
 */
export function coreOrderHolds(stages: readonly OrderedStage[]): boolean {
  let previous = -1;
  for (const stage of stages) {
    if (stage.kind === null) continue;
    const order = kindOrder(stage.kind);
    if (order < previous) return false;
    previous = order;
  }
  return true;
}

export type MoveVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Why not, in a sentence the button can carry as its title. */
      readonly reason: string;
    };

/**
 * Whether the stage at `index` may move one step in `direction`.
 *
 * The rule is stated on the *result*, not on the pair: the move is refused
 * when the list after it would have a core stage before another core stage
 * that `CORE_KIND_ORDER` puts first. For an adjacent swap on a list whose
 * order already holds, that is the same as "both are core"; stated this way
 * it stays true on a list whose order does not hold (a hand-edited database)
 * and it is the same sentence the SQL function speaks.
 */
export function canMove(
  stages: readonly OrderedStage[],
  index: number,
  direction: MoveDirection,
): MoveVerdict {
  const stage = stages[index];
  if (!stage) return { ok: false, reason: "That stage is not in this list." };

  const next = moved(stages, index, direction);
  if (next === null) {
    return {
      ok: false,
      reason:
        direction === "up"
          ? `${stage.name} is already first.`
          : `${stage.name} is already last.`,
    };
  }

  if (coreOrderHolds(next)) return { ok: true };

  // Name the pair that would cross, in the order they have to keep.
  const other = stages[direction === "up" ? index - 1 : index + 1];
  const [first, second] =
    stage.kind !== null && other.kind !== null && kindOrder(stage.kind) < kindOrder(other.kind)
      ? [stage, other]
      : [other, stage];
  return {
    ok: false,
    reason: `Core stages keep their order: ${first.name} stays before ${second.name}.`,
  };
}

/* -------------------------------------------------------------------------- */
/* What each kind does                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One line per core kind, stating the behaviour that is bound to it — the
 * sentence the settings screen prints under the name so that "rename" is
 * visibly not "change what it does". Every claim here is a claim about code
 * elsewhere, and the file that makes it good is named in the comment.
 */
export const KIND_NOTES: Readonly<Record<StageKind, string>> = {
  // capture_video (0005) always lands a new video here; the board caps the
  // column at ten (components/board/board.tsx); /now skips ideas entirely.
  idea: "Where capture lands, so it stays on the board. The board shows the ten most recent; the rest are in Ideas. Never on /now.",
  // move_video's gate compares kind order against 'packaging'.
  packaging:
    "The TTH gate — title, thumbnail concept, hook. Leaving here for any later stage needs a title, a thumbnail concept and one chosen hook — or a typed reason to skip.",
  // move_video fills the script from the channel template on first entry.
  scripting: "On first entry the script is filled from the channel's template, with the chosen hook.",
  // lib/filming-data.ts counts filming-kind stages across every channel.
  filming: "Counts towards the batch-day badge, across every channel. /now marks its rows as needing a block.",
  editing: "/now marks its rows as needing a block, so the ten-minute filter hides them.",
  // app/actions/moves.ts: the soft warning on entry to a scheduled stage.
  publish_prep: "Moving on from here with fewer than three thumbnail variants is a soft warning, not a refusal.",
  scheduled: "Waits on the target publish date; on the day, /now asks you to confirm it went live.",
  // move_video stamps published_at on first entry; /now rule 2 counts from it.
  published: "Stamps the publish time. Twenty-four hours later /now asks for impressions and CTR.",
  repurposed: "The optional lane. Terminal: nothing comes after it, and nothing warns when it fills up.",
};

/** What an inert stage is, said once so every row says the same thing. */
export const INERT_NOTE =
  "Added by you. It has a column, can hold videos, and its checklist template is copied like any other stage's — but no behaviour: no gate, no badge, and /now's “move to next stage” never points at it.";

/* -------------------------------------------------------------------------- */
/* The refusals                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where the videos that block a switch-off are: the board column, or the idea
 * bank for the Idea stage, whose column only ever shows ten of them.
 */
export function occupiedHref(kind: StageKind | null, slug: string): string {
  return kind === "idea" ? `/c/${slug}/ideas` : `/c/${slug}/board`;
}

/** The sentence `setStageEnabled` refuses with, given the count. */
export function occupiedSentence(name: string, count: number): string {
  const them = count === 1 ? "it" : "them";
  const what = count === 1 ? "a video" : `${count} videos`;
  return `${name} still holds ${what}. Move ${them} on or archive ${them} first — switching the stage off would hide ${them} from the board and from /now.`;
}

/** `set_stage_enabled` raises `occupied:<n>`; this reads the n back out. */
export function readOccupied(message: string): number | null {
  const match = /occupied:(\d+)/.exec(message);
  return match ? Number(match[1]) : null;
}

/** `set_stage_enabled` raises `idea stage: …` when asked to switch the Idea stage off. */
export function isIdeaStageRefusal(message: string): boolean {
  return /^idea stage:/.test(message);
}

/** The sentence for it. Capture must always have a column to land in. */
export function ideaStaysOnSentence(name: string): string {
  return `${name} is where capture lands, so it stays on the board — every new idea needs a column to arrive in.`;
}

/**
 * A switched-off stage that still holds live videos — a state no screen can
 * reach since 0008, and the one a hand-edited row can. Said on the row, with
 * the link, so it is never only a number beside "Off".
 */
export function hiddenVideosSentence(name: string, count: number): string {
  const what = count === 1 ? "a video" : `${count} videos`;
  const them = count === 1 ? "it" : "them";
  return `${name} is switched off but still holds ${what}, hidden from the board and from /now. Switch it on to see ${them}, or move ${them} from the video page.`;
}

/** `reorder_stages` raises `core order: …`; the sentence is already for people. */
export function readCoreOrderRefusal(message: string): string | null {
  const match = /core order: (.+)$/.exec(message);
  return match ? `Core stages keep their order: ${match[1]}.` : null;
}
