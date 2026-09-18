/**
 * Reading every row of a PostgREST query, instead of the first thousand.
 *
 * ## The hazard this exists for
 *
 * PostgREST truncates a read at `db-max-rows` — 1000 on a hosted Supabase
 * project, and `scripts/dev-stack/postgrest.mts` pins the same number so a
 * missing `.limit()` behaves here the way it will there. The truncation is
 * **silent**: HTTP 200, `content-range: 0-999/*`, no error field, the rows
 * simply stop.
 *
 * A `.limit(n)` above that ceiling does not raise it — the ceiling wins, and
 * the code reads as if it had a bound it does not have. That is why no read in
 * this app should end in a `.limit()` larger than `PAGE_SIZE`: it looks like a
 * deliberate guard and is not one. `docs/MILESTONES.md` records the M3 review
 * that first corrected this claim, and the M5 review that found it re-entered.
 *
 * ## Why paging rather than a bigger number
 *
 * Because the numbers M5 draws are *counts*, and a count taken from a truncated
 * read is presented as the truth about a channel while being the truth about
 * the newest thousand rows of it. The matrix, the bank's summary, the cell
 * drill-down and the sidebar badge would then disagree with each other in the
 * same chrome — and the badge (a `count: "exact", head: true`, which PostgREST
 * does *not* cap) would be the only one right.
 *
 * `lib/now-data.ts` has paged since M3 for the same reason and its three reads
 * now come through here, so there is one implementation of "all of them".
 */

/**
 * One page of a paged read.
 *
 * Deliberately under `db-max-rows`: a page that asked for exactly the ceiling
 * could not tell "there are exactly this many" from "you have been truncated".
 * Asking for fewer than the ceiling means a short page is always the end.
 */
export const PAGE_SIZE = 500;

/**
 * A stop, so a read that never terminates fails loudly instead of hanging.
 * PLAN.md sizes the account at one user and hundreds of rows; this is 50,000.
 */
export const MAX_PAGES = 100;

/**
 * Every row of a read, one page at a time. Throws rather than answering short.
 *
 * `page(from, to)` is the caller's query with `.range(from, to)` on the end. It
 * must carry a **total** order — `.order("id")`, or a tiebreak after the sort
 * key the page actually wants — because paging over a non-unique order can
 * repeat a row on one page and skip another.
 */
export async function readPaged<Row>(
  what: string,
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let index = 0; index < MAX_PAGES; index += 1) {
    const from = index * PAGE_SIZE;
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Could not load the ${what}: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
  throw new Error(
    `Could not load the ${what}: more than ${MAX_PAGES * PAGE_SIZE} rows, which is past anything this app is designed for.`,
  );
}
