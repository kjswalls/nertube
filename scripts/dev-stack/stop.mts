/**
 * `npm run dev:stack:stop` — stop whatever local stacks are running.
 *
 * `npm run dev:stack` normally goes away on its own: Ctrl-C reaches it, a group
 * signal reaches it, and it watches its parent so that a plain `kill` of the
 * `npm` wrapper (which npm does NOT forward) takes it down too. What nothing can
 * catch is a SIGKILL, and a SIGKILLed stack leaves PostgREST holding its port
 * with no parent. This reads the pid files each stack writes into
 * `.dev-stack/<database>-<port>/stack.json` and stops what is still alive.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { STATE_ROOT } from './config.mjs';

interface StackRecord {
  pid: number;
  instance: string;
  database: string;
  gatewayPort: number;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(STATE_ROOT);
  } catch {
    console.log('[dev-stack] nothing to stop: no .dev-stack directory.');
    return;
  }

  let stopped = 0;
  for (const entry of entries) {
    const file = path.join(STATE_ROOT, entry, 'stack.json');
    let record: StackRecord;
    try {
      record = JSON.parse(await fs.readFile(file, 'utf8')) as StackRecord;
    } catch {
      continue;
    }

    if (!isAlive(record.pid)) {
      await fs.rm(file, { force: true });
      console.log(`[dev-stack] ${record.instance}: pid ${record.pid} is already gone (stale pid file removed).`);
      continue;
    }

    console.log(`[dev-stack] ${record.instance}: stopping pid ${record.pid} (port ${record.gatewayPort})`);
    try {
      process.kill(record.pid, 'SIGTERM');
    } catch {
      // It went away between the check and the signal.
    }

    for (let waited = 0; waited < 5000 && isAlive(record.pid); waited += 200) {
      await sleep(200);
    }
    if (isAlive(record.pid)) {
      console.log(`[dev-stack] ${record.instance}: it would not go quietly; SIGKILL`);
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }

    await fs.rm(file, { force: true });
    stopped += 1;
  }

  console.log(`[dev-stack] ${stopped} stack(s) stopped.`);
}

main().catch((error: unknown) => {
  console.error(`[dev-stack] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
