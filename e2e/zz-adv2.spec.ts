import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

const CHANNEL = { name: 'Adv Review', slug: 'adv-review' };

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

test('E: gate past packaging still refuses', async ({ page }) => {
  await signIn(page);
  const channel = await channelRow();
  const v = await db.query(
    `select v.id, v.title, s.kind from public.videos v join public.stages s on s.id=v.stage_id
     where v.channel_id=$1 and s.kind='packaging' limit 1`,
    [channel.id],
  );
  console.log('packaging video:', JSON.stringify(v.rows));
  const id = v.rows[0].id;
  await page.goto(`/videos/${id}`);
  await page.waitForTimeout(2500);
  // the stage select on the detail page
  const select = page.getByLabel('Stage');
  console.log('stage select count', await select.count());
  const body = await page.locator('main').innerText();
  console.log('DETAIL PAGE (first 2500):\n', body.slice(0, 2500));
  await page.screenshot({ path: 'e2e/screenshots/adv-detail.png', fullPage: true });
});

test('F: board move to packaging then sidebar ideas', async ({ page }) => {
  await signIn(page);
  const channel = await channelRow();
  // fresh idea to move from the board
  await db.query(
    `insert into public.videos (user_id, channel_id, stage_id, title)
     select $1, $2, s.id, 'Board moved idea' from public.stages s
      where s.channel_id=$2 and s.kind='idea'
      on conflict do nothing`,
    [channel.user_id, channel.id],
  );
  await page.goto(`/c/${CHANNEL.slug}/board`);
  await page.waitForTimeout(2000);
  const card = page.getByText('Board moved idea').first();
  await card.click();
  await page.waitForTimeout(400);
  console.log('sidebar ideas count before:', await page.getByTestId('sidebar-ideas-count').innerText().catch(() => 'none'));
  await page.keyboard.press(']');
  await page.waitForTimeout(2500);
  const after = await db.query(
    `select v.title, s.kind from public.videos v join public.stages s on s.id=v.stage_id where v.title='Board moved idea'`,
  );
  console.log('after ] :', JSON.stringify(after.rows));
  console.log('sidebar ideas count after move (same page):', await page.getByTestId('sidebar-ideas-count').innerText().catch(() => 'none'));
  // now soft-navigate to the bank through the sidebar link
  await page.getByRole('link', { name: 'Ideas', exact: true }).click();
  await page.waitForURL('**/ideas');
  await page.waitForTimeout(1500);
  const bank = await page.getByTestId('idea-bank').innerText();
  console.log('BANK AFTER BOARD MOVE:\n', bank.slice(0, 1200));
  console.log('bank still lists the moved video?', bank.includes('Board moved idea'));
  console.log('sidebar ideas count on bank:', await page.getByTestId('sidebar-ideas-count').innerText().catch(() => 'none'));
  await page.screenshot({ path: 'e2e/screenshots/adv-bank-after-board-move.png', fullPage: true });
});

test('G: promote then sidebar count and matrix', async ({ page }) => {
  await signIn(page);
  const channel = await channelRow();
  await page.goto(`/c/${CHANNEL.slug}/ideas`);
  await expect(page.locator('[data-testid="idea-bank"][data-ready="true"]')).toBeVisible();
  const before = await page.getByTestId('sidebar-ideas-count').innerText().catch(() => 'none');
  console.log('sidebar before promote:', before);
  const promoteButtons = page.getByRole('button', { name: 'Promote' });
  console.log('promote buttons:', await promoteButtons.count());
  if (await promoteButtons.count()) {
    await promoteButtons.first().click();
    await page.waitForTimeout(2500);
  }
  console.log('sidebar after promote:', await page.getByTestId('sidebar-ideas-count').innerText().catch(() => 'none'));
  console.log('BANK:\n', (await page.getByTestId('idea-bank').innerText()).slice(0, 900));
  const rows = await db.query(
    `select v.title, s.kind from public.videos v join public.stages s on s.id=v.stage_id where v.channel_id=$1 order by v.created_at`,
    [channel.id],
  );
  console.log('DB:', JSON.stringify(rows.rows));
  await page.screenshot({ path: 'e2e/screenshots/adv-promote2.png', fullPage: true });

  // matrix should count packaged/promoted videos too
  await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix`);
  await page.waitForTimeout(1200);
  const offGrid = page.getByTestId('matrix-off-grid');
  console.log('off grid:', await offGrid.innerText().catch(() => 'none'));
  const cellsText = await page.getByTestId('matrix-grid').innerText();
  console.log('MATRIX:\n', cellsText.slice(0, 1200));
  await page.screenshot({ path: 'e2e/screenshots/adv-matrix-populated.png', fullPage: true });
});
