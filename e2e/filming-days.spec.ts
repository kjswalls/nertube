import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import { addDays, formatDateColumn, todayColumn } from '../lib/calendar-dates';
import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

import { untilTaken } from './hydration';

/**
 * Batch filming days, walked in a browser.
 *
 * BRIEF.md principle 4 is the loop this file is about:
 *
 * > *Filming is the only step needing a big time block. When 3+ videos are
 * > sitting in Filming, that's a signal to schedule a batch day.*
 *
 * The board has been drawing that signal as a sentence since M1. Every test
 * below is about what happens now that the sentence is a button.
 *
 * ## What is a fixture and what is a click
 *
 * The *state* — five videos in Filming across two channels — is written
 * directly as the owning user, the way `e2e/ideas.spec.ts` and `e2e/now.spec.ts`
 * build theirs: producing it through the board would be a test of M1. Every
 * claim this milestone makes is then made with the mouse and checked **in the
 * database**, because "the dialog no longer lists it" and "the row is unlinked"
 * are different sentences and only the second one is still true tomorrow.
 *
 * ## The dates come from the application's own helper
 *
 * `lib/calendar-dates.ts` is imported rather than re-derived here. A spec that
 * computed `YYYY-MM-DD` with its own `toISOString().slice(0, 10)` would be
 * asserting against a second interpretation of a `date` column — which is the
 * exact bug this milestone is most exposed to — and would disagree with the app
 * for anyone running it west of UTC late in the evening.
 */

const CHANNELS = {
  main: { name: 'M6 Filming', slug: 'm6-filming' },
  other: { name: 'M6 Second', slug: 'm6-second' },
} as const;

const TITLES = {
  kettle: 'The kettle test, filmed twice',
  desk: 'A desk that earns its place',
  budget: 'Budgeting on a bad month',
  lens: 'One lens for a year',
  /** Lives in the second channel — one creator, one camera. */
  sunday: 'Sunday Softworks build log',
} as const;

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

let db: pg.Client;

/** The clock, read once per run: every date below is derived from this. */
const TODAY = todayColumn(Date.now());
/** The Saturday-ish future date the tests book. */
const SHOOT = addDays(TODAY, 12) as string;
/** A second free date, for "move it" and "a different day". */
const OTHER_SHOOT = addDays(TODAY, 19) as string;
/** A day that has already been and gone. */
const PAST_SHOOT = addDays(TODAY, -7) as string;

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

/**
 * Put the database back.
 *
 * Not tidiness: `e2e/board.m1.spec.ts` asserts the Filming badge's **cross-
 * channel** count — "3 in Filming across all channels" — and this file leaves
 * five videos sitting in Filming. The suite shares one database and the dev
 * stack is reused between runs by default, so without this the next run of
 * board.m1 reads 8 and fails for a reason that has nothing to do with the board.
 * That is exactly the shape of flake the M5 review caught, arriving from a new
 * direction: a fixture that is correct inside its own file and wrong outside it.
 *
 * A `beforeEach` in this file cannot fix it — by then the damage is in another
 * spec's run — so the cleanup belongs here, at the end.
 */
test.afterAll(async () => {
  await db?.query(
    `delete from public.videos
      where channel_id in (
        select id from public.channels where slug = any($1::text[])
      )`,
    [[CHANNELS.main.slug, CHANNELS.other.slug]],
  );
  await db?.query('delete from public.filming_days');
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
  if (!result.rows[0]) throw new Error(`no ${kind} stage on that channel`);
  return result.rows[0].id;
}

/**
 * One video, in a named stage, with packaging already done.
 *
 * The packaging fields are not decoration: `move_video` refuses any stage past
 * Packaging without a title, a thumbnail concept and one chosen hook, and one
 * of the tests below moves a video out of Filming the way a person does — with
 * the stage select. Without these it would be testing M2's gate instead.
 */
async function seedVideo({
  slug,
  title,
  kind = 'filming',
}: {
  slug: string;
  title: string;
  kind?: string;
}): Promise<string> {
  const channel = await channelRow(slug);
  if (!channel) throw new Error(`the fixture channel ${slug} is missing`);
  const stageId = await stageIdFor(channel.id, kind);

  const inserted = await db.query<{ id: string }>(
    `insert into public.videos (
       user_id, channel_id, stage_id, title, thumbnail_concept, hooks
     ) values (
       $1, $2, $3, $4,
       'A kettle, mid-pour, and a stopwatch',
       '[{"id":"h1","text":"I timed every kettle in the house","chosen":true}]'::jsonb
     ) returning id`,
    [channel.user_id, channel.id, stageId, title],
  );
  return inserted.rows[0].id;
}

/** The whole fixture: five in Filming, four here and one next door. */
async function seedWeek(): Promise<Record<keyof typeof TITLES, string>> {
  return {
    kettle: await seedVideo({ slug: CHANNELS.main.slug, title: TITLES.kettle }),
    desk: await seedVideo({ slug: CHANNELS.main.slug, title: TITLES.desk }),
    budget: await seedVideo({ slug: CHANNELS.main.slug, title: TITLES.budget }),
    lens: await seedVideo({ slug: CHANNELS.main.slug, title: TITLES.lens }),
    sunday: await seedVideo({ slug: CHANNELS.other.slug, title: TITLES.sunday }),
  };
}

/* -------------------------------------------------------------------------- */
/* Database questions                                                          */
/* -------------------------------------------------------------------------- */

async function daysOn(onDate: string): Promise<{ id: string; notes: string | null }[]> {
  const result = await db.query<{ id: string; notes: string | null }>(
    'select id, notes from public.filming_days where on_date = $1',
    [onDate],
  );
  return result.rows;
}

/** The ids of the videos attached to a day, as the database has them. */
async function videosOn(dayId: string): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    'select id from public.videos where filming_day_id = $1 order by title',
    [dayId],
  );
  return result.rows.map((row) => row.id);
}

async function dayOfVideo(videoId: string): Promise<string | null> {
  const result = await db.query<{ filming_day_id: string | null }>(
    'select filming_day_id from public.videos where id = $1',
    [videoId],
  );
  return result.rows[0]?.filming_day_id ?? null;
}

async function videoExists(videoId: string): Promise<boolean> {
  const result = await db.query('select 1 from public.videos where id = $1', [
    videoId,
  ]);
  return result.rowCount === 1;
}

/**
 * How many videos are in Filming right now, across every channel — the number
 * the badge is claiming.
 *
 * Read from the database rather than written down as `5`, because the suite
 * shares one database and an earlier spec's channel may still be holding a
 * video in Filming. The claim under test is that the badge and the dialog agree
 * with the rows; hard-coding the number would test the fixture instead, and
 * would fail for a reason that has nothing to do with this milestone.
 */
async function filmingCount(): Promise<number> {
  const result = await db.query<{ count: string }>(
    `select count(*)::text as count
       from public.videos v
       join public.stages s on s.id = v.stage_id
      where s.kind = 'filming' and s.is_enabled and v.archived_at is null`,
  );
  return Number(result.rows[0].count);
}

/** Attach videos to a day directly — a fixture, never the thing under test. */
async function linkInDatabase(dayId: string, videoIds: string[]): Promise<void> {
  await db.query(
    'update public.videos set filming_day_id = $1 where id = any($2::uuid[])',
    [dayId, videoIds],
  );
}

async function makeDay(onDate: string, notes: string | null = null): Promise<string> {
  const channel = await channelRow(CHANNELS.main.slug);
  if (!channel) throw new Error('the fixture channel is missing');
  const result = await db.query<{ id: string }>(
    `insert into public.filming_days (user_id, on_date, notes)
     values ($1, $2, $3) returning id`,
    [channel.user_id, onDate, notes],
  );
  return result.rows[0].id;
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

async function createChannel(page: Page, channel: { name: string; slug: string }) {
  await page.goto('/c/new');
  await page.getByLabel('Channel name').fill(channel.name);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.waitForURL(`**/c/${channel.slug}/board`);
}

/** Open a board and wait for it to be able to take a click. */
async function openBoard(page: Page, slug = CHANNELS.main.slug): Promise<void> {
  await page.goto(`/c/${slug}/board`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
}

/**
 * Open a video on the section its flow fields live in.
 *
 * `?section=schedule` is the section routing's own promise, used exactly as a
 * person would paste it — M3 keeps all five sections mounted and shows one, so
 * a control in the Schedule section is in the document but not on screen until
 * the URL or a click says so. `e2e/flow-fields.spec.ts` opens it the same way.
 */
async function openVideoSchedule(page: Page, videoId: string): Promise<void> {
  await page.goto(`/videos/${videoId}?section=schedule`);
  await expect(page.getByTestId('video-filming-day')).toBeVisible();
}

const badge = (page: Page): Locator => page.getByTestId('filming-badge');
const dialog = (page: Page): Locator => page.getByTestId('schedule-day-dialog');
const panel = (page: Page): Locator => page.getByTestId('filming-day-panel');
const dayVideos = (page: Page): Locator => page.getByTestId('filming-day-video');

const dayVideoFor = (page: Page, title: string): Locator =>
  dayVideos(page).filter({ hasText: title });

/**
 * Open the schedule dialog from the board's badge.
 *
 * Through `untilTaken` because the board is server-rendered and its handlers
 * only exist once the route has hydrated — the same property
 * `e2e/hydration.ts` documents. Opening a dialog is idempotent.
 */
async function openScheduleDialog(page: Page): Promise<void> {
  await untilTaken(
    async () => {
      if (await dialog(page).isVisible()) return;
      await badge(page).click();
    },
    async () => {
      await expect(dialog(page)).toBeVisible({ timeout: 2_000 });
    },
  );
}

/** Fill the dialog's date box. `<input type="date">` takes `YYYY-MM-DD`. */
async function pickDate(page: Page, date: string): Promise<void> {
  await page.getByTestId('filming-day-date').fill(date);
}

/** Tick exactly these videos in the dialog's candidate list. */
async function selectOnly(page: Page, titles: readonly string[]): Promise<void> {
  const boxes = page.getByTestId('filming-candidate');
  const count = await boxes.count();
  for (let index = 0; index < count; index += 1) {
    const box = boxes.nth(index);
    // The checkbox's own label is its parent, which is where the title is.
    const text = (await box.locator('xpath=..').innerText()).trim();
    const wanted = titles.some((title) => text.includes(title));
    if ((await box.isChecked()) !== wanted) await box.click();
  }
}

test.beforeEach(async ({ page }) => {
  // Filming days are user-level, so they are cleared wholesale rather than by
  // channel — and the videos go first only because it reads more obviously;
  // the foreign key would unlink them either way, which is its own test below.
  await db.query(
    `delete from public.videos
      where channel_id in (
        select id from public.channels where slug = any($1::text[])
      )`,
    [[CHANNELS.main.slug, CHANNELS.other.slug]],
  );
  await db.query('delete from public.filming_days');

  await signIn(page);
  for (const channel of [CHANNELS.main, CHANNELS.other]) {
    if ((await channelRow(channel.slug)) === null) {
      await createChannel(page, channel);
    }
  }

  await seedWeek();
});

/* -------------------------------------------------------------------------- */
/* 1. The badge is the action                                                  */
/* -------------------------------------------------------------------------- */

test('the board badge schedules a day with those videos on it', async ({
  page,
}) => {
  const total = await filmingCount();
  expect(total).toBeGreaterThanOrEqual(5);

  await openBoard(page);

  // The signal itself, unchanged since M1: the count is across *all* channels
  // — one creator, one camera — and the badge says so whenever that differs
  // from the column's own count directly above it.
  await expect(badge(page)).toHaveText(
    new RegExp(
      `^${total} in Filming( across all channels)? — schedule batch day\\?$`,
    ),
  );
  // It is a control now, not a sentence.
  await expect(badge(page)).toHaveRole('button');

  await openScheduleDialog(page);

  // Everything the badge counted arrives ticked, including the video in the
  // other channel.
  await expect(page.getByTestId('filming-candidate')).toHaveCount(total);
  for (const box of await page.getByTestId('filming-candidate').all()) {
    await expect(box).toBeChecked();
  }
  await expect(dialog(page)).toContainText(TITLES.sunday);

  // This file's five, so the assertions below are about its own fixture even
  // when the shared database is holding somebody else's Filming row.
  await selectOnly(page, Object.values(TITLES));
  await pickDate(page, SHOOT);
  await page.getByTestId('filming-day-notes-new').fill('Two shirts, one set.');
  await page.getByTestId('schedule-day-submit').click();

  // The dialog turns into the day it just created.
  await expect(panel(page)).toBeVisible();
  await expect(dayVideos(page)).toHaveCount(5);
  await expect(page.getByTestId('filming-day-headline')).toHaveText(
    '5 videos to shoot.',
  );

  // And the database agrees, which is the claim that outlives the render.
  const days = await daysOn(SHOOT);
  expect(days).toHaveLength(1);
  expect(days[0].notes).toBe('Two shirts, one set.');
  expect(await videosOn(days[0].id)).toHaveLength(5);
});

test('a day can be booked with only some of the videos on it', async ({
  page,
}) => {
  await openBoard(page);
  await openScheduleDialog(page);

  await selectOnly(page, [TITLES.kettle, TITLES.desk]);
  await pickDate(page, SHOOT);
  await page.getByTestId('schedule-day-submit').click();

  await expect(dayVideos(page)).toHaveCount(2);

  const [day] = await daysOn(SHOOT);
  const attached = await videosOn(day.id);
  expect(attached).toHaveLength(2);
  // The three that were unticked are untouched and still have no day.
  const untouched = await db.query<{ count: string }>(
    `select count(*)::text as count from public.videos
      where title = any($1::text[]) and filming_day_id is null`,
    [[TITLES.budget, TITLES.lens, TITLES.sunday]],
  );
  expect(untouched.rows[0].count).toBe('3');
});

/* -------------------------------------------------------------------------- */
/* 2. One creator, one camera, one day per date                                */
/* -------------------------------------------------------------------------- */

test('a second day on the same date offers the one that exists', async ({
  page,
}) => {
  // A day is already booked on that date, covering one video.
  const existing = await makeDay(SHOOT, 'Booked last week.');
  const kettle = await db.query<{ id: string }>(
    'select id from public.videos where title = $1',
    [TITLES.kettle],
  );
  await linkInDatabase(existing, [kettle.rows[0].id]);

  await openBoard(page);
  await openScheduleDialog(page);

  await selectOnly(page, [TITLES.desk, TITLES.budget]);
  await pickDate(page, SHOOT);
  await page.getByTestId('schedule-day-submit').click();

  // Not an error message and not a constraint name: the day they already have.
  const notice = page.getByTestId('filming-day-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('already have a filming day');
  /*
    The date, compared without the weekday — and the reason is worth writing
    down, because it is a trap for anything that formats a date on both sides.

    `formatDateColumn` is one function, but `Intl` is not one implementation:
    this spec runs on Node and the page runs in Chromium, and their CLDR data
    disagree about the comma in the `weekday` style ("Wed 30 Sept" against
    "Wed, 30 Sept"). The `short` style has no such disagreement, and it is the
    part of the string this assertion is actually about. See M6 in
    `docs/MILESTONES.md`: the same divergence is why a filming day rendered by
    a *server* component must be handed its formatted strings rather than
    formatting them again after hydration.
  */
  await expect(notice).toContainText(
    formatDateColumn(SHOOT, 'short') as string,
  );
  await expect(page.getByText('filming_days_user_id_on_date_key')).toHaveCount(0);

  // It is the existing day, with what it already covers.
  await expect(panel(page)).toHaveAttribute('data-day-id', existing);
  await expect(dayVideoFor(page, TITLES.kettle)).toBeVisible();

  // Still exactly one row: nothing was created behind the notice.
  expect(await daysOn(SHOOT)).toHaveLength(1);
  expect(await videosOn(existing)).toHaveLength(1);

  // "Add to the existing day" is the offer, and it does what it says.
  await page.getByTestId('add-to-existing-day').click();
  await expect(dayVideos(page)).toHaveCount(3);
  expect(await videosOn(existing)).toHaveLength(3);
  expect(await daysOn(SHOOT)).toHaveLength(1);
});

/* -------------------------------------------------------------------------- */
/* 3. Both directions                                                          */
/* -------------------------------------------------------------------------- */

test('a video can be put on a day, and taken off, from its own page', async ({
  page,
}) => {
  const day = await makeDay(SHOOT);
  const video = await db.query<{ id: string }>(
    'select id from public.videos where title = $1',
    [TITLES.lens],
  );
  const lens = video.rows[0].id;

  await openVideoSchedule(page, lens);
  const control = page.getByTestId('video-filming-day');
  await expect(control).toHaveAttribute('data-day-id', '');

  const select = page.getByTestId('filming-day-select');
  await untilTaken(
    async () => {
      await select.selectOption(day);
    },
    async () => {
      await expect(control).toHaveAttribute('data-day-id', day, {
        timeout: 4_000,
      });
    },
  );
  expect(await dayOfVideo(lens)).toBe(day);

  // And off again — one column back to NULL, nothing else about the video.
  await select.selectOption('');
  await expect(control).toHaveAttribute('data-day-id', '');
  expect(await dayOfVideo(lens)).toBeNull();
  expect(await videoExists(lens)).toBe(true);
});

test('a video page can schedule the day it needs', async ({ page }) => {
  const video = await db.query<{ id: string }>(
    'select id from public.videos where title = $1',
    [TITLES.budget],
  );
  const budget = video.rows[0].id;

  await openVideoSchedule(page, budget);
  const control = page.getByTestId('video-filming-day');

  await untilTaken(
    async () => {
      if (await page.getByTestId('new-filming-day-date').isVisible()) return;
      await page.getByTestId('new-filming-day').click();
    },
    async () => {
      await expect(page.getByTestId('new-filming-day-date')).toBeVisible({
        timeout: 2_000,
      });
    },
  );

  await page.getByTestId('new-filming-day-date').fill(OTHER_SHOOT);
  await page.getByTestId('new-filming-day-save').click();

  await expect(control).not.toHaveAttribute('data-day-id', '');
  const [day] = await daysOn(OTHER_SHOOT);
  expect(day).toBeDefined();
  expect(await dayOfVideo(budget)).toBe(day.id);
});

test('detaching from the day itself leaves the video alone', async ({ page }) => {
  const day = await makeDay(SHOOT);
  const rows = await db.query<{ id: string; title: string }>(
    'select id, title from public.videos where title = any($1::text[])',
    [[TITLES.kettle, TITLES.desk]],
  );
  await linkInDatabase(
    day,
    rows.rows.map((row) => row.id),
  );
  const kettle = rows.rows.find((row) => row.title === TITLES.kettle)!.id;

  await openBoard(page);
  await openScheduleDialog(page);
  await pickDate(page, SHOOT);
  await page.getByTestId('schedule-day-submit').click();
  await expect(panel(page)).toHaveAttribute('data-day-id', day);
  await expect(dayVideos(page)).toHaveCount(2);

  await dayVideoFor(page, TITLES.kettle)
    .getByTestId('filming-day-detach')
    .click();

  await expect(dayVideos(page)).toHaveCount(1);
  await expect(dayVideoFor(page, TITLES.kettle)).toHaveCount(0);

  expect(await dayOfVideo(kettle)).toBeNull();
  expect(await videoExists(kettle)).toBe(true);
  expect(await videosOn(day)).toHaveLength(1);
});

test('a day can be moved to another date, and refuses an occupied one', async ({
  page,
}) => {
  const day = await makeDay(SHOOT);
  const rows = await db.query<{ id: string }>(
    'select id from public.videos where title = any($1::text[])',
    [[TITLES.kettle, TITLES.desk]],
  );
  const ids = rows.rows.map((row) => row.id);
  await linkInDatabase(day, ids);
  // A second day, so the refusal has something to collide with.
  const occupied = await makeDay(OTHER_SHOOT);

  await openBoard(page);
  await openScheduleDialog(page);
  await pickDate(page, SHOOT);
  await page.getByTestId('schedule-day-submit').click();
  await expect(panel(page)).toHaveAttribute('data-day-id', day);

  // Onto the date that is taken: refused in words, and nothing moves.
  await page.getByTestId('move-day').click();
  await page.getByTestId('move-day-date').fill(OTHER_SHOOT);
  await page.getByTestId('move-day-save').click();
  /*
    By test id, not by `getByRole('alert')`: the toast region renders an empty
    `role="alert"` container on every page — a live region has to be in the DOM
    before its text arrives to be announced — so the role matches twice and
    strict mode refuses. The panel's own line is the one under test.
  */
  await expect(page.getByTestId('filming-day-error')).toContainText(
    'already have a filming day on that date',
  );
  expect((await daysOn(SHOOT))[0]?.id).toBe(day);
  expect((await daysOn(OTHER_SHOOT))[0]?.id).toBe(occupied);

  // Onto a free one: the day moves and takes its videos with it, which is the
  // whole reason moving exists rather than cancel-and-rebook.
  const free = addDays(SHOOT, 1) as string;
  await page.getByTestId('move-day-date').fill(free);
  await page.getByTestId('move-day-save').click();
  await expect(panel(page)).toHaveAttribute('data-on-date', free);

  expect(await daysOn(SHOOT)).toHaveLength(0);
  expect((await daysOn(free))[0]?.id).toBe(day);
  expect(await videosOn(day)).toHaveLength(2);
});

/* -------------------------------------------------------------------------- */
/* 4. Videos move on — the normal case                                         */
/* -------------------------------------------------------------------------- */

test('a day whose video has left Filming still reads truthfully', async ({
  page,
}) => {
  // A day that has already been and gone, covering two videos.
  const day = await makeDay(PAST_SHOOT);
  const rows = await db.query<{ id: string; title: string }>(
    'select id, title from public.videos where title = any($1::text[])',
    [[TITLES.kettle, TITLES.desk]],
  );
  await linkInDatabase(
    day,
    rows.rows.map((row) => row.id),
  );
  const kettle = rows.rows.find((row) => row.title === TITLES.kettle)!.id;

  // Move one of them on the way a person does: the stage select on its own
  // page, which goes through `move_video` and its gate.
  await openVideoSchedule(page, kettle);
  const stageSelect = page.getByTestId('stage-select');
  await untilTaken(
    async () => {
      await stageSelect.selectOption({ label: 'Editing' });
    },
    async () => {
      await expect(stageSelect).toHaveValue(
        await stageIdFor(
          (await channelRow(CHANNELS.main.slug))!.id,
          'editing',
        ),
        { timeout: 6_000 },
      );
    },
  );

  // The link survived the move: leaving Filming is not leaving the day.
  expect(await dayOfVideo(kettle)).toBe(day);

  // And the day says what is now true of it, rather than repeating what was
  // true when the videos were attached.
  await openBoard(page);
  await openScheduleDialog(page);
  await pickDate(page, PAST_SHOOT);
  await page.getByTestId('schedule-day-submit').click();

  await expect(panel(page)).toHaveAttribute('data-day-id', day);
  await expect(dayVideos(page)).toHaveCount(2);
  await expect(dayVideoFor(page, TITLES.kettle)).toHaveAttribute(
    'data-status',
    'moved_on',
  );
  await expect(dayVideoFor(page, TITLES.desk)).toHaveAttribute(
    'data-status',
    'to_shoot',
  );
  await expect(page.getByTestId('filming-day-headline')).toHaveText(
    '1 of 2 moved on; 1 still waiting to be filmed.',
  );
  // The one state on this page that is asking for a decision — a day that has
  // passed with a video still in Filming — and the only one with colour.
  await expect(panel(page)).toHaveAttribute('data-tone', 'attention');
});

test('a past day whose videos all moved on is quiet, not stale', async ({
  page,
}) => {
  const day = await makeDay(PAST_SHOOT);
  const editing = await seedVideo({
    slug: CHANNELS.main.slug,
    title: 'Filmed and cut already',
    kind: 'editing',
  });
  await linkInDatabase(day, [editing]);

  await openBoard(page);
  await openScheduleDialog(page);
  await pickDate(page, PAST_SHOOT);
  await page.getByTestId('schedule-day-submit').click();

  await expect(panel(page)).toHaveAttribute('data-day-id', day);
  // Not hidden, not "1 to shoot" for ever: filmed, and moved on.
  await expect(dayVideos(page)).toHaveCount(1);
  await expect(page.getByTestId('filming-day-headline')).toHaveText(
    '1 video, filmed and moved on.',
  );
  await expect(panel(page)).toHaveAttribute('data-tone', 'quiet');
});

/* -------------------------------------------------------------------------- */
/* 5. Cancelling a day                                                         */
/* -------------------------------------------------------------------------- */

test('deleting a day unlinks its videos and deletes none of them', async ({
  page,
}) => {
  const day = await makeDay(SHOOT);
  const rows = await db.query<{ id: string }>(
    'select id from public.videos where title = any($1::text[])',
    [[TITLES.kettle, TITLES.desk, TITLES.sunday]],
  );
  const ids = rows.rows.map((row) => row.id);
  await linkInDatabase(day, ids);

  await openBoard(page);
  await openScheduleDialog(page);
  await pickDate(page, SHOOT);
  await page.getByTestId('schedule-day-submit').click();
  await expect(panel(page)).toHaveAttribute('data-day-id', day);

  await page.getByTestId('cancel-day').click();
  // The confirmation says what will happen to the videos, with the real count.
  await expect(page.getByTestId('cancel-day-confirm')).toContainText(
    '3 videos will be unlinked',
  );
  await expect(page.getByTestId('cancel-day-confirm')).toContainText(
    'none of them is deleted',
  );

  await page.getByTestId('cancel-day-yes').click();
  await expect(dialog(page)).toHaveCount(0);

  // The day is gone; the videos are all still there, unlinked by the foreign
  // key rather than by anything in the application.
  expect(await daysOn(SHOOT)).toHaveLength(0);
  for (const id of ids) {
    expect(await videoExists(id)).toBe(true);
    expect(await dayOfVideo(id)).toBeNull();
  }
});

test('deleting a day from psql unlinks exactly the same way', async () => {
  // The claim above is the foreign key's, not the action's, so it is worth
  // making once without the application in the room: `on delete set null
  // (filming_day_id)` nulls that column and leaves `user_id` — and every other
  // column — alone.
  const day = await makeDay(SHOOT);
  const rows = await db.query<{ id: string }>(
    'select id from public.videos where title = any($1::text[])',
    [[TITLES.kettle, TITLES.lens]],
  );
  const ids = rows.rows.map((row) => row.id);
  await linkInDatabase(day, ids);

  await db.query('delete from public.filming_days where id = $1', [day]);

  for (const id of ids) {
    const row = await db.query<{ filming_day_id: string | null; user_id: string }>(
      'select filming_day_id, user_id from public.videos where id = $1',
      [id],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].filming_day_id).toBeNull();
    expect(row.rows[0].user_id).not.toBeNull();
  }
});

/* -------------------------------------------------------------------------- */
/* 6. It is its own kind of event on the calendar                              */
/* -------------------------------------------------------------------------- */

test('the calendar draws a filming day as its own kind of event', async ({
  page,
}) => {
  const day = await makeDay(SHOOT, 'Two shirts.');
  const rows = await db.query<{ id: string }>(
    'select id from public.videos where title = any($1::text[])',
    [[TITLES.kettle, TITLES.desk]],
  );
  await linkInDatabase(
    day,
    rows.rows.map((row) => row.id),
  );
  // A publish date on the same day, so "its own kind of event" is a claim with
  // something to be distinguished *from*.
  await db.query(
    'update public.videos set target_publish_date = $1 where title = $2',
    [SHOOT, TITLES.budget],
  );

  await page.goto(`/calendar?month=${SHOOT.slice(0, 7)}`);

  const filming = page.locator(
    '[data-testid="calendar-chip"][data-kind="filming"]',
  );

  await expect(filming.first()).toBeVisible();
  await expect(filming.first()).toHaveAttribute('data-date', SHOOT);
  // The publish date on the same square is a different kind of thing.
  await expect(
    page.locator(`[data-testid="calendar-chip"][data-kind="publish"]`).first(),
  ).toBeVisible();

  // And it expands to the videos it covers.
  await filming.first().click();
  const dayPanel = page.getByTestId('calendar-day-panel');
  await expect(dayPanel).toBeVisible();
  await expect(dayPanel).toContainText(TITLES.kettle);
  await expect(dayPanel).toContainText(TITLES.desk);
});
