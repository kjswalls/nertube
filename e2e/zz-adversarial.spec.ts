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

async function ensureChannel(page: Page): Promise<{ id: string; user_id: string }> {
  const existing = await db.query('select id, user_id from public.channels where slug = $1', [
    CHANNEL.slug,
  ]);
  if (existing.rows[0]) return existing.rows[0];
  await page.goto('/c/new');
  await page.getByLabel('Channel name').fill(CHANNEL.name);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.waitForURL(`**/c/${CHANNEL.slug}/board`);
  const created = await db.query('select id, user_id from public.channels where slug = $1', [
    CHANNEL.slug,
  ]);
  return created.rows[0];
}

test('A: fresh channel matrix', async ({ page }) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix`);
  const needs = page.getByTestId('matrix-needs-buckets');
  console.log('NEEDS BUCKETS VISIBLE:', await needs.isVisible().catch(() => false));
  console.log('BODY:\n', (await page.locator('main').innerText()).slice(0, 1500));
  await page.screenshot({ path: 'e2e/screenshots/adv-fresh-matrix.png', fullPage: true });
  // any UI route to create a vertical?
  const addBtn = page.getByTestId('add-buckets');
  console.log('add-buckets disabled:', await addBtn.getAttribute('disabled'), await addBtn.innerText());
  console.log('channel', channel.id);
});

test('B: populate buckets by SQL then walk the matrix', async ({ page }) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  await db.query(
    `insert into public.buckets (user_id, channel_id, axis, name, position, monthly_quota)
     values ($1,$2,'vertical','Money',1,2), ($1,$2,'vertical','Craft',2,null), ($1,$2,'vertical','Health',3,null)
     on conflict (channel_id, axis, name) do nothing`,
    [channel.user_id, channel.id],
  );
  await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix`);
  const grid = page.getByTestId('matrix-grid');
  await expect(grid).toBeVisible();
  console.log('grid verticals/horizontals:', await grid.getAttribute('data-verticals'), await grid.getAttribute('data-horizontals'));

  const cells = page.getByTestId('matrix-cell');
  console.log('cell count:', await cells.count());

  // Interaction count: empty cell -> captured idea
  const cell = cells.filter({ has: page.locator('[data-empty="true"]') }).first();
  const target = page.locator('[data-testid="matrix-cell"][data-vertical="Money"][data-horizontal="review"]');
  console.log('target empty?', await target.getAttribute('data-empty'));
  let interactions = 0;
  await target.click(); // 1
  interactions += 1;
  const modal = page.getByTestId('matrix-capture');
  await expect(modal).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/adv-cell-modal.png' });
  console.log('MODAL TEXT:\n', await modal.innerText());
  await page.getByRole('textbox', { name: 'Idea' }).fill('Adversarial money review'); // typing
  await page.getByRole('textbox', { name: 'Idea' }).press('Enter'); // 2
  interactions += 1;
  await expect(modal).toBeHidden();
  console.log('INTERACTIONS empty cell -> captured:', interactions);

  const row = await db.query(
    `select v.title, v.vertical_id, v.horizontal_id, s.kind
       from public.videos v join public.stages s on s.id = v.stage_id
      where v.title = 'Adversarial money review'`,
  );
  console.log('DB ROW:', JSON.stringify(row.rows));

  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'e2e/screenshots/adv-after-capture.png', fullPage: true });
  console.log('target after capture, data-empty:', await target.getAttribute('data-empty'), 'count:', await target.getAttribute('data-count'));
});

test('C: capture fast path and disclosure', async ({ page }) => {
  await signIn(page);
  await ensureChannel(page);
  await page.goto(`/c/${CHANNEL.slug}/board`);
  await page.waitForTimeout(1200);
  await page.keyboard.press('c');
  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();
  console.log('FAST PATH MODAL TEXT:\n', await modal.innerText());
  console.log('vertical picker present before disclosure:', await page.getByLabel('Topic pillar').count());
  await page.getByRole('textbox', { name: 'Idea' }).fill('Fast path idea');
  await page.getByRole('textbox', { name: 'Idea' }).press('Enter');
  await expect(modal).toBeHidden();
  const row = await db.query(
    `select v.title, s.kind from public.videos v join public.stages s on s.id=v.stage_id where v.title='Fast path idea'`,
  );
  console.log('FAST PATH ROW:', JSON.stringify(row.rows));

  // disclosure
  await page.keyboard.press('c');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('textbox', { name: 'Idea' }).fill('Disclosure idea');
  await page.getByRole('textbox', { name: 'Idea' }).press('Shift+Enter');
  await page.waitForTimeout(800);
  console.log('AFTER SHIFT+ENTER:\n', await page.getByRole('dialog').innerText());
  await page.screenshot({ path: 'e2e/screenshots/adv-disclosure.png' });
  await page.keyboard.press('Escape');
});

test('D: promote and the packaging gate', async ({ page }) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  await page.goto(`/c/${CHANNEL.slug}/ideas`);
  await expect(page.locator('[data-testid="idea-bank"][data-ready="true"]')).toBeVisible();
  console.log('BANK:\n', (await page.getByTestId('idea-bank').innerText()).slice(0, 2000));
  await page.screenshot({ path: 'e2e/screenshots/adv-bank.png', fullPage: true });

  await page.keyboard.press('j');
  await page.waitForTimeout(300);
  await page.keyboard.press('p');
  await page.waitForTimeout(2500);
  const rows = await db.query(
    `select v.title, s.kind, v.stage_entered_at from public.videos v join public.stages s on s.id=v.stage_id
      where v.channel_id = $1 order by v.created_at desc`,
    [channel.id],
  );
  console.log('AFTER PROMOTE:', JSON.stringify(rows.rows));
  await page.screenshot({ path: 'e2e/screenshots/adv-after-promote.png', fullPage: true });

  // now try to move the promoted one past packaging from the board
  const promoted = rows.rows.find((r) => r.kind === 'packaging');
  console.log('promoted title:', promoted?.title);
});
