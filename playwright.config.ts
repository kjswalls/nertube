import { defineConfig, devices } from '@playwright/test';

import {
  API_KEY_EXP,
  API_KEY_IAT,
  GATEWAY_URL,
} from './scripts/dev-stack/shared';
import { apiKey } from './scripts/dev-stack/jwt';

/**
 * End-to-end configuration.
 *
 * Two servers, started by Playwright itself, so `npm run e2e` is one command
 * from a cold repository:
 *
 *   1. `npm run dev:stack` — resets `nertube_dev` from the migrations, seeds it
 *      and serves the Supabase-compatible origin (see scripts/dev-stack).
 *   2. `npm run dev` — the actual application, pointed at that origin with the
 *      anon key the stack mints. Nothing is stubbed on the app's side: the page
 *      under test is the page that ships.
 *
 * ## Why neither server is reused by default
 *
 * `reuseExistingServer` used to be `!process.env.CI` on both, and both were
 * wrong:
 *
 *   - The **app** entry is the only thing that points the application at this
 *     harness (its `env` block below). Reusing a server Playwright did not
 *     start silently skips that block, so the suite drives an app whose
 *     Supabase target nobody here controls — a developer with `npm run dev`
 *     already up against a hosted project would have `npm run e2e` sign into
 *     *that* project. So the app server is never reused, and its default port
 *     is 3111 rather than 3000 so it does not collide with a dev server.
 *   - The **stack** entry is what `npm run e2e:refresh` shortens the access
 *     token on. A reused stack still mints hour-long tokens, which used to turn
 *     the refresh spec into a silent skip and the command into a green run that
 *     proved nothing. `e2e:refresh` therefore sets `E2E_REUSE=0` and its own
 *     ports and database, so it always starts the stack it configured.
 *
 * `E2E_REUSE=1` opts back in to reusing both, for a fast inner loop when you
 * know what is running.
 *
 * ## Why `executablePath`
 *
 * The browser is pre-installed at /opt/pw-browsers (Chromium 141, revision
 * 1194); this @playwright/test would otherwise want revision 1243 and try to
 * download it, which this environment does not allow. Pointing at the binary
 * that is here is the supported way to use a browser Playwright did not install
 * — `npx playwright install` must never run.
 */

/** The api key the stack mints — recomputed here rather than pasted. */
const ANON_KEY = apiKey('anon', API_KEY_IAT, API_KEY_EXP);

const APP_PORT = Number(process.env.E2E_PORT ?? 3111);
const APP_URL = `http://localhost:${APP_PORT}`;

/** The stack may be one a developer already has up; the app never is. */
const REUSE_STACK = !process.env.CI && process.env.E2E_REUSE !== '0';
const REUSE_APP = !process.env.CI && process.env.E2E_REUSE === '1';

/** Where the pre-installed browser lives. */
const CHROMIUM =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './e2e',
  // Runs after both webServers are up: it refuses to let the suite start
  // against something on the gateway port that is not this harness.
  globalSetup: './e2e/global-setup.ts',
  // The two servers share one database; running the specs in parallel would
  // have them signing in and out of the same account at once.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  // `next dev` compiles a route the first time it is asked for, so the first
  // navigation of a run is slow in a way later ones are not.
  timeout: 90_000,
  expect: { timeout: 20_000 },

  use: {
    baseURL: APP_URL,
    navigationTimeout: 60_000,
    actionTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { executablePath: CHROMIUM },
      },
    },
  ],

  webServer: [
    {
      command: 'npm run dev:stack',
      url: `${GATEWAY_URL}/health`,
      // `/health` answers 503 until PostgREST is up and the seed is in, so this
      // waits for a stack that can answer a query rather than for an open port.
      reuseExistingServer: REUSE_STACK,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The preflight first: Next allows one `next dev` per directory, so a
      // dev server someone left running makes this command exit 1 and the whole
      // suite fail to launch. `scripts/e2e-preflight.mjs` says so in one
      // sentence instead of leaving Next's refusal buried in `[WebServer]`
      // output below a "✓ Ready" line from the server it is refusing to be.
      command: `node scripts/e2e-preflight.mjs && npm run dev -- --port ${APP_PORT}`,
      url: `${APP_URL}/login`,
      // Never by default: this entry's `env` block is the only thing aiming the
      // app at the harness, and a reused server never sees it.
      reuseExistingServer: REUSE_APP,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NEXT_PUBLIC_SUPABASE_URL: GATEWAY_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
        /*
          The brainstorm answers from fixtures, never from a model.

          `lib/assist/fake.ts` is deterministic, offline and free, so
          `e2e/brainstorm.spec.ts` drives the real panel, the real server
          action and the real `brainstorm_last` write on every run — in CI, and
          on a laptop with no API key. The suite would otherwise be a suite
          that costs money, answers differently every time and cannot assert on
          a single suggestion.
        */
        ASSIST_PROVIDER: 'fake',
      },
    },
  ],
});
