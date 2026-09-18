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

test('H2: gate past packaging', async ({ page }) => {
  await signIn(page);
  const channel = await channelRow();
  const v = await db.query(
    `select v.id from public.videos v join public.stages s on s.id=v.stage_id
      where v.channel_id=$1 and s.kind='packaging' limit 1`,
    [channel.id],
  );
  const id = v.rows[0].id;
  await page.goto(`/videos/${id}`);
  await page.waitForTimeout(2500);
  await page.getByRole('link', { name: /Schedule/ }).first().click().catch(async () => {
    await page.getByRole('tab', { name: /Schedule/ }).first().click();
  });
  await page.waitForTimeout(1000);
  const select = page.getByTestId('stage-select');
  await select.selectOption({ label: 'Scripting' });
  await page.waitForTimeout(2500);
  console.log('STATUS:', await page.getByTestId('stage-select-status').innerText());
  const after = await db.query(
    `select s.kind from public.videos v join public.stages s on s.id=v.stage_id where v.id=$1`,
    [id],
  );
  console.log('stage after attempted move past packaging:', JSON.stringify(after.rows));
  await page.screenshot({ path: 'e2e/screenshots/adv-gate.png', fullPage: true });
});

test('K2: filter really lands in the URL and survives reload', async ({ page }) => {
  await signIn(page);
  const channel = await channelRow();
  // two ideas so a filter can actually narrow
  await db.query(`delete from public.videos where channel_id=$1 and title like 'Filter %'`, [channel.id]);
  const bk = await db.query(
    `select id, axis, name from public.buckets where channel_id=$1 and name in ('Money','Craft','tutorial')`,
    [channel.id],
  );
  const money = bk.rows.find((b) => b.name === 'Money');
  const craft = bk.rows.find((b) => b.name === 'Craft');
  const tutorial = bk.rows.find((b) => b.name === 'tutorial');
  await db.query(
    `insert into public.videos (user_id, channel_id, stage_id, title, vertical_id, horizontal_id, tags)
     select $1,$2,s.id,'Filter money one',$3,$4,array['gear'] from public.stages s where s.channel_id=$2 and s.kind='idea'`,
    [channel.user_id, channel.id, money.id, tutorial.id],
  );
  await db.query(
    `insert into public.videos (user_id, channel_id, stage_id, title, vertical_id, horizontal_id)
     select $1,$2,s.id,'Filter craft two',$3,$4 from public.stages s where s.channel_id=$2 and s.kind='idea'`,
    [channel.user_id, channel.id, craft.id, tutorial.id],
  );

  await page.goto(`/c/${CHANNEL.slug}/ideas`);
  await expect(page.locator('[data-testid="idea-bank"][data-ready="true"]')).toBeVisible();
  await page.getByTestId('idea-vertical-filter').selectOption(money.id);
  await page.waitForTimeout(800);
  console.log('URL after vertical filter:', page.url());
  console.log('BANK:\n', (await page.getByTestId('idea-bank').innerText()).slice(0, 600));
  await page.getByPlaceholder(/Search/i).fill('money');
  await page.waitForTimeout(800);
  console.log('URL after search:', page.url());
  await page.reload();
  await page.waitForTimeout(1500);
  console.log('URL after reload:', page.url());
  console.log('BANK after reload:\n', (await page.getByTestId('idea-bank').innerText()).slice(0, 600));

  // Back button behaviour
  await page.goBack();
  await page.waitForTimeout(1200);
  console.log('URL after Back:', page.url());

  // switch to matrix and back to list: are the filters kept?
  await page.goto(`/c/${CHANNEL.slug}/ideas?${new URLSearchParams({ vertical: money.id }).toString()}`);
  await page.waitForTimeout(1200);
  await page.getByRole('link', { name: 'Matrix' }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('link', { name: 'List' }).click();
  await page.waitForTimeout(1500);
  console.log('URL after Matrix->List round trip:', page.url());
  console.log('BANK:\n', (await page.getByTestId('idea-bank').innerText()).slice(0, 600));
});

test('L: empty-filter interplay and quota over 100', async ({ page }) => {
  await signIn(page);
  const channel = await channelRow();
  // a quota bucket with target dates this month
  const money = (
    await db.query(`select id from public.buckets where channel_id=$1 and name='Money'`, [channel.id])
  ).rows[0];
  await db.query(`update public.buckets set monthly_quota=2 where id=$1`, [money.id]);
  await db.query(
    `update public.videos set target_publish_date = date_trunc('month', now())::date + 5
      where channel_id=$1 and vertical_id=$2`,
    [channel.id, money.id],
  );
  await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix`);
  await page.waitForTimeout(1500);
  const meters = page.getByTestId('quota-meter');
  const n = await meters.count();
  for (let i = 0; i < n; i += 1) {
    console.log('quota meter:', await meters.nth(i).getAttribute('data-bucket'), await meters.nth(i).getAttribute('data-count'), '/', await meters.nth(i).getAttribute('data-quota'), 'met=', await meters.nth(i).getAttribute('data-met'));
  }
  const rows = await db.query(
    `select v.title, v.target_publish_date, s.kind from public.videos v join public.stages s on s.id=v.stage_id
      where v.channel_id=$1 and v.vertical_id=$2`,
    [channel.id, money.id],
  );
  console.log('money videos:', JSON.stringify(rows.rows));
  await page.screenshot({ path: 'e2e/screenshots/adv-quota.png', fullPage: true });
});
