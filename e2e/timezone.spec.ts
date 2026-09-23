import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';

import {
  CHANNEL_DEFAULTS,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
} from '../lib/defaults';
import { PG } from '../scripts/dev-stack/shared';
import { untilTaken } from './hydration';

/**
 * M10: "today" is the user's day.
 *
 * The spec stands at **20:00 UTC on a Saturday** — 13:00 on Saturday in Los
 * Angeles and 08:00 or 09:00 on Sunday in Auckland, so the two zones disagree
 * about the date whatever the season — and proves that the calendar's today,
 * `/now`'s go-live check and the board all agree with each other and with the
 * zone the account is set to, that Settings changes it, and that the setting
 * belongs to the account (a second device in a third zone neither sees nor
 * overwrites a different answer).
 *
 * ## Standing at an instant
 *
 * "Today" is decided on the server, so moving the browser's clock alone would
 * prove nothing. Each context carries the `nertube-test-clock` cookie, which
 * the app reads because Playwright starts it with `NERTUBE_TEST_CLOCK=1`
 * (`lib/request-clock.ts`), and the browser's own clock is fixed to the same
 * instant with `page.clock`. The browser's zone is Playwright's `timezoneId`,
 * which is also what sign-in records for an account with no zone yet.
 *
 * The instant is the first Saturday at least two days after the real date, so
 * everything this spec creates "now" is in its past, and the dates are real
 * dates rather than a pinned September that rots.
 *
 * Its own account, created and removed here, so the seed account's zone —
 * which every other spec's "today" is computed in — is never touched.
 */

const EMAIL = 'timezone-spec@nertube.test';
const PASSWORD = 'timezone-spec-password';
const CHANNEL = { name: 'Time zone spec', slug: 'time-zone-spec' };

const AUCKLAND = 'Pacific/Auckland';
const LOS_ANGELES = 'America/Los_Angeles';
const LONDON = 'Europe/London';

const DAY_MS = 86_400_000;

/** 20:00 UTC on the first Saturday at least two days after today. */
function standingInstant(): number {
  const now = new Date();
  let at = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2, 20);
  while (new Date(at).getUTCDay() !== 6) at += DAY_MS;
  return at;
}

const AT = standingInstant();

/** The date an instant falls on in a zone — `Intl` directly, not the helper under test. */
function dateIn(zone: string, ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms);
}

/** `YYYY-MM-DD` plus whole days, in plain UTC arithmetic. */
function plusDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** `Sunday 27 September 2026`, the way the app words a day. */
function fullDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(Date.UTC(y, m - 1, d));
}

/** `27 Sept`, the way `/now` words a go-live date. */
function shortDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(Date.UTC(y, m - 1, d));
}

const LA_TODAY = dateIn(LOS_ANGELES, AT); // a Saturday
const AUCKLAND_TODAY = dateIn(AUCKLAND, AT); // the Sunday after it
const UTC_TODAY = dateIn('UTC', AT); // the Saturday

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

let db: pg.Client;
let userId: string;
let channelId: string;
let scheduledId: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(AUCKLAND_TODAY).toBe(plusDays(LA_TODAY, 1));
  expect(UTC_TODAY).toBe(LA_TODAY);

  db = new pg.Client({
    host: PG.host,
    port: PG.port,
    user: PG.user,
    password: PG.password === '' ? undefined : PG.password,
    database: PG.database,
  });
  await db.connect();
  await removeUser();
  const created = await db.query<{ id: string }>(
    `insert into auth.users (email, encrypted_password, email_confirmed_at, aud, role)
     values (lower($1), crypt($2, gen_salt('bf')), now(), 'authenticated', 'authenticated')
     returning id`,
    [EMAIL, PASSWORD],
  );
  userId = created.rows[0].id;
  channelId = await createChannel();

  // One video going live on Auckland's Sunday: due there, a day away in
  // Los Angeles.
  scheduledId = await capture('Goes live on the Sunday');
  await db.query(
    `update public.videos
        set stage_id = $2, target_publish_date = $3::date,
            thumbnail_concept = 'A concept', hooks = $4::jsonb
      where id = $1`,
    [
      scheduledId,
      await stageIdOf('scheduled'),
      AUCKLAND_TODAY,
      JSON.stringify([{ id: 'h1', text: 'A hook', chosen: true }]),
    ],
  );

  // Three in Filming, so the board shows its batch-day badge — the board's
  // one control that opens on a date computed from today.
  const filming = await stageIdOf('filming');
  for (const title of ['Shoot one', 'Shoot two', 'Shoot three']) {
    const id = await capture(title);
    await db.query('update public.videos set stage_id = $2 where id = $1', [id, filming]);
  }
});

test.afterAll(async () => {
  await removeUser().catch(() => {});
  await db?.end();
});

/** Every row this account made goes with it: `user_id` cascades everywhere. */
async function removeUser(): Promise<void> {
  await db.query('delete from auth.users where lower(email) = lower($1)', [EMAIL]);
}

/** Run `fn` the way a PostgREST request runs it: that role, those claims. */
async function asUser<T>(fn: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated', email: EMAIL }),
    ]);
    await db.query('set local role authenticated');
    const result = await fn();
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback').catch(() => {});
    throw error;
  }
}

async function createChannel(): Promise<string> {
  const stages = SEED_STAGES.map((stage) => ({
    name: stage.name,
    kind: stage.kind,
    position: stage.position,
    templates: SEED_CHECKLISTS[stage.kind].map((item, index) => ({
      text: item.text,
      position: index + 1,
      est_minutes: item.est_minutes,
    })),
  }));
  return asUser(async () => {
    const result = await db.query<{ id: string }>(
      `select id from create_channel($1::text, $2::text, $3::text, $4::int, $5::int,
                                     $6::numeric, $7::text, $8::jsonb, $9::jsonb)`,
      [
        CHANNEL.name,
        CHANNEL.slug,
        SCRIPT_TEMPLATE,
        CHANNEL_DEFAULTS.wip_threshold,
        CHANNEL_DEFAULTS.stale_days,
        CHANNEL_DEFAULTS.expected_ctr,
        CHANNEL_DEFAULTS.voice_guide,
        JSON.stringify(stages),
        JSON.stringify(SEED_BUCKETS.map((bucket) => ({ ...bucket, monthly_quota: null }))),
      ],
    );
    return result.rows[0].id;
  });
}

async function capture(title: string): Promise<string> {
  return asUser(async () => {
    const result = await db.query<{ id: string }>(
      'select id from capture_video($1::uuid, $2::text)',
      [channelId, title],
    );
    return result.rows[0].id;
  });
}

async function stageIdOf(kind: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    'select id from public.stages where channel_id = $1 and kind = $2',
    [channelId, kind],
  );
  return result.rows[0].id;
}

async function storedZone(): Promise<{ time_zone: string; time_zone_source: string } | null> {
  const result = await db.query<{ time_zone: string; time_zone_source: string }>(
    'select time_zone, time_zone_source from public.profiles where user_id = $1',
    [userId],
  );
  return result.rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Browser                                                                     */
/* -------------------------------------------------------------------------- */

interface Device {
  context: BrowserContext;
  page: Page;
  /** Every hydration complaint the page logged; each test expects none. */
  hydrationErrors: string[];
}

/**
 * A browser in `zone`, standing at `AT` on both sides: the server by cookie,
 * the page by `page.clock`.
 */
async function device(
  browser: Browser,
  baseURL: string,
  zone: string,
  phone = false,
): Promise<Device> {
  const context = await browser.newContext({
    baseURL,
    timezoneId: zone,
    ...(phone
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1440, height: 1000 } }),
  });
  await context.addCookies([
    { name: 'nertube-test-clock', value: String(AT), url: baseURL },
  ]);
  const page = await context.newPage();
  await page.clock.setFixedTime(AT);
  const hydrationErrors: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && /hydrat|did not match/i.test(text)) {
      hydrationErrors.push(text);
    }
  });
  return { context, page, hydrationErrors };
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}

/** The calendar's today cell says `date`. */
async function expectCalendarToday(page: Page, date: string): Promise<void> {
  await page.goto('/calendar');
  const today = page.locator('[data-testid="calendar-day"][data-today="true"]');
  await expect(today).toHaveCount(1);
  await expect(today).toHaveAttribute('data-date', date);
}

/** `/now`'s row for the Sunday video: Ready to confirm, or waiting for its date. */
async function expectGoLive(page: Page, due: boolean): Promise<void> {
  await page.goto('/now');
  await expect(page.getByTestId('now')).toHaveAttribute('data-ready', 'true');
  const row = page.locator(`[data-testid="now-row"][data-video-id="${scheduledId}"]`);
  await expect(row).toHaveAttribute('data-rule', '5');
  if (due) {
    await expect(row).toHaveAttribute('data-section', 'ready');
    await expect(row.getByTestId('now-label')).toHaveText('Confirm live + record URL');
  } else {
    await expect(row).toHaveAttribute('data-section', 'waiting');
    await expect(row.getByTestId('now-label')).toHaveText(`Goes live ${shortDate(AUCKLAND_TODAY)}`);
  }
}

/**
 * The board's batch-day badge opens its dialog on the first Saturday on or
 * after today — so on Saturday it is today, and on Sunday it is six days on.
 */
async function expectBoardSaturday(page: Page, saturday: string): Promise<void> {
  await page.goto(`/c/${CHANNEL.slug}/board`);
  const badge = page.getByTestId('filming-badge');
  const date = page.getByTestId('filming-day-date');
  await untilTaken(
    () => badge.click(),
    () => expect(date).toBeVisible({ timeout: 2_000 }),
  );
  await expect(date).toHaveValue(saturday);
  await page.keyboard.press('Escape');
}

/* -------------------------------------------------------------------------- */
/* The tests                                                                   */
/* -------------------------------------------------------------------------- */

test("sign-in records the browser's zone, and Auckland's Sunday is today everywhere", async ({
  browser,
  baseURL,
}) => {
  const auckland = await device(browser, baseURL!, AUCKLAND);
  const { page } = auckland;

  await signIn(page);
  expect(await storedZone()).toEqual({ time_zone: AUCKLAND, time_zone_source: 'detected' });

  await expectCalendarToday(page, AUCKLAND_TODAY);
  await expect(page.getByTestId('time-zone-notice')).toHaveCount(0);
  await expectGoLive(page, true);
  await expectBoardSaturday(page, plusDays(AUCKLAND_TODAY, 6));

  await page.goto('/settings/account');
  await expect(page.getByTestId('time-zone-select')).toHaveValue(AUCKLAND);
  await expect(page.getByTestId('time-zone-today')).toContainText(fullDate(AUCKLAND_TODAY));
  await expect(page.getByTestId('time-zone-today')).toContainText('Auckland');

  expect(auckland.hydrationErrors).toEqual([]);
  await auckland.context.close();
});

test('choosing Los Angeles in Settings moves today back to Saturday everywhere', async ({
  browser,
  baseURL,
}) => {
  const laptop = await device(browser, baseURL!, AUCKLAND);
  const { page } = laptop;
  await signIn(page);

  await page.goto('/settings/account');
  const select = page.getByTestId('time-zone-select');
  const status = page.getByTestId('time-zone-status');
  await untilTaken(
    () => select.selectOption(LOS_ANGELES).then(() => undefined),
    () => expect(status).toContainText('Not saved yet', { timeout: 2_000 }),
  );
  await page.getByTestId('time-zone-save').click();
  await expect(status).toHaveText('Saved');
  expect(await storedZone()).toEqual({ time_zone: LOS_ANGELES, time_zone_source: 'chosen' });
  await expect(page.getByTestId('time-zone-today')).toContainText(fullDate(LA_TODAY));
  await expect(page.getByTestId('time-zone-today')).toContainText('Los Angeles');

  await expectCalendarToday(page, LA_TODAY);
  await expectGoLive(page, false);
  await expectBoardSaturday(page, LA_TODAY);

  expect(laptop.hydrationErrors).toEqual([]);
  await laptop.context.close();
});

test('the choice belongs to the account: a phone in London sees it and does not replace it', async ({
  browser,
  baseURL,
}) => {
  const phone = await device(browser, baseURL!, LONDON, true);
  const { page } = phone;
  await signIn(page);

  // Detection at sign-in never overwrites a chosen zone.
  expect(await storedZone()).toEqual({ time_zone: LOS_ANGELES, time_zone_source: 'chosen' });

  await expectCalendarToday(page, LA_TODAY);
  await expectGoLive(page, false);

  await page.goto('/settings/account');
  const select = page.getByTestId('time-zone-select');
  await expect(select).toHaveValue(LOS_ANGELES);
  // The phone offers its own zone, rather than taking it.
  await expect(page.getByTestId('time-zone-use-device')).toHaveText('Use London');

  // Comfortable on a phone: a 16px select (no zoom on focus), 44px targets,
  // nothing wider than the screen.
  const metrics = await select.evaluate((element) => {
    const style = getComputedStyle(element);
    return { fontSize: style.fontSize, height: element.getBoundingClientRect().height };
  });
  expect(metrics.fontSize).toBe('16px');
  expect(metrics.height).toBeGreaterThanOrEqual(44);
  const save = await page.getByTestId('time-zone-save').boundingBox();
  expect(save!.height).toBeGreaterThanOrEqual(44);
  const useDevice = await page.getByTestId('time-zone-use-device').boundingBox();
  expect(useDevice!.height).toBeGreaterThanOrEqual(44);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);

  expect(phone.hydrationErrors).toEqual([]);
  await phone.context.close();
});

test('a session with no zone yet says UTC, then records the browser’s once and refreshes', async ({
  browser,
  baseURL,
}) => {
  const auckland = await device(browser, baseURL!, AUCKLAND);
  const { page } = auckland;
  await signIn(page);

  // As if this session predated M10: signed in, nothing recorded.
  await db.query('delete from public.profiles where user_id = $1', [userId]);

  // The server's own answer, before any script runs: UTC's Saturday, and the
  // sentence that says so.
  const html = await (await page.request.get('/calendar')).text();
  expect(html).toContain('data-testid="time-zone-notice"');
  expect(html).toMatch(new RegExp(`data-date="${UTC_TODAY}"[^>]*data-today="true"`));

  // In the browser the detector records Auckland and the page redraws once.
  await page.goto('/calendar');
  await expect.poll(storedZone).toEqual({ time_zone: AUCKLAND, time_zone_source: 'detected' });
  await expect(page.getByTestId('time-zone-notice')).toHaveCount(0);
  await expect(
    page.locator('[data-testid="calendar-day"][data-today="true"]'),
  ).toHaveAttribute('data-date', AUCKLAND_TODAY);

  expect(auckland.hydrationErrors).toEqual([]);
  await auckland.context.close();
});
