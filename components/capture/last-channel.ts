"use client";

/**
 * The last channel something was captured into.
 *
 * PLAN.md: "Channel = route channel if any, else last-used (localStorage)."
 * That is the whole feature, and localStorage is the right store for it: it is
 * a per-browser convenience, not user data — losing it costs one keypress.
 *
 * Every access is wrapped: localStorage throws outright in a Safari private
 * window and when site data is blocked, and a capture modal that cannot open
 * because of a storage preference would be a bad trade.
 */

const KEY = "nertube:last-channel";

/** The stored channel id, or `null` if there is none we can use. */
export function readLastChannel(): string | null {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === null || value === "" ? null : value;
  } catch {
    return null;
  }
}

export function writeLastChannel(channelId: string): void {
  try {
    window.localStorage.setItem(KEY, channelId);
  } catch {
    // Not worth telling anyone about: the capture itself succeeded.
  }
}
