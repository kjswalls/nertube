import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { GATEWAY_URL, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';
import { SEED_STAGES } from '../lib/defaults';

/**
 * The acceptance test for the local dev stack.
 *
 * It is deliberately not a test *of* the harness. Every assertion here is about
 * the real application: the real `/login` page, the real `signIn` server
 * action, the real `proxy.ts` route guard and the real board page reading real
 * rows through PostgREST with RLS on. If the harness lies about any of that,
 * these fail.
 *
 * The nine column names come from `lib/defaults.ts`, so they cannot drift from
 * what the seed actually writes without this failing too.
 */

/** Gitignored; a human can look at it afterwards. */
const SCREENSHOT_DIR = path.join(process.cwd(), 'e2e', 'screenshots');

const STAGE_NAMES = SEED_STAGES.map((stage) => stage.name);

async function signIn(page: Page, password: string): Promise<void> {
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('signing in lands on /now, and the board shows the nine seeded stages', async ({
  page,
}) => {
  // Wide enough that all nine columns lay out side by side, so the screenshot
  // at the end shows the whole board rather than the first four of it.
  await page.setViewportSize({ width: 2880, height: 900 });

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'NerTube' })).toBeVisible();

  await signIn(page, SEED_PASSWORD);

  // PLAN.md's routing table: `/` sends a signed-in user with a channel to
  // `/now`. Until M3 built that page this landed on the first channel's board
  // instead, and the assertion moved rather than softened: the front door is
  // asserted here, and the board it used to open is reached below through the
  // sidebar, which is where a user goes for it.
  await page.waitForURL('**/now');
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Now', exact: true }),
  ).toHaveAttribute('aria-current', 'page');

  // The app under test is talking to THIS stack, and not to some other Supabase
  // origin that happens to accept the same credentials. supabase-js names its
  // auth cookie after the project: `sb-<first label of the host>-auth-token`.
  // Belt to `reuseExistingServer: false`'s braces in playwright.config.ts.
  const expectedCookiePrefix = `sb-${new URL(GATEWAY_URL).hostname.split('.')[0]}-auth-token`;
  const cookieNames = (await page.context().cookies()).map((cookie) => cookie.name);
  expect(
    cookieNames.some((name) => name.startsWith(expectedCookiePrefix)),
    `the session cookie should be ${expectedCookiePrefix}*, naming ${GATEWAY_URL}; got ${cookieNames.join(', ')}`,
  ).toBe(true);
  // The seed creates "Personal" first, so the sidebar's Board link is its
  // board — the one `/` used to redirect to.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Board', exact: true })
    .click();
  await page.waitForURL(/\/c\/[^/]+\/board$/);
  await expect(page.getByRole('heading', { name: 'Personal', level: 1 })).toBeVisible();

  // Each column is a <section aria-label={stage.name}>, i.e. a landmark region.
  for (const name of STAGE_NAMES) {
    await expect(
      page.getByRole('region', { name, exact: true }),
      `the "${name}" column should be on the board`,
    ).toBeVisible();
  }

  expect(STAGE_NAMES).toHaveLength(9);

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'board-signed-in.png'),
    fullPage: true,
  });
  console.log(`  screenshot: ${path.join(SCREENSHOT_DIR, 'board-signed-in.png')}`);
});

test('a wrong password shows an error and does not sign in', async ({ page }) => {
  await page.goto('/login');

  await signIn(page, 'not-the-password');

  // The message comes from the auth server, through `signIn`'s error branch,
  // into the form's live region — which only works if the harness returns the
  // error in the shape supabase-js parses.
  //
  // Scoped to the form: Next's dev-mode route announcer is also a
  // `role="alert"` element, and an unscoped match is a strict-mode violation
  // whenever it happens to be in the DOM.
  const formError = page.locator('form').getByRole('alert');
  await expect(formError).toHaveText(/invalid login credentials/i);

  // Still on /login, and still signed out.
  await expect(page).toHaveURL(/\/login(\?|$)/);
  await expect(page.getByLabel('Password')).toBeVisible();

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'login-wrong-password.png'),
    fullPage: true,
  });

  // And the guard still bounces this browser off a board.
  await page.goto('/c/personal/board');
  await expect(page).toHaveURL(/\/login\?next=%2Fc%2Fpersonal%2Fboard$/);
});

test('a signed-out browser is redirected from a board to /login', async ({
  page,
}) => {
  await page.goto('/c/personal/board');

  await expect(page).toHaveURL(/\/login\?next=%2Fc%2Fpersonal%2Fboard$/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  // No column leaked into the response before the redirect.
  await expect(
    page.getByRole('region', { name: 'Packaging (TTH)', exact: true }),
  ).toHaveCount(0);
});
