import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { addDays, todayColumn } from '../lib/calendar-dates';
import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

const CH = { name: 'ZZ Reviewer Camera', slug: 'zz-reviewer-camera' } as const;
const TODAY = todayColumn(Date.now());
const BOOKED = addDays(TODAY, 8) as string;
const OTHER = addDays(TODAY, 15) as string;

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

test('H: /now shows filming rows by default, contradicting the calendar banner', async ({ page }) => {
  await signIn(page);
  await createChannel(page, CH);
  await db.query('update public.videos set filming_day_id=null');
  await db.query('delete from public.filming_days');
  const c = (await channelRow(CH.slug))!;
  const v = await seedVideo(CH.slug, 'ZZ needs the camera');
  // give it a checklist item so rule 6 fires (that is what tags needsABlock)
  await db.query(
    `insert into public.checklist_items (user_id, video_id, stage_id, text, position, est_minutes)
     values ($1, $2, (select stage_id from public.videos where id=$2), 'Outline visible while filming', 0, 5)`,
    [c.user_id, v],
  );

  await page.goto('/now');
  const main = await page.locator('main').innerText();
  console.log('NOW DEFAULT (no filter):\n', main.slice(0, 1200));
  const chip = page.getByTestId('needs-a-block');
  console.log('needs-a-block count:', await chip.count());
  if (await chip.count()) {
    console.log('chip tag:', await chip.first().evaluate((el) => el.tagName));
    console.log('chip href:', await chip.first().getAttribute('href'));
  }

  await page.goto('/calendar');
  const banner = page.getByTestId('calendar-waiting-for-a-day');
  console.log('BANNER:', (await banner.innerText()).replace(/\n/g, ' '));
});

test('I: the day the badge emptied still says a shoot happened with nothing on it', async ({ page }) => {
  await signIn(page);
  const c = (await channelRow(CH.slug))!;
  const booked = (await db.query<{ id: string }>(
    `insert into public.filming_days (user_id, on_date, notes) values ($1,$2,'Kitchen set, grey shirt') returning id`,
    [c.user_id, BOOKED])).rows[0].id;
  const a = await seedVideo(CH.slug, 'ZZ booked one');
  const b = await seedVideo(CH.slug, 'ZZ booked two');
  await db.query('update public.videos set filming_day_id=$1 where id=any($2::uuid[])', [booked, [a, b]]);

  await page.goto(`/c/${CH.slug}/board`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
  const badge = page.getByTestId('filming-badge');
  console.log('BADGE with everything already booked:', (await badge.textContent())?.trim());
  await badge.click();
  const boxes = page.getByTestId('filming-candidate');
  const n = await boxes.count();
  for (let i = 0; i < n; i += 1) {
    const li = boxes.nth(i).locator('xpath=ancestor::li');
    console.log('candidate row:', JSON.stringify((await li.innerText()).replace(/\n/g, ' | ')), 'checked=', await boxes.nth(i).isChecked());
  }
  await page.getByTestId('filming-day-date').fill(OTHER);
  await page.getByTestId('schedule-day-submit').click();
  await expect(page.getByTestId('filming-day-panel')).toBeVisible();
  const rows = await db.query(`select on_date, (select count(*) from public.videos v where v.filming_day_id=f.id) n from public.filming_days f order by on_date`);
  console.log('DAYS NOW:', JSON.stringify(rows.rows));

  await page.goto(`/calendar?month=${BOOKED.slice(0,7)}&day=${BOOKED}`);
  console.log('THE EMPTIED DAY READS:\n', await page.getByTestId('calendar-filming-day-panel').innerText());
  await page.screenshot({ path: 'e2e/screenshots/zz-emptied.png', fullPage: true });
});
