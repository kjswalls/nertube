import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { addDays, todayColumn } from '../lib/calendar-dates';
import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/** Reviewer scratch spec — deleted after the review. */

const CH = { name: 'ZZ Reviewer Camera', slug: 'zz-reviewer-camera' } as const;
const CH2 = { name: 'QQ Reviewer Second', slug: 'qq-reviewer-second' } as const;

const TODAY = todayColumn(Date.now());
const SOON = addDays(TODAY, 10) as string;
const LATER = addDays(TODAY, 17) as string;
const PAST = addDays(TODAY, -9) as string;

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
  await db?.query(
    `delete from public.videos where channel_id in (select id from public.channels where slug = any($1::text[]))`,
    [[CH.slug, CH2.slug]],
  );
  await db?.query('delete from public.filming_days');
  await db?.query('delete from public.channels where slug = any($1::text[])', [
    [CH.slug, CH2.slug],
  ]);
  await db?.end();
});

async function channelRow(slug: string) {
  const r = await db.query<{ id: string; user_id: string }>(
    'select id, user_id from public.channels where slug = $1',
    [slug],
  );
  return r.rows[0] ?? null;
}

async function stageIdFor(channelId: string, kind: string) {
  const r = await db.query<{ id: string }>(
    'select id from public.stages where channel_id = $1 and kind = $2',
    [channelId, kind],
  );
  return r.rows[0].id;
}

async function seedVideo(slug: string, title: string, kind = 'filming', target: string | null = null) {
  const channel = (await channelRow(slug))!;
  const stageId = await stageIdFor(channel.id, kind);
  const r = await db.query<{ id: string }>(
    `insert into public.videos (user_id, channel_id, stage_id, title, thumbnail_concept, hooks, target_publish_date)
     values ($1,$2,$3,$4,'A kettle mid-pour','[{"id":"h1","text":"hook","chosen":true}]'::jsonb,$5) returning id`,
    [channel.user_id, channel.id, stageId, title, target],
  );
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

test('A: badge to booked day, interactions counted', async ({ page }) => {
  await signIn(page);
  await createChannel(page, CH);
  await createChannel(page, CH2);
  await seedVideo(CH.slug, 'ZZ one');
  await seedVideo(CH.slug, 'ZZ two');
  await seedVideo(CH2.slug, 'QQ three');

  await page.goto(`/c/${CH.slug}/board`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');

  const badge = page.getByTestId('filming-badge');
  await expect(badge).toBeVisible();
  console.log('BADGE TEXT:', (await badge.textContent())?.trim());

  // interaction 1
  await badge.click();
  const dialog = page.getByTestId('schedule-day-dialog');
  await expect(dialog).toBeVisible();
  const date = page.getByTestId('filming-day-date');
  console.log('DEFAULT DATE:', await date.inputValue(), 'today=', TODAY);
  const boxes = page.getByTestId('filming-candidate');
  console.log('CANDIDATES:', await boxes.count());
  console.log('DIALOG TEXT:\n', (await dialog.innerText()));

  // interaction 2
  await page.getByTestId('schedule-day-submit').click();
  await expect(page.getByTestId('filming-day-panel')).toBeVisible();
  const rows = await db.query(
    `select f.on_date, count(v.id) from public.filming_days f left join public.videos v on v.filming_day_id=f.id group by f.on_date`,
  );
  console.log('DB AFTER 2 CLICKS:', JSON.stringify(rows.rows));
  console.log('PANEL:\n', await page.getByTestId('filming-day-panel').innerText());
  await page.screenshot({ path: 'e2e/screenshots/zz-dialog.png' });
});

test('B: a video already on a day is silently moved by a second booking', async ({ page }) => {
  await signIn(page);
  // state: from test A there is one day with 3 videos
  const before = await db.query(
    `select f.id, f.on_date, array_agg(v.title order by v.title) as titles
       from public.filming_days f left join public.videos v on v.filming_day_id=f.id group by f.id, f.on_date`,
  );
  console.log('BEFORE:', JSON.stringify(before.rows));

  await page.goto(`/c/${CH.slug}/board`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
  const badge = page.getByTestId('filming-badge');
  console.log('BADGE STILL SAYS:', (await badge.textContent())?.trim());
  await badge.click();
  const dialog = page.getByTestId('schedule-day-dialog');
  console.log('DIALOG (all already booked):\n', await dialog.innerText());
  // pick a different date
  await page.getByTestId('filming-day-date').fill(LATER);
  await page.getByTestId('schedule-day-submit').click();
  await expect(page.getByTestId('filming-day-panel')).toBeVisible();
  const after = await db.query(
    `select f.id, f.on_date, count(v.id) as n
       from public.filming_days f left join public.videos v on v.filming_day_id=f.id group by f.id, f.on_date order by f.on_date`,
  );
  console.log('AFTER:', JSON.stringify(after.rows));
  const toast = await page.getByRole('status').allInnerTexts();
  console.log('TOASTS:', JSON.stringify(toast));
});

test('C: calendar, past day history, and what the header offers', async ({ page }) => {
  await signIn(page);
  // clear days, build a past day whose videos moved on
  await db.query('update public.videos set filming_day_id = null');
  await db.query('delete from public.filming_days');
  const channel = (await channelRow(CH.slug))!;
  const day = await db.query<{ id: string }>(
    `insert into public.filming_days (user_id, on_date, notes) values ($1,$2,'Grey shirt, kitchen set') returning id`,
    [channel.user_id, PAST],
  );
  const editing = await stageIdFor(channel.id, 'editing');
  const v1 = await seedVideo(CH.slug, 'ZZ shot and cut', 'editing', addDays(TODAY, 3) as string);
  const v2 = await seedVideo(CH.slug, 'ZZ shot and cut two', 'editing', null);
  await db.query('update public.videos set filming_day_id=$1, stage_id=$2 where id = any($3::uuid[])', [
    day.rows[0].id, editing, [v1, v2],
  ]);

  const month = PAST.slice(0, 7);
  await page.goto(`/calendar?month=${month}&day=${PAST}`);
  await expect(page.getByTestId('calendar-grid')).toBeVisible();
  console.log('PAST DAY PANEL:\n', await page.getByTestId('calendar-day-panel').innerText());
  console.log('HEADER AREA:\n', (await page.locator('main').innerText()).slice(0, 1200));
  console.log('WAITING BANNER PRESENT:', await page.getByTestId('calendar-waiting-for-a-day').count());
  console.log('SCHEDULE BUTTON PRESENT:', await page.getByTestId('schedule-filming-day').count());
  await page.screenshot({ path: 'e2e/screenshots/zz-past-day.png', fullPage: true });
});

test('D: the current month, both channels, both event types', async ({ page }) => {
  await signIn(page);
  const channel = (await channelRow(CH.slug))!;
  const soonDay = await db.query<{ id: string }>(
    `insert into public.filming_days (user_id, on_date, notes) values ($1,$2,null) returning id`,
    [channel.user_id, SOON],
  );
  const f1 = await seedVideo(CH.slug, 'ZZ to shoot A', 'filming', addDays(TODAY, 20) as string);
  await seedVideo(CH2.slug, 'QQ to shoot B', 'filming', null);
  await seedVideo(CH.slug, 'ZZ goes out soon', 'packaging', addDays(TODAY, 2) as string);
  await seedVideo(CH2.slug, 'QQ goes out soon', 'packaging', addDays(TODAY, 4) as string);
  await db.query('update public.videos set filming_day_id=$1 where id=$2', [soonDay.rows[0].id, f1]);

  await page.goto('/calendar');
  await expect(page.getByTestId('calendar-grid')).toBeVisible();
  console.log('CAL MAIN:\n', await page.locator('main').innerText());
  const chips = page.getByTestId('calendar-chip');
  const n = await chips.count();
  for (let i = 0; i < n; i += 1) {
    const c = chips.nth(i);
    console.log('CHIP', await c.getAttribute('data-kind'), await c.getAttribute('data-date'), JSON.stringify(await c.innerText()), 'title=', await c.getAttribute('title'));
  }
  await page.screenshot({ path: 'e2e/screenshots/zz-month.png', fullPage: true });

  await page.goto('/now');
  console.log('NOW:\n', (await page.locator('main').innerText()).slice(0, 2000));
});
