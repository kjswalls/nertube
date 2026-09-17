/**
 * The one thing that stops `npm run e2e` from starting at all.
 *
 * Next 16 allows one dev server per directory: with `npm run dev` already up,
 * Playwright's app server prints "Another next dev server is already running"
 * and exits 1, so the whole suite fails to launch rather than failing a test —
 * and the reason arrives buried in a `[WebServer]` prefix, several lines below
 * a "✓ Ready" that belongs to the server it is about to refuse to be.
 *
 * `.next/dev/lock` is how Next itself knows: a small JSON file carrying the pid
 * and port of the live dev server. It outlives a killed server, so the pid is
 * checked (signal 0 — "is this process there", it sends nothing) before this
 * says anything.
 *
 * Run by playwright.config.ts immediately before the app server's command.
 */
import { readFileSync } from "node:fs";

const LOCK = new URL("../.next/dev/lock", import.meta.url);

let lock;
try {
  lock = JSON.parse(readFileSync(LOCK, "utf8"));
} catch {
  process.exit(0); // No lock, or an unreadable one: nothing to say.
}

const pid = Number(lock?.pid);
if (!Number.isInteger(pid) || pid <= 0) process.exit(0);

try {
  process.kill(pid, 0);
} catch {
  process.exit(0); // Stale lock from a server that is gone.
}

console.error(
  [
    "",
    "  npm run e2e cannot start: a `next dev` server is already running in this",
    `  directory (pid ${pid}${lock.appUrl ? `, ${lock.appUrl}` : ""}).`,
    "",
    "  Next allows one dev server per directory, and the suite always starts its",
    "  own — its env block is the only thing aiming the app at the test stack.",
    "",
    `  Stop it first:  kill ${pid}`,
    "",
  ].join("\n"),
);
process.exit(1);
