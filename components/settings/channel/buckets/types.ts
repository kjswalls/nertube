import type { SettingsBucket } from "@/app/actions/buckets";

/**
 * The shapes `/settings/buckets` hands its editors. Plain data, read and
 * counted on the server: an axis editor owns names, quotas and positions
 * while it is open and replaces the lot whenever the server sends a fresh
 * set.
 */

/** One bucket of the channel being edited, with what is filed under it. */
export interface EditableBucket extends SettingsBucket {
  /**
   * Non-archived videos carrying this bucket right now — the same number the
   * matrix prints as the row or column total, shown here so a removal is
   * never a surprise about somebody's bank. Archived videos are unfiled by a
   * removal too, and the sentence says so.
   */
  readonly filed: number;
}

/** The channel the page is about. */
export interface BucketsChannel {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}
