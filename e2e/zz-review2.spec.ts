import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { addDays, todayColumn } from '../lib/calendar-dates';
import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

const CH = { name: 'ZZ Reviewer Camera', slug: 'zz-reviewer-camera' } as const;
const TODAY = todayColumn(Date.now());
const MISSED = addDays(TODAY, -4) as string;
const DONE = addDays(TODAY, -11) as string;

let db: pg.Client;

test.beforeAll(async () => {
  db = new pg.Client({ host: PG.host, port: PG.port, user: PG.user,
    password: PG.password === '' ? undefined : PG.password, database: PG.database });
  await db.connect();
});
test.afterAll(async () => {
  await db?.query(`delete from public.videos where channel_id in (select id from public.channels where slug=$1)`, [CH.slug]);
  await db?.query('delete from public.filming_days');
  await db?.query('delete from public.channels where slug=$1', [CH.slug]);
  await db?.end();
});

async function channelRow(slug: string) {
  const r = await db.query<{ id: string; user_id: string }>('select id, user_id from public.channels where slug=$1', [slug]);
  return r.rows[0] ?? null;
}
async function stageIdFor(channelId: string, kind: string) {
  const r = await db.query<{ id: string }>('select id from public.stages where channel_id=$1 and kind=$2', [channelId, kind]);
  return r.rows[0].id;
}
async function seedVideo(slug: string, title: string, kind = 'filming') {
  const c = (await channelRow(slug))!;
  const s = await stageIdFor(c.id, kind);
  const r = await db.query<{ id: string }>(
    `insert into public.videos (user_id, channel_id, stage_id, title, thumbnail_concept, hooks)
     values ($1,$2,$3,$4,'x','[{"id":"h1","text":"h","chosen":true}]'::jsonb) returning id`, [c.user_id, c.id, s, title]);
  return r.rows[0].id;
}
async function signIn(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}
async function createChannel(page: Page, c: { name: string; slug: string }) {
  await page.goto('/c/new');
  await page.getByLabel('Channel name').fill(c.name);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.waitForURL(`**/c/${c.slug}/board`);
}

test.describe.configure({ mode: 'serial' });

test('E: a missed filming day on the grid vs one that happened', async ({ page }) => {
  await signIn(page);
  await createChannel(page, CH);
  await db.query('update public.videos set filming_day_id=null');
  await db.query('delete from public.filming_days');
  const c = (await channelRow(CH.slug))!;

  const missed = (await db.query<{ id: string }>(
    `insert into public.filming_days (user_id, on_date, notes) values ($1,$2,'Did not happen') returning id`, [c.user_id, MISSED])).rows[0].id;
  const done = (await db.query<{ id: string }>(
    `insert into public.filming_days (user_id, on_date, notes) values ($1,$2,'Happened') returning id`, [c.user_id, DONE])).rows[0].id;

  const a = await seedVideo(CH.slug, 'ZZ never shot one');
  const b = await seedVideo(CH.slug, 'ZZ never shot two');
  const d1 = await seedVideo(CH.slug, 'ZZ shot fine', 'editing');
  await db.query('update public.videos set filming_day_id=$1 where id=any($2::uuid[])', [missed, [a, b]]);
  await db.query('update public.videos set filming_day_id=$1 where id=$2', [done, d1]);

  const month = MISSED.slice(0, 7);
  await page.goto(`/calendar?month=${month}`);
  await expect(page.getByTestId('calendar-grid')).toBeVisible();

  for (const date of [MISSED, DONE]) {
    const chip = page.getByTestId('calendar-chip').filter({ has: page.locator(`xpath=.`) }).and(page.locator(`[data-date="${date}"][data-kind="filming"]`));
    console.log('---- grid chip for', date, '----');
    console.log('text:', JSON.stringify(await chip.innerText()));
    console.log('class:', await chip.getAttribute('class'));
    console.log('title:', await chip.getAttribute('title'));
    console.log('all data attrs:', await chip.evaluate((el) => JSON.stringify((el as HTMLElement).dataset)));
  }

  for (const date of [MISSED, DONE]) {
    await page.goto(`/calendar?month=${month}&day=${date}`);
    const panel = page.getByTestId('calendar-filming-day-panel');
    console.log('---- day panel', date, 'tone=', await panel.getAttribute('data-tone'), '----');
    console.log(await panel.innerText());
  }
  await page.goto(`/calendar?month=${month}`);
  await page.screenshot({ path: 'e2e/screenshots/zz-missed.png', fullPage: true });
});

test('F: nothing unbooked means no way to book a day from the calendar', async ({ page }) => {
  await signIn(page);
  // park every filming video on a day so nothing is "waiting"
  const c = (await channelRow(CH.slug))!;
  const day = (await db.query<{ id: string }>(
    `select id from public.filming_days where on_date=$1`, [MISSED])).rows[0].id;
  await db.query(
    `update public.videos v set filming_day_id=$1
      from public.stages s where s.id=v.stage_id and s.kind='filming' and v.archived_at is null`, [day]);
  const n = await db.query(`select count(*) from public.videos v join public.stages s on s.id=v.stage_id where s.kind='filming' and v.archived_at is null and v.filming_day_id is null`);
  console.log('unbooked filming videos:', JSON.stringify(n.rows));
  await page.goto('/calendar');
  await expect(page.getByTestId('calendar-grid')).toBeVisible();
  console.log('waiting banner count:', await page.getByTestId('calendar-waiting-for-a-day').count());
  console.log('schedule button count:', await page.getByTestId('schedule-filming-day').count());
  console.log('MAIN:\n', (await page.locator('main').innerText()).slice(0, 700));
});

test('G: an empty calendar month, no channels touched', async ({ page }) => {
  await signIn(page);
  await page.goto('/calendar?month=2031-02');
  console.log('EMPTY MONTH:\n', (await page.locator('main').innerText()).slice(0, 900));
  await page.screenshot({ path: 'e2e/screenshots/zz-empty.png', fullPage: true });
});
