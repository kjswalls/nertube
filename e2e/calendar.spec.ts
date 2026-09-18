import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/**
 * `/calendar` — the month grid, walked in a browser.
 *
 * BRIEF.md asks for "target publish dates across channels" plus filming days as
 * a distinct event type, and gives the reason: *publishing is a rhythm*. This
 * file proves the four claims the milestone stands on — a video renders on its
 * own target date, a month is linkable, both channels are on the one grid and
 * tellable apart, and a crowded day stays bounded with its overflow reachable —
 * and two more that would otherwise only be argued in a comment: today is
 * marked, and an empty month says something useful.
 *
 * ## Why every assertion is scoped to a cell
 *
 * The calendar is the only page in this product that is cross-channel *and*
 * unfiltered, so it legitimately shows rows that other specs created. Nothing
 * below counts chips across the whole grid; every assertion names the day it is
 * about. The one test that does need a whole month to itself checks that
 * precondition in SQL first, and uses a month eleven ahead of today that no
 * other fixture in the suite reaches.
 *
 * ## What is a fixture and what is a click
 *
 * The videos, their dates and the filming day are written as the owning user,
 * the way `e2e/ideas.spec.ts` and `e2e/now.spec.ts` build their weeks: going
 * through capture and then the detail page for each of eight videos would be a
 * test of M1 and M2. Everything the calendar is actually about — navigating,
 * opening a day, following a chip — is done the way a person does it.
 */

const CHANNELS = {
  a: { name: 'M6 Calendar Alpha', slug: 'm6-calendar-alpha' },
  b: { name: 'M6 Calendar Beta', slug: 'm6-calendar-beta' },
} as const;

/* -------------------------------------------------------------------------- */
/* Dates, computed without the helper under test                               */
/* -------------------------------------------------------------------------- */

const pad = (value: number) => String(value).padStart(2, '0');

/** Today in UTC, which is the zone the whole product decides calendar days in. */
function todayUtc(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

/**
 * `YYYY-MM` plus or minus a number of months, written out here on purpose.
 *
 * The page's own month arithmetic is the thing under test, so the expectations
 * must not come from it; this is four lines of independent implementation.
 */
function monthPlus(month: string, delta: number): string {
  const [year, index] = month.split('-').map(Number);
  const total = year * 12 + (index - 1) + delta;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

const TODAY = todayUtc();
const THIS_MONTH = TODAY.slice(0, 7);
/** A month far enough ahead to be this file's alone, and always in the future. */
const BUSY_MONTH = monthPlus(THIS_MONTH, 4);
const LAST_MONTH = monthPlus(THIS_MONTH, -1);
/** Nothing in the suite reaches eleven months out. */
const BARE_MONTH = monthPlus(THIS_MONTH, 11);

const TITLES = {
  alpha: 'The rhythm of a Tuesday upload',
  beta: 'What a second channel is for',
  late: 'The one that slipped',
  crowd: (index: number) => `Crowded day video ${index}`,
  filmed: 'Shot on the batch day',
  moved: 'Shot then, edited since',
} as const;

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

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

async function channelRow(
  slug: string,
): Promise<{ id: string; user_id: string } | null> {
  const result = await db.query<{ id: string; user_id: string }>(
    'select id, user_id from public.channels where slug = $1',
    [slug],
  );
  return result.rows[0] ?? null;
}

async function stageIdFor(channelId: string, kind: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    'select id from public.stages where channel_id = $1 and kind = $2',
    [channelId, kind],
  );
  if (!result.rows[0]) throw new Error(`no ${kind} stage on ${channelId}`);
  return result.rows[0].id;
}

interface SeedVideo {
  slug: string;
  title: string;
  /** `YYYY-MM-DD`, or null for a video that is deliberately not on the grid. */
  date: string | null;
  kind?: string;
  publishedAt?: string;
  archived?: boolean;
  filmingDayId?: string;
}

async function seedVideo(video: SeedVideo): Promise<string> {
  const channel = await channelRow(video.slug);
  if (!channel) throw new Error(`the fixture channel ${video.slug} is missing`);
  const stageId = await stageIdFor(channel.id, video.kind ?? 'editing');

  const inserted = await db.query<{ id: string }>(
    `insert into public.videos (
       user_id, channel_id, stage_id, title,
       target_publish_date, published_at, archived_at, filming_day_id
     ) values ($1, $2, $3, $4, $5::date, $6::timestamptz, $7::timestamptz, $8)
     returning id`,
    [
      channel.user_id,
      channel.id,
      stageId,
      video.title,
      video.date,
      video.publishedAt ?? null,
      video.archived ? new Date().toISOString() : null,
      video.filmingDayId ?? null,
    ],
  );
  return inserted.rows[0].id;
}

async function seedFilmingDay(onDate: string, notes: string): Promise<string> {
  const channel = await channelRow(CHANNELS.a.slug);
  if (!channel) throw new Error('the fixture channel is missing');
  const inserted = await db.query<{ id: string }>(
    `insert into public.filming_days (user_id, on_date, notes)
     values ($1, $2::date, $3)
     on conflict (user_id, on_date) do update set notes = excluded.notes
     returning id`,
    [channel.user_id, onDate, notes],
  );
  return inserted.rows[0].id;
}

/** How many videos anywhere in the account are targeted inside a month. */
async function targetsIn(month: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    `select count(*)::text as count from public.videos
      where target_publish_date >= ($1 || '-01')::date
        and target_publish_date < (($1 || '-01')::date + interval '1 month')
        and archived_at is null`,
    [month],
  );
  return Number(result.rows[0].count);
}

/* -------------------------------------------------------------------------- */
/* Browser helpers                                                             */
/* -------------------------------------------------------------------------- */

async function signIn(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}

async function createChannel(
  page: Page,
  channel: { name: string; slug: string },
): Promise<void> {
  await page.goto('/c/new');
  await page.getByLabel('Channel name').fill(channel.name);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.waitForURL(`**/c/${channel.slug}/board`);
}

async function openMonth(page: Page, month?: string): Promise<void> {
  await page.goto(month ? `/calendar?month=${month}` : '/calendar');
  await expect(page.getByTestId('calendar-grid')).toBeVisible();
}

const cell = (page: Page, date: string): Locator =>
  page.locator(`[data-testid="calendar-day"][data-date="${date}"]`);

const chipsIn = (page: Page, date: string): Locator =>
  cell(page, date).getByTestId('calendar-chip');

test.beforeEach(async ({ page }) => {
  await signIn(page);

  for (const channel of [CHANNELS.a, CHANNELS.b]) {
    if ((await channelRow(channel.slug)) === null) {
      await createChannel(page, channel);
    }
  }

  // This file's own rows only: other specs own theirs, and the calendar is
  // cross-channel by design.
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug = any($1))`,
    [[CHANNELS.a.slug, CHANNELS.b.slug]],
  );
  await db.query(
    `delete from public.filming_days
      where user_id in (select user_id from public.channels where slug = $1)`,
    [CHANNELS.a.slug],
  );
});

/* -------------------------------------------------------------------------- */
/* 1. A video renders on its target date                                       */
/* -------------------------------------------------------------------------- */

test('a video is drawn on its target publish date, and nowhere else', async ({
  page,
}) => {
  const day = `${BUSY_MONTH}-12`;
  const videoId = await seedVideo({
    slug: CHANNELS.a.slug,
    title: TITLES.alpha,
    date: day,
  });
  // A video with no date at all is not on the calendar; one that is archived is
  // not either. Both are seeded so the grid has to leave them out.
  await seedVideo({ slug: CHANNELS.a.slug, title: 'No date at all', date: null });
  await seedVideo({
    slug: CHANNELS.a.slug,
    title: 'Archived, same day',
    date: day,
    archived: true,
  });

  await openMonth(page, BUSY_MONTH);

  await expect(page.getByTestId('calendar-heading')).toHaveAttribute(
    'data-month',
    BUSY_MONTH,
  );

  const chip = chipsIn(page, day).filter({ hasText: TITLES.alpha });
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute('data-video', videoId);
  // The stage it is in is on the chip for a screen reader and in the tooltip.
  await expect(chip).toHaveAttribute('title', new RegExp('Editing'));

  // Nowhere else on the grid, and neither of the two that do not belong here.
  await expect(
    page.getByTestId('calendar-chip').filter({ hasText: TITLES.alpha }),
  ).toHaveCount(1);
  await expect(page.getByText('No date at all')).toHaveCount(0);
  await expect(page.getByText('Archived, same day')).toHaveCount(0);

  // The chip is the way into the video.
  await chip.click();
  await page.waitForURL(`**/videos/${videoId}`);
});

test('today is marked, and the days outside the month are visibly not part of it', async ({
  page,
}) => {
  await openMonth(page);

  const today = page.locator('[data-testid="calendar-day"][data-today="true"]');
  await expect(today).toHaveCount(1);
  await expect(today).toHaveAttribute('data-date', TODAY);
  await expect(today).toHaveAttribute('data-in-month', 'true');
  await expect(today.getByTestId('calendar-today')).toHaveCount(1);

  // The default view is this month, and it is the month today is in.
  await expect(page.getByTestId('calendar-heading')).toHaveAttribute(
    'data-month',
    THIS_MONTH,
  );

  // Whole weeks, so the first row usually borrows from the month before. Those
  // cells are marked, and carry no events.
  const outside = page.locator(
    '[data-testid="calendar-day"][data-in-month="false"]',
  );
  for (const borrowed of await outside.all()) {
    await expect(borrowed.getByTestId('calendar-chip')).toHaveCount(0);
    expect(await borrowed.getAttribute('data-date')).not.toContain(THIS_MONTH);
  }
});

test('a date that has passed with nothing shipped is marked late', async ({
  page,
}) => {
  const day = `${LAST_MONTH}-12`;
  await seedVideo({ slug: CHANNELS.a.slug, title: TITLES.late, date: day });
  await seedVideo({
    slug: CHANNELS.b.slug,
    title: 'Went out on time',
    date: day,
    kind: 'published',
    publishedAt: `${day}T09:00:00Z`,
  });

  await openMonth(page, LAST_MONTH);

  await expect(
    chipsIn(page, day).filter({ hasText: TITLES.late }),
  ).toHaveAttribute('data-state', 'late');
  await expect(
    chipsIn(page, day).filter({ hasText: 'Went out on time' }),
  ).toHaveAttribute('data-state', 'published');
});

/* -------------------------------------------------------------------------- */
/* 2. Month navigation is linkable                                             */
/* -------------------------------------------------------------------------- */

test('months are reachable by link, by URL, and back again', async ({ page }) => {
  const here = `${BUSY_MONTH}-12`;
  const next = monthPlus(BUSY_MONTH, 1);
  const nextDay = `${next}-07`;

  await seedVideo({ slug: CHANNELS.a.slug, title: TITLES.alpha, date: here });
  await seedVideo({
    slug: CHANNELS.a.slug,
    title: 'One month later',
    date: nextDay,
  });

  await openMonth(page, BUSY_MONTH);
  await expect(chipsIn(page, here)).toHaveCount(1);

  // Forward: the URL carries the month, so the address bar is the state.
  await page.getByTestId('calendar-next').click();
  await page.waitForURL(`**/calendar?month=${next}`);
  await expect(page.getByTestId('calendar-heading')).toHaveAttribute(
    'data-month',
    next,
  );
  await expect(chipsIn(page, nextDay)).toHaveCount(1);
  // The previous month's video is not on this month's grid at all.
  await expect(
    page.getByTestId('calendar-chip').filter({ hasText: TITLES.alpha }),
  ).toHaveCount(0);

  // Back.
  await page.getByTestId('calendar-previous').click();
  await page.waitForURL(`**/calendar?month=${BUSY_MONTH}`);
  await expect(chipsIn(page, here)).toHaveCount(1);

  // The link is the whole state: a fresh navigation to that address — a
  // bookmark, or a link pasted to somebody else — lands on the same month.
  await page.goto(`/calendar?month=${next}`);
  await expect(page.getByTestId('calendar-heading')).toHaveAttribute(
    'data-month',
    next,
  );
  await expect(chipsIn(page, nextDay)).toHaveCount(1);

  // And "This month" comes home.
  await page.getByTestId('calendar-this-month').click();
  await page.waitForURL(`**/calendar?month=${THIS_MONTH}`);
  await expect(
    page.locator('[data-testid="calendar-day"][data-today="true"]'),
  ).toHaveCount(1);

  // A month that is not a month is not an error: it is this month.
  await page.goto('/calendar?month=not-a-month');
  await expect(page.getByTestId('calendar-heading')).toHaveAttribute(
    'data-month',
    THIS_MONTH,
  );
});

/* -------------------------------------------------------------------------- */
/* 3. Both channels, tellable apart without colour                             */
/* -------------------------------------------------------------------------- */

test('both channels are on the one grid and are distinguishable in text', async ({
  page,
}) => {
  const day = `${BUSY_MONTH}-12`;
  await seedVideo({ slug: CHANNELS.a.slug, title: TITLES.alpha, date: day });
  await seedVideo({ slug: CHANNELS.b.slug, title: TITLES.beta, date: day });

  await openMonth(page, BUSY_MONTH);

  const alpha = chipsIn(page, day).filter({ hasText: TITLES.alpha });
  const beta = chipsIn(page, day).filter({ hasText: TITLES.beta });
  await expect(alpha).toHaveCount(1);
  await expect(beta).toHaveCount(1);

  // Different channels, and the difference is written down rather than only
  // drawn: a distinct tag on each chip, the channel's name in the tooltip and
  // in the accessible name, and a legend expanding both.
  const alphaChannel = await alpha.getAttribute('data-channel');
  const betaChannel = await beta.getAttribute('data-channel');
  expect(alphaChannel).not.toBe(betaChannel);

  const alphaTag = await alpha.getByTestId('calendar-chip-tag').innerText();
  const betaTag = await beta.getByTestId('calendar-chip-tag').innerText();
  expect(alphaTag).not.toBe(betaTag);
  expect(alphaTag.length).toBeGreaterThanOrEqual(2);

  await expect(alpha).toHaveAttribute('title', new RegExp(CHANNELS.a.name));
  await expect(beta).toHaveAttribute('title', new RegExp(CHANNELS.b.name));

  const legend = page.getByTestId('calendar-legend');
  await expect(legend).toContainText(CHANNELS.a.name);
  await expect(legend).toContainText(CHANNELS.b.name);
  await expect(legend).toContainText(alphaTag);
  await expect(legend).toContainText(betaTag);
});

/* -------------------------------------------------------------------------- */
/* 4. Density: a crowded day stays bounded, and the rest is reachable          */
/* -------------------------------------------------------------------------- */

test('a day with six videos draws two and opens the rest', async ({ page }) => {
  const day = `${BUSY_MONTH}-21`;
  const quiet = `${BUSY_MONTH}-07`;

  for (let index = 1; index <= 6; index += 1) {
    await seedVideo({
      slug: index % 2 === 0 ? CHANNELS.b.slug : CHANNELS.a.slug,
      title: TITLES.crowd(index),
      date: day,
    });
  }
  await seedVideo({ slug: CHANNELS.a.slug, title: TITLES.alpha, date: quiet });

  await openMonth(page, BUSY_MONTH);

  // Bounded: two chips and an overflow line, however many there are.
  const crowded = cell(page, day);
  await expect(crowded).toHaveAttribute('data-events', '6');
  await expect(crowded.getByTestId('calendar-chip')).toHaveCount(2);

  const overflow = crowded.getByTestId('calendar-overflow');
  await expect(overflow).toHaveText(/\+4 more/);

  // A cell that fits draws everything and has no overflow link.
  await expect(chipsIn(page, quiet)).toHaveCount(1);
  await expect(cell(page, quiet).getByTestId('calendar-overflow')).toHaveCount(0);

  // The height of a week is not decided by its busiest day: the crowded row is
  // the same height as a row with nothing in it.
  const crowdedBox = await crowded.boundingBox();
  const quietBox = await cell(page, quiet).boundingBox();
  expect(crowdedBox!.height).toBeCloseTo(quietBox!.height, 0);

  // Reachable: the overflow is a link, it has an address of its own, and it
  // opens every one of the six.
  await overflow.click();
  await page.waitForURL(`**/calendar?month=${BUSY_MONTH}&day=${day}`);

  const panel = page.getByTestId('calendar-day-panel');
  await expect(panel).toHaveAttribute('data-date', day);
  await expect(panel.getByTestId('calendar-day-video')).toHaveCount(6);
  for (let index = 1; index <= 6; index += 1) {
    await expect(panel).toContainText(TITLES.crowd(index));
  }

  // The cell the panel belongs to is marked while it is open.
  await expect(crowded).toHaveAttribute('data-date', day);

  // A pasted day link opens the same panel — it is state in the URL, not in a
  // component.
  await page.goto(`/calendar?month=${BUSY_MONTH}&day=${day}`);
  await expect(
    page.getByTestId('calendar-day-panel').getByTestId('calendar-day-video'),
  ).toHaveCount(6);

  await page.getByTestId('calendar-day-close').click();
  await page.waitForURL(`**/calendar?month=${BUSY_MONTH}`);
  await expect(page.getByTestId('calendar-day-panel')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* 5. Filming days are a different kind of event                               */
/* -------------------------------------------------------------------------- */

test('a filming day is its own event type and expands to the videos linked to it', async ({
  page,
}) => {
  const day = `${BUSY_MONTH}-14`;
  const filmingDayId = await seedFilmingDay(day, 'Two shirts, one afternoon');

  await seedVideo({
    slug: CHANNELS.a.slug,
    title: TITLES.filmed,
    date: null,
    kind: 'filming',
    filmingDayId,
  });
  // PLAN.md's own M6 review item: a video that has moved on from Filming keeps
  // its link, and the day still renders sanely — with where the video is now.
  await seedVideo({
    slug: CHANNELS.b.slug,
    title: TITLES.moved,
    date: null,
    kind: 'editing',
    filmingDayId,
  });

  await openMonth(page, BUSY_MONTH);

  const chip = cell(page, day).getByTestId('calendar-chip');
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute('data-kind', 'filming');
  await expect(chip).toContainText('Filming day');
  await expect(page.getByTestId('calendar-summary')).toContainText(
    '1 filming day',
  );

  await chip.click();
  await page.waitForURL(`**/calendar?month=${BUSY_MONTH}&day=${day}`);

  const block = page.getByTestId('calendar-day-filming');
  await expect(block).toHaveCount(1);
  await expect(block).toContainText('Two shirts, one afternoon');
  await expect(block).toContainText(TITLES.filmed);
  await expect(block).toContainText(TITLES.moved);
  // The one that moved on is listed with the stage it is in today.
  await expect(block).toContainText('Editing');
});

/* -------------------------------------------------------------------------- */
/* 6. Honest empties, and the sidebar                                          */
/* -------------------------------------------------------------------------- */

test('a month with nothing in it says so and points at one that has something', async ({
  page,
}) => {
  await seedVideo({
    slug: CHANNELS.a.slug,
    title: TITLES.alpha,
    date: `${BUSY_MONTH}-12`,
  });

  // The precondition this test needs: nobody else's fixture reaches this month.
  expect(await targetsIn(BARE_MONTH)).toBe(0);

  await openMonth(page, BARE_MONTH);

  const empty = page.getByTestId('calendar-empty');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('Nothing is going out');
  await expect(page.getByTestId('calendar-summary')).toContainText(
    'Nothing planned',
  );

  // It is useful rather than merely honest: the nearest month with anything in
  // it is a link, and following it lands on that month.
  const nearest = page.getByTestId('calendar-nearest').first();
  await expect(nearest).toBeVisible();
  const month = await nearest.getAttribute('data-month');
  await nearest.click();
  await page.waitForURL(`**/calendar?month=${month}`);
  await expect(page.getByTestId('calendar-heading')).toHaveAttribute(
    'data-month',
    month!,
  );
});

test('the sidebar Calendar entry is a link, counts this month, and is reachable by keyboard', async ({
  page,
}) => {
  await seedVideo({ slug: CHANNELS.a.slug, title: TITLES.alpha, date: TODAY });

  await page.goto('/now');

  const link = page
    .getByTestId('app-sidebar')
    .getByRole('link', { name: 'Calendar', exact: true });
  await expect(link).toHaveAttribute('href', '/calendar');
  // It is no longer one of the placeholders.
  await expect(
    page.getByTestId('app-sidebar').getByText('M6', { exact: true }),
  ).toHaveCount(0);

  // The badge is the number the page it opens agrees with.
  const badge = page.getByTestId('sidebar-calendar-count');
  const counted = Number(await badge.getAttribute('data-count'));
  expect(counted).toBe(await targetsIn(THIS_MONTH));
  await expect(link).toHaveAttribute('title', new RegExp(`${counted} video`));

  // Reachable by keyboard: focus it and press Enter.
  await link.focus();
  await page.keyboard.press('Enter');
  await page.waitForURL('**/calendar');
  await expect(page.getByTestId('calendar-grid')).toBeVisible();
  await expect(link).toHaveAttribute('aria-current', 'page');
  await expect(
    chipsIn(page, TODAY).filter({ hasText: TITLES.alpha }),
  ).toHaveCount(1);
});
