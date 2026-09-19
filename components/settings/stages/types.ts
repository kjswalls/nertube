import type { StageKind } from "@/lib/defaults";

/**
 * The shapes `/settings/stages` hands its editor. Plain data, read and counted
 * on the server: the editor owns positions and labels while it is open and
 * replaces the lot whenever the server sends a fresh set.
 */

/** One stage of the channel being edited, enabled or not. */
export interface SettingsStage {
  readonly id: string;
  readonly name: string;
  /** Null for a user-added, inert stage. */
  readonly kind: StageKind | null;
  readonly position: number;
  readonly isEnabled: boolean;
  /**
   * Non-archived videos sitting in it right now — the number that decides
   * whether it can be switched off, shown beside the row so a refusal is
   * never a surprise. Archived videos are not counted, matching
   * `set_stage_enabled`.
   */
  readonly occupied: number;
}

/** The channel the page is about, and the others it could be about. */
export interface SettingsChannel {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}
