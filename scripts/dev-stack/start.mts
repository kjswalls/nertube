/**
 * `npm run dev:stack` — the local, Docker-free stand-in for `supabase start`.
 *
 * In order:
 *
 *   1. run the SQL test suite against its own throwaway database, so nothing is
 *      served unless the migrations and every policy test pass — then build the
 *      database the stack actually serves from the shim and the migrations
 *      ALONE (`--no-tests`), because `00_fixture.test.sql` commits two fixture
 *      tenants and an `fx` helper schema that no migration describes;
 *   2. apply `auth-schema.sql`, the dev-only password and refresh-token columns;
 *   3. seed one user and two fully seeded channels through the real SQL
 *      functions, as the `authenticated` role;
 *   4. start PostgREST against that database;
 *   5. serve the Supabase-shaped origin in front of it and print what to put in
 *      `.env.local`.
 *
 * It holds the terminal until interrupted, and takes PostgREST down with it.
 *
 * THIS IS A TEST HARNESS. See `scripts/dev-stack/README.md` for the list of
 * Supabase behaviours it does not reproduce.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';

import {
  API_KEY_EXP,
  API_KEY_IAT,
  DB_NAME,
  GATEWAY_HOST,
  GATEWAY_PORT,
  GATEWAY_URL,
  INSTANCE,
  PG,
  PID_FILE_PATH,
  POSTGREST_PORT,
  REPO_ROOT,
  STATE_DIR,
  STATE_ROOT,
  STORAGE_DIR,
  TEST_DB_NAME,
} from './config.mjs';
import { asAuthenticatedUser, closePool } from './db.mjs';
import { apiKey } from './jwt.js';
import { startPostgrest, type PostgrestHandle } from './postgrest.mjs';
import { seed } from './seed.mjs';
import { createGateway, listen, markReady } from './server.mjs';

const ANON_KEY = apiKey('anon', API_KEY_IAT, API_KEY_EXP);
const SERVICE_ROLE_KEY = apiKey('service_role', API_KEY_IAT, API_KEY_EXP);

function log(message: string): void {
  console.log(`[dev-stack] ${message}`);
}

/** Run a command, streaming nothing unless it fails. */
async function run(
  command: string,
  args: readonly string[],
  label: string,
): Promise<void> {
  const child = spawn(command, [...args], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PGHOST: PG.host,
      PGPORT: String(PG.port),
      PGUSER: PG.user,
      ...(PG.password === '' ? {} : { PGPASSWORD: PG.password }),
    },
  });

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode) => resolve(exitCode ?? 1));
  });

  if (code !== 0) {
    process.stderr.write(output);
    throw new Error(`${label} failed (exit ${code})`);
  }
}

async function resetDatabase(): Promise<void> {
  // Gate first, in a database nobody serves: the suite's fixture file COMMITS.
  log(`running the SQL test suite against ${TEST_DB_NAME} (the gate)`);
  await run('./scripts/verify-db.sh', [TEST_DB_NAME], 'scripts/verify-db.sh');

  // Then build what is actually served, from the migrations alone. A served
  // database that carries the test fixture's two foreign tenants is a database
  // the migrations do not describe: RLS hides them from the app, but every
  // service_role read, seed count and future admin query would see rows that
  // cannot exist in a hosted project.
  log(`building ${DB_NAME} from the shim + migrations only (no test fixtures)`);
  await run(
    './scripts/verify-db.sh',
    ['--no-tests', DB_NAME],
    'scripts/verify-db.sh --no-tests',
  );

  log('applying scripts/dev-stack/auth-schema.sql');
  await run(
    'psql',
    [
      '-h', PG.host,
      '-p', String(PG.port),
      '-U', PG.user,
      '-d', DB_NAME,
      '-v', 'ON_ERROR_STOP=1',
      '-q',
      '-f', 'scripts/dev-stack/auth-schema.sql',
    ],
    'psql (auth-schema.sql)',
  );
}

/** The bytes are throwaway state; they must be reset with the database. */
async function resetStorage(): Promise<void> {
  await fs.rm(STORAGE_DIR, { recursive: true, force: true });
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  await fs.writeFile(
    path.join(STATE_ROOT, '.gitignore'),
    '# Throwaway local state for scripts/dev-stack. Never committed.\n*\n',
  );
}

/* -------------------------------------------------------------------------- */
/* One stack per database                                                      */
/* -------------------------------------------------------------------------- */

interface StackRecord {
  pid: number;
  instance: string;
  database: string;
  gatewayPort: number;
  postgrestPort: number;
  startedAt: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse to start a second stack over a live one that serves the same database.
 *
 * The ports are namespaced by `DEV_STACK_PORT`, so two stacks can bind happily;
 * the database is not, and step one of starting is `drop database ... with
 * (force)`. That would pull the schema out from under a running stack.
 */
async function assertNoLiveStackOnSameDatabase(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(STATE_ROOT);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry === INSTANCE) continue;
    const file = path.join(STATE_ROOT, entry, 'stack.json');
    let record: StackRecord;
    try {
      record = JSON.parse(await fs.readFile(file, 'utf8')) as StackRecord;
    } catch {
      continue;
    }
    if (record.database !== DB_NAME || !isAlive(record.pid)) continue;
    throw new Error(
      `pid ${record.pid} is already serving ${DB_NAME} on port ${record.gatewayPort}. ` +
        'Starting here would drop that database out from under it. Stop it first, ' +
        'or give this one its own database with NERTUBE_DEV_DB=...',
    );
  }
}

/**
 * A port clash is nearly always a stack that was SIGKILLed (nothing can catch
 * that) or one someone forgot about. The pid file says which, so say so.
 */
async function describeBindFailure(error: unknown): Promise<Error> {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code !== 'EADDRINUSE') {
    return error instanceof Error ? error : new Error(String(error));
  }

  let owner = '';
  try {
    const record = JSON.parse(
      await fs.readFile(PID_FILE_PATH, 'utf8'),
    ) as StackRecord;
    owner = isAlive(record.pid)
      ? ` It is pid ${record.pid}, started ${record.startedAt}.`
      : ` A stack recorded as pid ${record.pid} is no longer running, so this is something else.`;
  } catch {
    owner = '';
  }

  return new Error(
    `${GATEWAY_HOST}:${GATEWAY_PORT} is already in use.${owner} ` +
      'Stop it with `npm run dev:stack:stop`, or start this one elsewhere with ' +
      'DEV_STACK_PORT=... (and NERTUBE_DEV_DB=... so the two do not share a database).',
  );
}

async function writePidFile(): Promise<void> {
  const record: StackRecord = {
    pid: process.pid,
    instance: INSTANCE,
    database: DB_NAME,
    gatewayPort: GATEWAY_PORT,
    postgrestPort: POSTGREST_PORT,
    startedAt: new Date().toISOString(),
  };
  await fs.writeFile(PID_FILE_PATH, `${JSON.stringify(record, null, 2)}\n`);
}

function envBlock(): string {
  return [
    `NEXT_PUBLIC_SUPABASE_URL=${GATEWAY_URL}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}`,
    `SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}`,
  ].join('\n');
}

async function main(): Promise<void> {
  log('NerTube local dev stack — a TEST harness that approximates Supabase.');

  await fs.mkdir(STATE_DIR, { recursive: true });
  await assertNoLiveStackOnSameDatabase();

  // Bind next, so a port clash fails in a second rather than after a full
  // database reset — and so nothing can be left half-started behind it.
  const server: Server = createGateway();
  try {
    await listen(server);
  } catch (error) {
    throw await describeBindFailure(error);
  }

  await writePidFile();
  await resetStorage();
  await resetDatabase();

  log('seeding');
  const seeded = await seed();
  for (const channel of seeded.channels) {
    log(`  channel "${channel.name}" -> /c/${channel.slug}/board (${channel.videos} ideas)`);
  }

  // Proof the seed is visible THROUGH RLS and not merely present.
  //
  // This has to run as the user: the harness's own pool connects as PGUSER,
  // which is a superuser here, and a superuser count is identical whether the
  // policies exist or not. `asAuthenticatedUser` opens a transaction that
  // `set local role authenticated` and sets `request.jwt.claims`, so
  // `auth.uid()` answers and every policy on `public.stages` is consulted —
  // the same path PostgREST puts a request through.
  const visibleStages = await asAuthenticatedUser(
    seeded.userId,
    seeded.email,
    async (client) => {
      const result = await client.query<{ count: string }>(
        'select count(*)::text as count from public.stages',
      );
      return Number(result.rows[0].count);
    },
  );
  if (visibleStages === 0) {
    throw new Error(
      'the seed is invisible to the user who owns it: `select from public.stages` ' +
        'as the authenticated role returned 0 rows. A policy or a grant is wrong.',
    );
  }
  log(`  ${visibleStages} stages visible to ${seeded.email} as \`authenticated\` (RLS on)`);

  log(`starting postgrest on 127.0.0.1:${POSTGREST_PORT}`);
  let postgrest: PostgrestHandle;
  try {
    postgrest = await startPostgrest();
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  markReady();

  // The ONLY place the harness writes anything resembling a credential is
  // stdout: nothing here is real, and nothing here is written into a file the
  // repository tracks.
  console.log('');
  console.log(`  Supabase-compatible origin:  ${GATEWAY_URL}`);
  console.log(`  Sign in with:                ${seeded.email} / ${seeded.password}`);
  console.log('');
  console.log('  Put this in .env.local (it is gitignored):');
  console.log('');
  console.log(
    envBlock()
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n'),
  );
  console.log('');
  console.log('  Then `npm run dev` and open http://localhost:3000.');
  console.log('  Ctrl-C here stops the stack and PostgREST with it.');
  console.log('');

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} — shutting down`);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
    await postgrest.stop();
    await closePool();
    await fs.rm(PID_FILE_PATH, { force: true }).catch(() => {});

    log('stopped');
    process.exit(0);
  };

  process.on('SIGINT', (signal) => void shutdown(signal));
  process.on('SIGTERM', (signal) => void shutdown(signal));

  // `npm run dev:stack` puts an npm wrapper between the terminal and this
  // process, and npm does not forward a plain `kill <pid>`: the wrapper dies,
  // this process is reparented to init and never sees a signal, and a fully
  // live stack is left holding both ports with nobody owning it. A group signal
  // (Ctrl-C, or Playwright tearing a webServer down) does reach us; a
  // single-pid SIGTERM does not. So watch the parent instead of trusting it.
  //
  // This is why package.json runs `node --import tsx scripts/dev-stack/start.mts`
  // and not `tsx scripts/dev-stack/start.mts`: the `tsx` launcher is itself a
  // node process that spawns this one and outlives npm, so with it in the chain
  // `process.ppid` never changes and this watch never fires. Measured, not
  // assumed. Do not add a process layer to that script.
  const parentPid = process.ppid;
  const orphanWatch = setInterval(() => {
    if (process.ppid !== parentPid) {
      log(`parent process ${parentPid} is gone — shutting down`);
      void shutdown('SIGTERM');
    }
  }, 1000);
  orphanWatch.unref();

  // Last resort: if this process goes away for a reason it cannot handle
  // asynchronously, still take PostgREST with it. `exit` handlers must be
  // synchronous, so this is a bare kill rather than `stop()`.
  process.on('exit', () => {
    if (postgrest.process.exitCode === null && postgrest.process.signalCode === null) {
      try {
        postgrest.process.kill('SIGKILL');
      } catch {
        // Nothing useful to do while exiting.
      }
    }
  });

  // If PostgREST dies on its own there is nothing left to serve, and a gateway
  // that stayed up would answer every query with a 502 forever.
  postgrest.process.once('exit', () => {
    if (!shuttingDown) {
      void shutdown('SIGTERM');
    }
  });
}

main().catch(async (error: unknown) => {
  console.error(
    `[dev-stack] ${error instanceof Error ? error.message : String(error)}`,
  );
  await closePool().catch(() => {});
  process.exit(1);
});
