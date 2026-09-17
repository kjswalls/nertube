/**
 * A problem with one element of one packaging list, pinned to the row that
 * caused it.
 *
 * Its own module so the block and the two list editors can share the type
 * without importing each other.
 *
 * `id` is `null` when the complaint is about the list as a whole (too many
 * candidates, too many hooks) rather than about a row.
 */
export interface RowIssue {
  readonly id: string | null;
  readonly message: string;
}
