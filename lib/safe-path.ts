/**
 * Reduce an attacker-controllable `?next=` value to a path on this site.
 *
 * A prefix check is not enough. The URL standard requires ASCII tab, LF and CR
 * to be stripped *before* parsing, and browsers apply that to a `Location`
 * header too, so `/\t/evil.com` — which starts with exactly one `/` — becomes
 * the protocol-relative `//evil.com` by the time the browser reads it, and
 * `/%0Aevil` is a byte Node refuses to put in a header at all (an unhandled
 * 500). Both live in the query string of a link anyone can send.
 *
 * So parse the value against a fixed base and apply the same normalisation the
 * browser would: anything that lands on another origin is not ours, and what
 * comes back is a plain path with no stray control characters left in it.
 */
export function safePath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";

  const base = "http://nertube.invalid";
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return "/";
  }

  // `//evil.com`, `/\evil.com` and `/<tab>/evil.com` all resolve elsewhere.
  if (url.origin !== base) return "/";

  return url.pathname + url.search;
}
