/**
 * The stack's own configuration: everything in `shared.ts`, plus the paths that
 * only a running stack needs.
 *
 * The split exists because `playwright.config.ts` also needs the ports, the
 * secret and the seed credentials, and Playwright loads its config through a
 * CommonJS transpiler that cannot evaluate `import.meta.url`. Constants live in
 * `shared.ts`; anything derived from this file's own location lives here.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DB_NAME, GATEWAY_PORT } from './shared.js';

export * from './shared.js';

/** Absolute path to the repository root (this file lives in scripts/dev-stack). */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/** The one gitignored directory all instance state lives under. */
export const STATE_ROOT = path.join(REPO_ROOT, '.dev-stack');

/**
 * This instance's scratch directory: storage bytes, the PostgREST config, the
 * pid file.
 *
 * Namespaced by database and gateway port, because `DEV_STACK_PORT`,
 * `DEV_STACK_POSTGREST_PORT` and `NERTUBE_DEV_DB` all override and a second
 * stack on other ports is a thing this harness invites (`npm run e2e:refresh`
 * is one). Sharing one directory meant the second stack rewrote the config file
 * the first one's PostgREST was launched from and deleted its uploaded objects
 * out from under it, while the metadata rows stayed in the other database.
 */
export const INSTANCE = `${DB_NAME}-${GATEWAY_PORT}`;
export const STATE_DIR = path.join(STATE_ROOT, INSTANCE);
export const STORAGE_DIR = path.join(STATE_DIR, 'storage');
export const POSTGREST_CONFIG_PATH = path.join(STATE_DIR, 'postgrest.conf');

/** Written while a stack is up, so a second one can refuse to clobber it. */
export const PID_FILE_PATH = path.join(STATE_DIR, 'stack.json');
