/**
 * Turn a channel name into the `/c/[slug]` path segment.
 *
 * Deliberately lossy and ASCII-only: the slug is a URL, not a display name
 * (`channels.name` keeps the original). Accents are folded rather than dropped
 * so "Café Réviews" becomes `cafe-reviews` and not `caf-riews`.
 *
 * Returns "" when nothing usable survives (a name of only punctuation, or of
 * scripts that do not fold to ASCII). Callers must treat "" as a rejection —
 * `slug` is `not null` and part of `unique (user_id, slug)`.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    // Strip the combining marks that NFKD just split off.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
}
