/**
 * Seed data applied when a channel is created (PLAN.md "Seed data (on channel creation)").
 *
 * Everything here is plain, typed data: no imports, no side effects. The SQL
 * seeding path, the dev seed script and the settings UI all read from this file
 * so there is exactly one copy of the defaults.
 *
 * The checklist text is copied verbatim from BRIEF.md "Seed checklist templates".
 * Do not reword it; it is the product.
 */

/* -------------------------------------------------------------------------- */
/* Stage kinds                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The nine core stage kinds, in behavioural order.
 *
 * This list — never `stages.position` — is what code compares when it needs to
 * know whether one stage comes before another (the TTH gate, "move to next
 * stage", the WIP warning). `position` is display order only, and user-added
 * stages have `kind = null` and are inert.
 */
export const CORE_KIND_ORDER = [
  'idea',
  'packaging',
  'scripting',
  'filming',
  'editing',
  'publish_prep',
  'scheduled',
  'published',
  'repurposed',
] as const;

export type StageKind = (typeof CORE_KIND_ORDER)[number];

/** Position of a kind in `CORE_KIND_ORDER` (0-based). */
export function kindOrder(kind: StageKind): number {
  return CORE_KIND_ORDER.indexOf(kind);
}

/**
 * Comparator over stage kinds: negative when `a` comes before `b`, zero when
 * they are the same kind, positive when `a` comes after `b`. Usable directly as
 * an `Array.prototype.sort` comparator.
 */
export function compareKinds(a: StageKind, b: StageKind): number {
  return kindOrder(a) - kindOrder(b);
}

/** True when `value` is one of the nine core kinds (e.g. a `kind` column read back as text). */
export function isStageKind(value: unknown): value is StageKind {
  return (
    typeof value === 'string' &&
    (CORE_KIND_ORDER as readonly string[]).includes(value)
  );
}

/**
 * Kinds the WIP threshold warning applies to: the in-flight stages, packaging
 * through scheduled. Idea (a bank, not a queue), Published and Repurposed
 * (terminal) must never warn.
 */
export const WIP_KINDS = [
  'packaging',
  'scripting',
  'filming',
  'editing',
  'publish_prep',
  'scheduled',
] as const satisfies readonly StageKind[];

export type WipKind = (typeof WIP_KINDS)[number];

export function isWipKind(kind: StageKind): kind is WipKind {
  return (WIP_KINDS as readonly StageKind[]).includes(kind);
}

/* -------------------------------------------------------------------------- */
/* Stages                                                                      */
/* -------------------------------------------------------------------------- */

export interface SeedStage {
  readonly name: string;
  readonly kind: StageKind;
  /** 1-based display order; seeded to match `CORE_KIND_ORDER`. */
  readonly position: number;
}

/** The nine default stages, all seeded with `is_enabled = true`. */
export const SEED_STAGES = [
  { name: 'Idea', kind: 'idea', position: 1 },
  { name: 'Packaging (TTH)', kind: 'packaging', position: 2 },
  { name: 'Scripting', kind: 'scripting', position: 3 },
  { name: 'Filming', kind: 'filming', position: 4 },
  { name: 'Editing', kind: 'editing', position: 5 },
  { name: 'Publish Prep', kind: 'publish_prep', position: 6 },
  { name: 'Scheduled', kind: 'scheduled', position: 7 },
  { name: 'Published', kind: 'published', position: 8 },
  { name: 'Repurposed', kind: 'repurposed', position: 9 },
] as const satisfies readonly SeedStage[];

/* -------------------------------------------------------------------------- */
/* Checklist templates                                                         */
/* -------------------------------------------------------------------------- */

export interface SeedChecklistItem {
  /** Verbatim from BRIEF.md. */
  readonly text: string;
  /** Rough time to do it; `checklist_items.est_minutes` null reads as 10. */
  readonly est_minutes: number;
}

/**
 * Default checklist rows per stage kind. Array order is the seeded `position`
 * (1-based: the first item is position 1).
 *
 * Idea and Scheduled have no template: an idea is captured, not worked, and a
 * scheduled video is waiting on a date, not on a task.
 */
export const SEED_CHECKLISTS = {
  idea: [],

  packaging: [
    { text: 'Generated 10–20 title candidates, not 3', est_minutes: 15 },
    { text: 'Chosen title sells the *result*, not the content', est_minutes: 5 },
    {
      text: "Title creates curiosity (a viewer can't just nod and scroll)",
      est_minutes: 5,
    },
    { text: 'Title under 55 characters', est_minutes: 5 },
    {
      text: "Searched YouTube for this topic — checked what's already working",
      est_minutes: 15,
    },
    {
      text: 'Thumbnail concept complements the title (adds something) rather than repeating it',
      est_minutes: 5,
    },
    {
      text: 'Thumbnail concept still readable at phone-tile size',
      est_minutes: 5,
    },
    { text: 'Hook drafted in 3 versions, strongest picked', est_minutes: 15 },
  ],

  scripting: [
    {
      text: 'Hook scripted word-for-word (rest can be bullets)',
      est_minutes: 20,
    },
    {
      text: "Hook delivers on the title's promise within ~15 seconds",
      est_minutes: 10,
    },
    {
      text: 'No "welcome back to the channel" preamble before the hook',
      est_minutes: 10,
    },
    {
      text: 'Structure picked (listicle / 3-part / story arc)',
      est_minutes: 10,
    },
    { text: 'Scanned for repetition — cut restated points', est_minutes: 15 },
    {
      text: 'Each point goes one level deeper than the obvious',
      est_minutes: 15,
    },
    { text: 'Something new lands every 10–15 seconds', est_minutes: 10 },
    {
      text: 'End screen points at a specific named video (never "thanks for watching")',
      est_minutes: 10,
    },
    {
      text: 'B-roll planned per section; first 30s aims for a shot change every 1–1.5s',
      est_minutes: 15,
    },
  ],

  filming: [
    {
      text: "Outline visible while filming (don't rely on memory)",
      est_minutes: 5,
    },
    {
      text: 'Thumbnail shots captured (matches the locked concept)',
      est_minutes: 15,
    },
    {
      text: 'Shirt change if batching (so thumbnails look like different days)',
      est_minutes: 5,
    },
    { text: 'Footage backed up to cloud', est_minutes: 30 },
  ],

  editing: [
    {
      text: 'First 30 seconds got disproportionate attention',
      est_minutes: 60,
    },
    { text: 'Dead stretches cut', est_minutes: 60 },
    {
      text: "Re-voiceover / rephrase anything that doesn't land in the edit",
      est_minutes: 30,
    },
    {
      text: 'Editor feedback round complete (if outsourced)',
      est_minutes: 30,
    },
  ],

  publish_prep: [
    {
      text: '3 thumbnail variants ready (wild card / moderate / safe)',
      est_minutes: 60,
    },
    {
      text: 'Description written; affiliate + standard links present',
      est_minutes: 20,
    },
    { text: 'Chapters set', est_minutes: 10 },
    { text: 'End screen linked to the planned next video', est_minutes: 10 },
    { text: 'Upload defaults applied', est_minutes: 5 },
  ],

  scheduled: [],

  published: [
    {
      text: 'Check first 24h: impressions AND CTR together, plus new-viewer share',
      est_minutes: 5,
    },
    {
      text: "Swap thumbnail if underperforming vs expectation — act fast, don't wait days",
      est_minutes: 10,
    },
  ],

  repurposed: [
    { text: '2–3 short clips cut', est_minutes: 60 },
    { text: 'Posted to Shorts / Reels / TikTok', est_minutes: 15 },
    { text: 'Newsletter or written version (if applicable)', est_minutes: 45 },
  ],
} as const satisfies Record<StageKind, readonly SeedChecklistItem[]>;

/* -------------------------------------------------------------------------- */
/* Buckets                                                                     */
/* -------------------------------------------------------------------------- */

export type BucketAxis = 'vertical' | 'horizontal';

export interface SeedBucket {
  readonly axis: BucketAxis;
  readonly name: string;
  /** 1-based display order within the axis. */
  readonly position: number;
}

/**
 * Seeded buckets: the brief's eight format horizontals, named verbatim and so
 * lowercase (BRIEF.md "tutorial, listicle, review, self-experiment, vlog,
 * reaction, case study, interview"; the user renames them in settings).
 * Verticals are left empty on purpose — they are the channel's own topic pillars, and settings
 * prompts for 3–5 of them.
 */
export const SEED_BUCKETS: readonly SeedBucket[] = [
  { axis: 'horizontal', name: 'tutorial', position: 1 },
  { axis: 'horizontal', name: 'listicle', position: 2 },
  { axis: 'horizontal', name: 'review', position: 3 },
  { axis: 'horizontal', name: 'self-experiment', position: 4 },
  { axis: 'horizontal', name: 'vlog', position: 5 },
  { axis: 'horizontal', name: 'reaction', position: 6 },
  { axis: 'horizontal', name: 'case study', position: 7 },
  { axis: 'horizontal', name: 'interview', position: 8 },
];

/* -------------------------------------------------------------------------- */
/* Script template                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Seeded `channels.script_template`. On first entry to Scripting, `move_video`
 * replaces `{{hook}}` with the chosen hook, so the placeholder must survive any
 * edit of this text (settings warns if it is removed).
 */
export const SCRIPT_TEMPLATE = `## Hook (verbatim)

{{hook}}

B-roll: opening shot, change every 1-1.5s for the first 30s

## Body (bullets)

Structure: listicle / 3-part / story arc

-
-
-

B-roll: one cutaway per bullet

## End screen → [named video]

Point at one specific video by name, never "thanks for watching".

B-roll: clip from the video being pointed at
`;

/* -------------------------------------------------------------------------- */
/* Channel defaults                                                            */
/* -------------------------------------------------------------------------- */

export interface ChannelDefaults {
  readonly wip_threshold: number;
  readonly stale_days: number;
  /** Null until the creator sets one; `/now` then falls back to the channel median. */
  readonly expected_ctr: number | null;
  readonly voice_guide: string | null;
}

export const CHANNEL_DEFAULTS: ChannelDefaults = {
  wip_threshold: 5,
  stale_days: 7,
  expected_ctr: null,
  voice_guide: null,
};
