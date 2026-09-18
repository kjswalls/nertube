import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/** REVIEWER SCRATCH — delete after the review. */

test.describe.configure({ mode: 'serial' });

let db: pg.Client;

const CH = { name: 'TZ Probe Channel', slug: 'tz-probe-channel' } as const;

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
    `delete from public.videos where channel_id in (select id from public.channels where slug = $1)`,
    [CH.slug],
  );
  await db?.query(`delete from public.filming_days where notes like 'TZPROBE%'`);
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

async function ensureChannel(page: Page): Promise<void> {
  const existing = await db.query('select id from public.channels where slug = $1', [CH.slug]);
  if (existing.rows.length > 0) return;
  await page.goto('/c/new');
  await page.getByLabel('Channel name').fill(CH.name);
  await page.getByRole('button', { name: /create/i }).click();
  await page.waitForURL(`**/c/${CH.slug}/board`);
}

async function channelRow(): Promise<{ id: string; user_id: string }> {
  const r = await db.query<{ id: string; user_id: string }>(
    'select id, user_id from public.channels where slug = $1',
    [CH.slug],
  );
  if (!r.rows[0]) throw new Error('missing probe channel');
  return r.rows[0];
}

async function stageIdFor(channelId: string, kind: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    'select id from public.stages where channel_id = $1 and kind = $2',
    [channelId, kind],
  );
  return r.rows[0].id;
}

async function seedVideo(
  title: string,
  date: string | null,
  kind = 'editing',
  extra: Record<string, unknown> = {},
): Promise<string> {
  const ch = await channelRow();
  const stageId = await stageIdFor(ch.id, kind);
  const r = await db.query<{ id: string }>(
    `insert into public.videos (user_id, channel_id, stage_id, title, target_publish_date,
       packaging_skipped_at, packaging_skip_reason)
     values ($1,$2,$3,$4,$5::date,$6::timestamptz,$7) returning id`,
    [
      ch.user_id,
      ch.id,
      stageId,
      title,
      date,
      (extra.skippedAt as string) ?? null,
      (extra.skipReason as string) ?? null,
    ],
  );
  return r.rows[0].id;
}

async function seedFilmingDay(onDate: string, notes: string): Promise<string> {
  const ch = await channelRow();
  const r = await db.query<{ id: string }>(
    `insert into public.filming_days (user_id, on_date, notes) values ($1,$2::date,$3)
     on conflict (user_id, on_date) do update set notes = excluded.notes returning id`,
    [ch.user_id, onDate, notes],
  );
  return r.rows[0].id;
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/* -------------------------------------------------------------------------- */

test('A: packaging-skip date renders identically on server and client', async ({ page }) => {
  await signIn(page);
  await ensureChannel(page);
  // A skip stamp near midnight UTC so a zone east or west of it lands on a
  // different calendar day in the browser than on the server.
  const id = await seedVideo('Skip stamp probe', null, 'packaging', {
    skippedAt: '2026-03-03T23:30:00.000Z',
    skipReason: 'Reviewer probe',
  });

  const errors = collectErrors(page);
  await page.goto(`/videos/${id}`);
  await expect(page.getByTestId('packaging-skipped')).toBeVisible();
  const shown = await page.getByTestId('packaging-skipped').innerText();
  console.log('SKIPPED BLOCK (browser tz default):', shown.replace(/\n/g, ' | '));
  // What the server actually sent, before hydration replaced it.
  const res = await page.request.get(`/videos/${id}`);
  const html = await res.text();
  const m = /Skipped\s*<time[^>]*>([^<]*)<\/time>/.exec(html);
  console.log('SERVER HTML SAID:', m?.[1]);
  console.log('CONSOLE ERRORS:', JSON.stringify(errors, null, 1));
});

test.describe('A2 under Pacific/Kiritimati', () => {
  test.use({ timezoneId: 'Pacific/Kiritimati', locale: 'en-US' });
  test('packaging-skip date under +14', async ({ page }) => {
    await signIn(page);
    const r = await db.query<{ id: string }>(
      `select id from public.videos where title = 'Skip stamp probe' limit 1`,
    );
    const id = r.rows[0].id;
    const errors = collectErrors(page);
    await page.goto(`/videos/${id}`);
    await expect(page.getByTestId('packaging-skipped')).toBeVisible();
    console.log(
      'BROWSER (+14, en-US) RENDERED:',
      (await page.getByTestId('packaging-skipped').innerText()).replace(/\n/g, ' | '),
    );
    const res = await page.request.get(`/videos/${id}`);
    const html = await res.text();
    console.log(
      'SERVER HTML SAID:',
      /Skipped\s*<time[^>]*>([^<]*)<\/time>/.exec(html)?.[1],
    );
    console.log('CONSOLE ERRORS:', JSON.stringify(errors, null, 1));
  });
});

test('B: board badge pre-ticks videos already booked on another day', async ({ page }) => {
  await signIn(page);
  await ensureChannel(page);
  // Clear anything left in this channel.
  const ch = await channelRow();
  await db.query('delete from public.videos where channel_id = $1', [ch.id]);
  await db.query(`delete from public.filming_days where notes like 'TZPROBE%'`);

  const dayId = await seedFilmingDay('2027-05-01', 'TZPROBE already booked');
  const booked = await seedVideo('Already booked video', null, 'filming');
  await db.query('update public.videos set filming_day_id = $1 where id = $2', [dayId, booked]);
  await seedVideo('Waiting video one', null, 'filming');
  await seedVideo('Waiting video two', null, 'filming');

  await page.goto('/calendar');
  const waiting = page.getByTestId('calendar-waiting-for-a-day');
  await expect(waiting).toBeVisible();
  console.log('CALENDAR WAITING COUNT:', await waiting.getAttribute('data-count'));
  console.log('CALENDAR WAITING TEXT:', (await waiting.innerText()).replace(/\n/g, ' | '));

  await page.goto(`/c/${CH.slug}/board`);
  const badge = page.getByTestId('filming-badge');
  await expect(badge).toBeVisible();
  console.log('BOARD BADGE TEXT:', await badge.innerText());
  await badge.click();
  const dialog = page.getByTestId('schedule-day-dialog');
  await expect(dialog).toBeVisible();
  const boxes = page.getByTestId('filming-candidate');
  const n = await boxes.count();
  const ticked: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const b = boxes.nth(i);
    const label = await b.locator('xpath=..').innerText();
    ticked.push(`${label.replace(/\n/g, ' ')} => ${await b.isChecked()}`);
  }
  console.log('DIALOG CANDIDATES:', JSON.stringify(ticked, null, 1));

  // Schedule a DIFFERENT date and see what happens to the already-booked video.
  await page.getByTestId('filming-day-date').fill('2027-05-08');
  await page.getByTestId('schedule-day-submit').click();
  await expect(page.getByTestId('filming-day-panel')).toBeVisible();

  const after = await db.query<{ title: string; on_date: string | null }>(
    `select v.title, f.on_date::text as on_date
       from public.videos v left join public.filming_days f on f.id = v.filming_day_id
      where v.channel_id = $1 order by v.title`,
    [ch.id],
  );
  console.log('AFTER SCHEDULING 2027-05-08:', JSON.stringify(after.rows, null, 1));

  const oldDay = await db.query(
    `select f.on_date::text, count(v.id)::int as n from public.filming_days f
       left join public.videos v on v.filming_day_id = f.id
      where f.notes like 'TZPROBE%' group by f.on_date order by f.on_date`,
  );
  console.log('DAYS AFTERWARDS:', JSON.stringify(oldDay.rows, null, 1));
});

test('C: /now needs-a-block chip', async ({ page }) => {
  await signIn(page);
  await page.goto('/now');
  const chips = page.getByTestId('needs-a-block');
  const n = await chips.count();
  console.log('NEEDS-A-BLOCK CHIPS:', n);
  for (let i = 0; i < n; i += 1) {
    const c = chips.nth(i);
    console.log(
      ' chip',
      i,
      'tag=',
      await c.evaluate((el) => el.tagName),
      'kind=',
      await c.getAttribute('data-stage-kind'),
      'href=',
      await c.getAttribute('href'),
    );
  }
});
