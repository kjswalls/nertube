import { expect, test } from '@playwright/test';

import {
  API_KEY_EXP,
  API_KEY_IAT,
  GATEWAY_URL,
  SEED_EMAIL,
  SEED_PASSWORD,
} from '../scripts/dev-stack/shared';
import { apiKey } from '../scripts/dev-stack/jwt';

/**
 * `proxy.ts` refreshes the session on every request, and that path is invisible
 * in a normal run: an access token lives an hour, so nothing expires while the
 * suite is running.
 *
 * This test makes it visible by asking the stack for a session and looking at
 * how long the token lasts. Run the whole suite with a short one —
 *
 *   npm run e2e:refresh
 *
 * — and the wait below crosses the expiry, so the reload afterwards only works
 * if `proxy.ts` really did rotate the token and write the new cookies onto its
 * response. With the default hour-long token there is nothing here to prove, so
 * the test skips and says so rather than passing vacuously.
 *
 * A skip is only honest when nobody asked for the short-token run. When
 * `DEV_STACK_REQUIRE_SHORT_TTL` is set — `npm run e2e:refresh` sets it — a stack
 * that mints long tokens is a FAILURE, not a skip: that command exists to prove
 * the refresh path works, and it used to exit 0 having proved nothing whenever a
 * stack was already running and Playwright reused it. `e2e:refresh` now also
 * takes its own ports and database and refuses to reuse, so this assertion
 * should never fire; it is here so that if it ever does, the command goes red.
 *
 * It found a real defect the first time it ran: the harness rotated refresh
 * tokens with no reuse interval, and a server-rendered page — which builds
 * several Supabase clients per request — signed the user out the moment its
 * token expired. Real GoTrue answers a just-rotated token with the session that
 * replaced it; `scripts/dev-stack/auth.mts` now does too.
 */

/** Ask the stack directly how long its access tokens live. */
async function accessTokenTtlSeconds(): Promise<number> {
  const response = await fetch(`${GATEWAY_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // The gateway requires an api key, exactly as Kong does.
      apikey: apiKey('anon', API_KEY_IAT, API_KEY_EXP),
    },
    body: JSON.stringify({ email: SEED_EMAIL, password: SEED_PASSWORD }),
  });
  const body = (await response.json()) as { expires_in?: number };
  return body.expires_in ?? Number.MAX_SAFE_INTEGER;
}

/** The short-token run asks for this; nothing else does. */
const REQUIRE_SHORT_TTL = process.env.DEV_STACK_REQUIRE_SHORT_TTL === '1';

test('the session survives access-token expiry, via the proxy.ts refresh', async ({
  page,
}) => {
  const ttl = await accessTokenTtlSeconds();

  if (REQUIRE_SHORT_TTL && ttl > 30) {
    throw new Error(
      `this run asked for a short-lived access token (DEV_STACK_ACCESS_TOKEN_TTL=` +
        `${process.env.DEV_STACK_ACCESS_TOKEN_TTL ?? 'unset'}) but the stack on ` +
        `${GATEWAY_URL} mints ${ttl}s tokens, so the refresh path cannot be ` +
        'exercised. Something else is serving that port — stop it and run ' +
        '`npm run e2e:refresh` again. Failing rather than skipping: a skip here ' +
        'would report success for a command that proved nothing.',
    );
  }

  test.skip(
    ttl > 30,
    `the stack mints ${ttl}s access tokens, so nothing expires during this run — ` +
      'use `npm run e2e:refresh`, which starts the stack with a 5s token',
  );

  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/c\/[^/]+\/board$/);

  // Past the expiry of the token the browser is holding.
  await page.waitForTimeout((ttl + 4) * 1000);

  // Twice: the first reload rotates the token, the second proves the rotated
  // one was actually stored in the browser rather than thrown away.
  for (const attempt of [1, 2]) {
    await page.reload();
    await expect(page, `reload ${attempt} should stay on the board`).toHaveURL(
      /\/c\/[^/]+\/board$/,
    );
    await expect(
      page.getByRole('region', { name: 'Packaging (TTH)', exact: true }),
    ).toBeVisible();
  }
});
