import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

const CHANNEL = { slug: 'adv-review' };

let db: pg.Client;
test.beforeAll(async () => {
  db = new pg.Client({
    host: PG.host,
    port: PG.port,
    user: PG.user,
    password: PG.password === '' ? undefined : PG.password,
    database: PG.database,
  });
  await db.connect();
});
test.afterAll(async () => {
  await db?.end();
});

async function signIn(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}

async function channelRow() {
  const r = await db.query('select id, user_id from public.channels where slug = $1', [CHANNEL.slug]);
  return r.rows[0];
}

/**
 * The claim under test: a matrix cell says "Filing it under X · Y", the user
 * opens the disclosure to add a hook, and the two bucket pickers are still
 * fetching their options (they are `disabled` while loading, and a disabled
 * control contributes nothing to FormData). What gets written?
 */
test('M: capture through the disclosure while the bucket options are still loading', async ({ page }) => {
  await signIn(page);
  const channel = await channelRow();
  await db.query(`delete from public.videos where channel_id=$1 and title like 'Slowfetch%'`, [channel.id]);

  // Delay only the `listBuckets` server action (a POST carrying next-action).
  let delayed = 0;
  await page.route('**/c/adv-review/ideas*', async (route) => {
    const request = route.request();
    if (request.method() === 'POST' && request.headers()['next-action'] && delayed === 0) {
      delayed += 1;
      await new Promise((resolve) => setTimeout(resolve, 6000));
    }
    await route.continue();
  });

  await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix`);
  await page.waitForTimeout(1500);
  const target = page.locator('[data-testid="matrix-cell"][data-vertical="Health"][data-horizontal="interview"]');
  console.log('cell empty?', await target.getAttribute('data-empty'));
  await target.click();
  const modal = page.getByTestId('matrix-capture');
  await expect(modal).toBeVisible();
  const title = page.getByRole('textbox', { name: 'Idea' });
  await title.fill('Slowfetch idea');
  await title.press('Shift+Enter');
  // The disclosure is open; the pickers are fetching. Type the hook and save,
  // exactly as somebody in a hurry would.
  await page.waitForTimeout(150);
  console.log('buckets status right after opening:', await page.getByTestId('capture-buckets-status').getAttribute('data-status'));
  console.log('prefill line still shown:', await page.getByTestId('capture-prefill').isVisible().catch(() => false));
  console.log('prefill text:', await page.getByTestId('capture-prefill').innerText().catch(() => 'none'));
  console.log('vertical select disabled:', await page.getByTestId('capture-vertical').isDisabled());
  const hook = page.getByRole('textbox', { name: 'One-line hook' });
  await hook.fill('a promise');
  await hook.press('Enter');
  await page.waitForTimeout(9000);
  const rows = await db.query(
    `select title, one_line_hook, vertical_id, horizontal_id from public.videos where title='Slowfetch idea'`,
  );
  console.log('WRITTEN ROW:', JSON.stringify(rows.rows));
  await page.screenshot({ path: 'e2e/screenshots/adv-slowfetch.png', fullPage: true });
});
