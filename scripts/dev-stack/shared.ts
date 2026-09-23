/**
 * The settings the dev stack and the Playwright config both need.
 *
 * Kept in a plain `.ts` module with no `import.meta` and no filesystem access
 * on purpose: `playwright.config.ts` is loaded by Playwright's own CommonJS
 * transpiler, which cannot evaluate `import.meta.url`. Everything path-shaped
 * lives in `config.mts` instead, which only the stack itself loads.
 *
 * This is a TEST harness. The "secret" below is a fixed, published test
 * constant — the same string the Supabase CLI uses for its local stack. It
 * signs tokens that only ever reach a throwaway database on 127.0.0.1, and it
 * is deliberately committed so `npm run dev:stack` needs no setup at all.
 * Nothing here is used in production; see `scripts/dev-stack/README.md`.
 */

function envString(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value !== '' ? value : fallback;
}

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `${name} must be a TCP port (1-65535), got ${JSON.stringify(raw)}`,
    );
  }
  return port;
}

/**
 * A count of something that is not a port. Kept separate from `envPort` so a
 * token lifetime is not silently capped at 65535 seconds with an error message
 * about positive integers.
 */
function envPositiveInt(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(
      `${name} must be a positive integer of at most ${max}, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/**
 * The harness drops and recreates its database on every start, so the one thing
 * it must never be pointed at is a database someone else owns. `PGHOST` and
 * `PGPASSWORD` are exactly the variables a developer exports when working
 * against a hosted Postgres, and nothing else here looks at the host at all.
 *
 * Loopback only, unless `DEV_STACK_ALLOW_REMOTE_DB=1` says otherwise out loud.
 */
export function assertLocalPostgresHost(host: string): void {
  if (process.env.DEV_STACK_ALLOW_REMOTE_DB === '1') return;
  const bare = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  const local =
    bare === 'localhost' ||
    bare === '::1' ||
    bare === '0:0:0:0:0:0:0:1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare) ||
    // A unix socket directory, which cannot be remote.
    bare.startsWith('/');
  if (!local) {
    throw new Error(
      `PGHOST is ${JSON.stringify(host)}, which is not loopback. ` +
        'scripts/dev-stack DROPS AND RECREATES its database on every start, so it ' +
        'refuses to talk to anything but 127.0.0.1/localhost. Set ' +
        'DEV_STACK_ALLOW_REMOTE_DB=1 if you really mean it.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Database                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The database the stack owns. `scripts/dev-stack/start.mts` DROPS AND
 * RECREATES it on every run, so it must never be a database anyone cares about.
 */
export const DB_NAME = envString('NERTUBE_DEV_DB', 'nertube_dev');

/**
 * The throwaway database the SQL test suite is run against before the stack
 * serves anything.
 *
 * It is a *different* database from the one the stack serves on purpose:
 * `supabase/tests/00_fixture.test.sql` commits two fixture tenants and an `fx`
 * helper schema, and a serving database must contain only what the migrations
 * describe. Same name as `scripts/verify-db.sh`'s default, so `npm run
 * db:verify` and the stack share one scratch database.
 */
export const TEST_DB_NAME = envString('NERTUBE_TEST_DB', 'nertube_test');

if (TEST_DB_NAME === DB_NAME) {
  throw new Error(
    `NERTUBE_TEST_DB and NERTUBE_DEV_DB are both ${JSON.stringify(DB_NAME)}. ` +
      'The SQL test suite commits fixture rows; the served database must not have them.',
  );
}

const PG_HOST = envString('PGHOST', '127.0.0.1');
assertLocalPostgresHost(PG_HOST);

export const PG = {
  host: PG_HOST,
  port: envPort('PGPORT', 5432),
  user: envString('PGUSER', 'postgres'),
  /** Empty by default: the local server this targets uses trust auth. */
  password: envString('PGPASSWORD', ''),
  database: DB_NAME,
} as const;

/**
 * The role PostgREST logs in as.
 *
 * A hosted project runs PostgREST as `authenticator`: a plain LOGIN NOINHERIT
 * role granted membership in `anon`, `authenticated` and `service_role` and
 * nothing else, so `SET ROLE` to anything outside that set fails. The harness
 * creates the same role in `scripts/dev-stack/auth-schema.sql`. Connecting as
 * `postgres` instead would make the token's `role` claim unconstrained — a
 * token claiming `role: "postgres"` would be honoured here and rejected there.
 *
 * `db.mts`'s own pool still uses `PGUSER`: the harness needs the privilege for
 * its auth bookkeeping. PostgREST does not.
 */
export const POSTGREST_DB_USER = envString(
  'DEV_STACK_POSTGREST_USER',
  'authenticator',
);

/** libpq URI for PostgREST's `db-uri`. */
export function postgresUri(user: string = POSTGREST_DB_USER): string {
  const auth = PG.password
    ? `${encodeURIComponent(user)}:${encodeURIComponent(PG.password)}`
    : encodeURIComponent(user);
  return `postgres://${auth}@${PG.host}:${PG.port}/${encodeURIComponent(PG.database)}`;
}

/* -------------------------------------------------------------------------- */
/* Ports                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The one origin the app is pointed at — the Supabase-shaped façade. 54321 is
 * the port `supabase start` uses, so `.env.local` reads the same either way.
 */
export const GATEWAY_PORT = envPort('DEV_STACK_PORT', 54321);
export const GATEWAY_HOST = envString('DEV_STACK_HOST', '127.0.0.1');
export const GATEWAY_URL = `http://${GATEWAY_HOST}:${GATEWAY_PORT}`;

/** PostgREST's own port. Nothing but the gateway should talk to it. */
export const POSTGREST_PORT = envPort('DEV_STACK_POSTGREST_PORT', 54322);
export const POSTGREST_HOST = '127.0.0.1';

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The HS256 secret PostgREST is configured with and the gateway signs with.
 * PostgREST refuses a secret shorter than 32 bytes.
 */
export const JWT_SECRET = envString(
  'DEV_STACK_JWT_SECRET',
  'super-secret-jwt-token-with-at-least-32-characters-long',
);

/** `iss` on every api key the harness mints. */
export const JWT_ISSUER = 'nertube-dev-stack';

/** How long an access token lives. Short enough that refresh is exercised. */
export const ACCESS_TOKEN_TTL_SECONDS = envPositiveInt(
  'DEV_STACK_ACCESS_TOKEN_TTL',
  3600,
  7 * 24 * 60 * 60,
);

/**
 * The api keys are themselves JWTs, exactly as in a real project: an anon
 * request therefore genuinely becomes the `anon` database role inside
 * PostgREST, and RLS bites for real.
 *
 * Their `iat`/`exp` are fixed constants rather than "now", so the keys printed
 * by one run are byte-identical to the next and a `.env.local` written once
 * keeps working. (2033-05-18; long past the life of any dev database.)
 */
export const API_KEY_IAT = 1_700_000_000;
export const API_KEY_EXP = 2_000_000_000;

/* -------------------------------------------------------------------------- */
/* Seed identity                                                               */
/* -------------------------------------------------------------------------- */

/** The single account the harness creates. Dev-only, by construction. */
export const SEED_EMAIL = envString('SEED_EMAIL', 'dev@nertube.test');
export const SEED_PASSWORD = envString('SEED_PASSWORD', 'nertube-dev-password');

/**
 * The seed account's time zone (M10), recorded by the seed as *chosen* so a
 * sign-in from a browser in another zone never replaces it. The browser suite
 * derives every "today" it asserts on from this, rather than from whatever
 * zone the machine running it happens to be in.
 */
export const SEED_TIME_ZONE = 'UTC';

/** The two channels the seed creates, in order. */
export const SEED_CHANNELS = ['Personal', 'Sunday Softworks'] as const;

/** The one bucket `0001_init.sql` creates. */
export const THUMBNAILS_BUCKET = 'thumbnails';
