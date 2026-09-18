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

test('H: gate refuses past packaging from the detail stage select', async ({ page }) => {
  await signIn(page);
  const channel = await channelRow();
  const v = await db.query(
    `select v.id from public.videos v join public.stages s on s.id=v.stage_id
      where v.channel_id=$1 and s.kind='packaging' limit 1`,
    [channel.id],
  );
  await page.goto(`/videos/${v.rows[0].id}`);
  await page.waitForTimeout(2500);
  const select = page.getByLabel('Stage');
  await select.selectOption({ label: 'Scripting' });
  await page.waitForTimeout(2000);
  console.log('TOASTS:', await page.locator('[role="status"], [role="alert"]').allInnerTexts());
  const after = await db.query(
    `select s.kind from public.videos v join public.stages s on s.id=v.stage_id where v.id=$1`,
    [v.rows[0].id],
  );
  console.log('stage after attempted move past packaging:', JSON.stringify(after.rows));
  await page.screenshot({ path: 'e2e/screenshots/adv-gate.png', fullPage: true });
});

test('I: empty cell by keyboard only', async ({ page }) => {
  await signIn(page);
  const channel = await channelRow();
  await db.query(
    `delete from public.videos where channel_id=$1 and title='Keyboard idea'`,
    [channel.id],
  );
  await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix`);
  await page.waitForTimeout(1500);
  const target = page.locator('[data-testid="matrix-cell"][data-vertical="Craft"][data-horizontal="vlog"]');
  await target.focus();
  console.log('focused element:', await page.evaluate(() => document.activeElement?.textContent?.trim()));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  const modal = page.getByTestId('matrix-capture');
  console.log('modal visible after Enter on cell:', await modal.isVisible().catch(() => false));
  if (await modal.isVisible().catch(() => false)) {
    console.log('focused inside modal:', await page.evaluate(() => (document.activeElement as HTMLInputElement)?.id));
    await page.keyboard.type('Keyboard idea');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
  }
  const row = await db.query(
    `select v.title, v.vertical_id, v.horizontal_id from public.videos v where v.title='Keyboard idea'`,
  );
  console.log('DB after keyboard capture:', JSON.stringify(row.rows));
  console.log('cell now:', await target.getAttribute('data-empty'), await target.getAttribute('data-count'));
  await page.screenshot({ path: 'e2e/screenshots/adv-keyboard-cell.png', fullPage: true });
});

test('J: archive, restore, promote-archived refusal', async ({ page }) => {
  await signIn(page);
  await page.goto(`/c/${CHANNEL.slug}/ideas`);
  await expect(page.locator('[data-testid="idea-bank"][data-ready="true"]')).toBeVisible();
  const archive = page.getByRole('button', { name: 'Archive' }).first();
  await archive.click();
  await page.waitForTimeout(1800);
  console.log('AFTER ARCHIVE:\n', (await page.getByTestId('idea-bank').innerText()).slice(0, 900));
  // promote while archived
  const promote = page.getByRole('button', { name: 'Promote' }).first();
  if (await promote.count()) {
    await promote.click();
    await page.waitForTimeout(1200);
    console.log('toast after promoting archived:', await page.locator('[role="status"], [role="alert"]').allInnerTexts());
  }
  await page.screenshot({ path: 'e2e/screenshots/adv-archived.png', fullPage: true });
  const restore = page.getByRole('button', { name: 'Restore' }).first();
  if (await restore.count()) {
    await restore.click();
    await page.waitForTimeout(1500);
    console.log('AFTER RESTORE:\n', (await page.getByTestId('idea-bank').innerText()).slice(0, 700));
  }
});

test('K: filters in the URL survive a reload and a paste', async ({ page }) => {
  await signIn(page);
  const channel = await channelRow();
  await page.goto(`/c/${CHANNEL.slug}/ideas`);
  await expect(page.locator('[data-testid="idea-bank"][data-ready="true"]')).toBeVisible();
  await page.getByTestId('idea-vertical-filter').selectOption({ label: /Money/ }).catch(async () => {
    const opts = await page.getByTestId('idea-vertical-filter').locator('option').allInnerTexts();
    console.log('vertical options:', opts);
  });
  await page.waitForTimeout(600);
  console.log('URL after filter:', page.url());
  await page.reload();
  await page.waitForTimeout(1500);
  console.log('URL after reload:', page.url());
  console.log('BANK after reload:\n', (await page.getByTestId('idea-bank').innerText()).slice(0, 700));

  // cell panel + link agreement
  const buckets = await db.query(
    `select id, axis, name from public.buckets where channel_id=$1 and name in ('Money','review')`,
    [channel.id],
  );
  const vert = buckets.rows.find((b) => b.axis === 'vertical');
  const horiz = buckets.rows.find((b) => b.axis === 'horizontal');
  await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix&cell=${vert.id}:${horiz.id}`);
  await page.waitForTimeout(1200);
  const panel = page.getByTestId('matrix-cell-panel');
  console.log('PANEL:\n', await panel.innerText().catch(() => 'none'));
  await page.screenshot({ path: 'e2e/screenshots/adv-cell-panel.png', fullPage: true });
});
