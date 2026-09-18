import type { CalendarChannel } from "@/components/calendar/grid/types";

/**
 * The short tag every chip carries, and the stripe style behind it.
 *
 * ## Why a tag at all
 *
 * The calendar is the one view in this product that mixes channels on purpose —
 * *"the whole point is seeing the rhythm across both"* — so a row has to say
 * which channel it belongs to, in a cell that is about 150px wide with a title
 * already in it. PLAN.md's answer was "colour per channel". This is not, and
 * the reasoning is in `docs/MILESTONES.md`: in this design colour means
 * *something* (ready, attention, over limit), a calendar is the easiest place
 * in an app to end up with a bag of highlighters, and colour alone fails anyone
 * who cannot separate two hues anyway. So the channel is written down.
 *
 * ## The rules
 *
 * - Initials of the first two words: "Sunday Softworks" → `SS`.
 * - One word: its first two letters, upper-cased: "Nertube" → `NE`.
 * - Collisions take a third letter, then a digit, so two channels never share a
 *   tag — a tag that is not unique is worse than no tag, because it looks like
 *   information.
 * - Order in, order out: the caller's channel order (creation order, the same
 *   order the sidebar numbers `1..9` in) decides the stripe styles too, so a
 *   channel's marks do not move when another one is added after it.
 */
export function tagsFor(
  channels: readonly { id: string; name: string; slug: string }[],
): CalendarChannel[] {
  const taken = new Set<string>();

  return channels.map((channel, index) => ({
    id: channel.id,
    name: channel.name,
    slug: channel.slug,
    tag: uniqueTag(channel.name || channel.slug, taken),
    stripe: index % STRIPE_COUNT,
  }));
}

/** How many distinct stripe styles `stripeClass` can draw. */
export const STRIPE_COUNT = 4;

/**
 * The stripe itself: same colour in every case, different line style.
 *
 * Border *style* rather than border colour, for the reason above. Four is
 * enough for any account this product is for; the fifth channel shares with the
 * first and is still told apart by its tag.
 */
export function stripeClass(stripe: number): string {
  switch (((stripe % STRIPE_COUNT) + STRIPE_COUNT) % STRIPE_COUNT) {
    case 0:
      return "border-l-2 border-l-muted border-solid";
    case 1:
      return "border-l-2 border-l-muted border-dashed";
    case 2:
      return "border-l-2 border-l-muted border-dotted";
    default:
      return "border-l-4 border-l-muted border-double";
  }
}

function uniqueTag(name: string, taken: Set<string>): string {
  const words = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);

  const candidates: string[] = [];
  if (words.length >= 2) {
    candidates.push((words[0][0] + words[1][0]).toUpperCase());
    candidates.push((words[0][0] + words[1][0] + (words[2]?.[0] ?? words[0][1] ?? "")).toUpperCase());
  }
  if (words.length >= 1) {
    candidates.push(words[0].slice(0, 2).toUpperCase());
    candidates.push(words[0].slice(0, 3).toUpperCase());
  }
  candidates.push("??");

  for (const candidate of candidates) {
    const tag = candidate.trim();
    if (tag.length >= 2 && !taken.has(tag)) {
      taken.add(tag);
      return tag;
    }
  }

  // Everything collided: number them. Guaranteed to terminate — one of the
  // first `taken.size + 1` suffixes is free.
  const base = (candidates[0] || "CH").slice(0, 2);
  for (let index = 2; ; index += 1) {
    const tag = `${base[0]}${index}`;
    if (!taken.has(tag)) {
      taken.add(tag);
      return tag;
    }
  }
}
