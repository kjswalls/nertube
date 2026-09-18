import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import { addDays, formatDateColumn, monthOf, monthKey, todayColumn } from '../lib/calendar-dates';
import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

import { untilTaken } from './hydration';

/**
 * M6's acceptance, walked: the Wednesday/Saturday scenario.
 *
 * PLAN.md's M6 line is one clause — *Runnable: the Wednesday/Saturday
 * scenario* — and its review line is two: *a filming day whose video left
 * Filming still renders sanely; two filming days on one date is refused.*
 * BRIEF.md says what the scenario is, in principle 4:
 *
 * > *Filming is the only step needing a big time block. When 3+ videos are
 * > sitting in Filming, that's a signal to schedule a batch day.*
 *
 * So the walk is a week:
 *
 * - **Wednesday.** Three videos have piled up in Filming across two channels.
 *   The board says so. One click books the Saturday with all three on it.
 * - **Wednesday, still.** The calendar now shows the Saturday as its own kind
 *   of event, beside the publish dates it already had, and the day expands to
 *   the three videos it is for.
 * - **Saturday.** The shoot happens; the videos move on to Editing. The day
 *   does not become a lie — it reports where they got to.
 * - **The refusals.** A second day on the same Saturday is not a second row.
 *
 * ## What this file is for, given the others
 *
 * `e2e/filming-days.spec.ts` and `e2e/calendar.spec.ts` test the two halves
 * feature by feature. This one is the *join*: it never touches a fixture table
 * between steps, it moves through the product the way a person does, and every
 * step is asked of a page the previous step left behind. The integration bugs
 * this milestone was most exposed to — the board counting one set and the
 * dialog pre-selecting another, the calendar's chip disagreeing with the panel
 * underneath it, `/now` and `/calendar` describing different videos as "waiting
 * for a block of time" — are all *between* the halves, so none of them can be
 * caught inside either half's own file.
 *
 * Serial, because a week is.
 */

test.describe.configure({ mode: 'serial' });

/*
  Two channels whose names are not substrings of each other, nor of any other
  fixture's. Playwright's accessible-name matching is a substring match, so
  "M6 Week" and "M6 Week Two" in one database is a strict-mode violation waiting
  for the first spec that looks a channel up by name — the same trap that bites
  `shell.spec.ts` over "Board". Channels outlive a spec file (nothing deletes
  them), so this is a shared-namespace decision, not a local one.
*/
const CHANNELS = {
  main: { name: 'M6 Walk', slug: 'm6-walk' },
  other: { name: 'M6 Sibling', slug: 'm6-sibling' },
} as const;

const TITLES = {
  /** Three in Filming: the signal BRIEF.md principle 4 names. */
  kettle: 'M6 week — the kettle test',
  shelf: 'M6 week — a shelf that holds',
  /** In the second channel. One creator, one camera. */
  ledger: 'M6 week — the ledger, honestly',
  /** Not in Filming: it has a publish date, so it is on the grid as a chip. */
  essay: 'M6 week — the long essay',
} as const;

/** A fourth video in Filming, added on the day the duplicate is attempted. */
const SPARE = 'M6 week — a spare';

let db: pg.Client;

/** The clock, read once, through the application's own helper. */
const TODAY = todayColumn(Date.now());
/** "Saturday": a free future date inside the month the calendar opens on. */
const SHOOT = addDays(TODAY, 10) as string;
/** The month the whole walk happens in, as `?month=` spells it. */
const SHOOT_MONTH = monthKey(monthOf(SHOOT)!);
/** A publish date on the grid, so the filming day is not the only event. */
const PUBLISH = addDays(TODAY, 12) as string;

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
 * Put the database back — the videos, the days **and the channels**.
 *
 * Not tidiness. `e2e/board.m1.spec.ts` asserts the Filming badge's
 * cross-channel count, and this file leaves three videos sitting in Filming in
 * a shared database that the dev stack reuses between runs. The same trap
 * `e2e/filming-days.spec.ts` documents, arriving from a second file.
 *
 * The channels go too, which they did not until M6's review pointed out that
 * `docs/MILESTONES.md` claimed they did. Leaving them behind is the *other*
 * half of the same trap: a spec that looks a channel up by its accessible name
 * matches on a substring, so every run that leaves a channel row behind makes
 * the next `getByRole('radio', { name: … })` one step closer to a strict-mode
 * violation. The videos are already gone by this point, so nothing blocks the
 * delete; the stages and buckets seeded with each channel go with it on the
 * cascade.
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
  await db?.query('delete from public.channels where slug = any($1::text[])', [
    [CHANNELS.main.slug, CHANNELS.other.slug],
  ]);
  await db?.end();
});

/* -------------------------------------------------------------------------- */
/* Fixture — the state a Wednesday starts in, never the thing under test       */
/* -------------------------------------------------------------------------- */

async function channelRow(slug: string): Promise<{ id: string; user_id: string } | null> {
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
 * One video, packaged, in a named stage.
 *
 * The packaging fields are load-bearing rather than decorative: `move_video`
 * refuses any stage past Packaging without a title, a concept and a chosen
 * hook, and the Saturday step below moves videos on with the stage select.
 */
async function seedVideo({
  slug,
  title,
  kind = 'filming',
  date = null,
}: {
  slug: string;
  title: string;
  kind?: string;
  date?: string | null;
}): Promise<string> {
  const channel = await channelRow(slug);
  if (!channel) throw new Error(`the fixture channel ${slug} is missing`);
  const stageId = await stageIdFor(channel.id, kind);

  const inserted = await db.query<{ id: string }>(
    `insert into public.videos (
       user_id, channel_id, stage_id, title, target_publish_date,
       thumbnail_concept, hooks
     ) values (
       $1, $2, $3, $4, $5,
       'A kettle, mid-pour, and a stopwatch',
       '[{"id":"h1","text":"I timed every kettle in the house","chosen":true}]'::jsonb
     ) returning id`,
    [channel.user_id, channel.id, stageId, title, date],
  );
  const videoId = inserted.rows[0].id;

  /*
    The checklist the stage would have been entered with.

    `move_video` snapshot-copies `checklist_templates` into `checklist_items` on
    first entry to a stage, so a video that got to Filming the way a person
    gets there has one. This fixture inserts the row directly, so it has to do
    the same copy — otherwise `/now` ranks the video by rule 8 ("move it on")
    instead of rule 6 ("the first unchecked item"), and rule 6 is the only one
    that carries the `needs a block` tag this walk is about. Same statement as
    the migration's, so the two cannot drift.
  */
  await db.query(
    `insert into public.checklist_items
       (user_id, video_id, channel_id, stage_id, text, position, est_minutes)
     select $1, $2, $3, $4, t.text, t.position, t.est_minutes
       from public.checklist_templates t
      where t.stage_id = $4`,
    [channel.user_id, videoId, channel.id, stageId],
  );

  return videoId;
}

/* -------------------------------------------------------------------------- */
/* Database questions — the claims that outlive a render                       */
/* -------------------------------------------------------------------------- */

async function daysOn(onDate: string): Promise<{ id: string; notes: string | null }[]> {
  const result = await db.query<{ id: string; notes: string | null }>(
    'select id, notes from public.filming_days where on_date = $1',
    [onDate],
  );
  return result.rows;
}

async function videosOn(dayId: string): Promise<string[]> {
  const result = await db.query<{ title: string }>(
    'select title from public.videos where filming_day_id = $1 order by title',
    [dayId],
  );
  return result.rows.map((row) => row.title);
}

async function dayOfVideo(videoId: string): Promise<string | null> {
  const result = await db.query<{ filming_day_id: string | null }>(
    'select filming_day_id from public.videos where id = $1',
    [videoId],
  );
  return result.rows[0]?.filming_day_id ?? null;
}

/**
 * How many videos are in Filming and *not yet on a day* — the number
 * `/calendar` puts on its "waiting for a filming day" line.
 *
 * Read rather than written down, for the reason every count in this suite is:
 * the dev stack seeds a demo account and the database is shared between spec
 * files, so a literal here would be asserting against somebody else's fixture.
 */
async function waitingForADayCount(): Promise<number> {
  const result = await db.query<{ count: string }>(
    `select count(*)::text as count
       from public.videos v
       join public.stages s on s.id = v.stage_id
      where s.kind = 'filming' and s.is_enabled
        and v.archived_at is null and v.filming_day_id is null`,
  );
  return Number(result.rows[0].count);
}

/** Videos targeted at a month — what the sidebar's Calendar badge counts. */
async function targetsIn(month: string): Promise<number> {
  const result = await db.query<{ count: string }>(
    `select count(*)::text as count
       from public.videos
      where archived_at is null
        and to_char(target_publish_date, 'YYYY-MM') = $1`,
    [month],
  );
  return Number(result.rows[0].count);
}

/** How many videos are in Filming right now, across every channel. */
async function filmingCount(): Promise<number> {
  const result = await db.query<{ count: string }>(
    `select count(*)::text as count
       from public.videos v
       join public.stages s on s.id = v.stage_id
      where s.kind = 'filming' and s.is_enabled and v.archived_at is null`,
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

async function createChannel(page: Page, channel: { name: string; slug: string }) {
  await page.goto('/c/new');
  await page.getByLabel('Channel name').fill(channel.name);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.waitForURL(`**/c/${channel.slug}/board`);
}

async function openBoard(page: Page, slug = CHANNELS.main.slug): Promise<void> {
  await page.goto(`/c/${slug}/board`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
}

const badge = (page: Page): Locator => page.getByTestId('filming-badge');
const dialog = (page: Page): Locator => page.getByTestId('schedule-day-dialog');
const cell = (page: Page, date: string): Locator =>
  page.locator(`[data-testid="calendar-day"][data-date="${date}"]`);

/** The interactive filming-day panel, wherever it is rendered. */
const dayPanel = (page: Page, testId: string): Locator => page.getByTestId(testId);

async function openScheduleDialogFromBoard(page: Page): Promise<void> {
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

async function selectOnly(page: Page, titles: readonly string[]): Promise<void> {
  const boxes = page.getByTestId('filming-candidate');
  const count = await boxes.count();
  for (let index = 0; index < count; index += 1) {
    const box = boxes.nth(index);
    const text = (await box.locator('xpath=..').innerText()).trim();
    const wanted = titles.some((title) => text.includes(title));
    if ((await box.isChecked()) !== wanted) await box.click();
  }
}

/* -------------------------------------------------------------------------- */
/* The week                                                                    */
/* -------------------------------------------------------------------------- */

test.beforeAll(async () => {
  // A clean week. Filming days are user-level, so they go wholesale.
  await db.query(
    `delete from public.videos
      where channel_id in (
        select id from public.channels where slug = any($1::text[])
      )`,
    [[CHANNELS.main.slug, CHANNELS.other.slug]],
  );
  await db.query('delete from public.filming_days');
});

/*
  Each test gets its own browser context, so the session does not survive from
  one to the next even in a serial file. Signing in is therefore per test — the
  week is continuous in the *database*, which is where the state this walk is
  about actually lives.
*/
test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test('Wednesday: three in Filming, and the board is the thing that notices', async ({
  page,
}) => {
  for (const channel of [CHANNELS.main, CHANNELS.other]) {
    if ((await channelRow(channel.slug)) === null) {
      await createChannel(page, channel);
    }
  }

  await seedVideo({ slug: CHANNELS.main.slug, title: TITLES.kettle });
  await seedVideo({ slug: CHANNELS.main.slug, title: TITLES.shelf });
  await seedVideo({ slug: CHANNELS.other.slug, title: TITLES.ledger });
  await seedVideo({
    slug: CHANNELS.main.slug,
    title: TITLES.essay,
    kind: 'scripting',
    date: PUBLISH,
  });

  const total = await filmingCount();
  expect(total).toBeGreaterThanOrEqual(3);

  await openBoard(page);

  // BRIEF.md principle 4's threshold, and the sentence the board has carried
  // since M1 — now a control rather than a label.
  await expect(badge(page)).toHaveText(
    new RegExp(`^${total} in Filming( across all channels)? — schedule batch day\\?$`),
  );
  await expect(badge(page)).toHaveRole('button');
});

test('Wednesday: /now and the calendar agree about what is waiting for a block', async ({
  page,
}) => {
  /*
    The disagreement this step exists to refuse: `/now` hides the filming rows
    behind its "10 minutes or less" filter, because ten spare minutes will not
    shoot anything. If that were the end of it, the three videos would be
    invisible in the one view whose job is "what can I move right now" and
    absent from the one view whose job is booking the block. Both views name the
    same set, and each points at the other.
  */
  await page.goto('/now');

  const blocked = page
    .getByTestId('now-row')
    .filter({ hasText: TITLES.kettle })
    .getByTestId('needs-a-block');
  await expect(blocked).toBeVisible();
  // A filming row's chip is the way to the calendar, where the block is booked.
  await expect(blocked).toHaveAttribute('data-stage-kind', 'filming');
  await blocked.click();
  await page.waitForURL('**/calendar**');

  const waiting = page.getByTestId('calendar-waiting-for-a-day');
  await expect(waiting).toBeVisible();
  // The same set, counted once: `readFilmingVideos()` minus the ones on a day.
  await expect(waiting).toHaveAttribute(
    'data-count',
    String(await waitingForADayCount()),
  );
  await expect(waiting).toContainText('waiting for a filming day');
});

test('Wednesday: one click books the Saturday with all three on it', async ({
  page,
}) => {
  await openBoard(page);
  await openScheduleDialogFromBoard(page);

  // Everything the badge counted arrives ticked — including the one in the
  // other channel, because there is one creator and one camera.
  await expect(dialog(page)).toContainText(TITLES.ledger);

  await selectOnly(page, [TITLES.kettle, TITLES.shelf, TITLES.ledger]);
  await page.getByTestId('filming-day-date').fill(SHOOT);
  await page.getByTestId('filming-day-notes-new').fill('Two shirts, one set.');
  await page.getByTestId('schedule-day-submit').click();

  // The dialog becomes the day it just made.
  await expect(dayPanel(page, 'filming-day-panel')).toBeVisible();
  await expect(page.getByTestId('filming-day-headline')).toHaveText(
    '3 videos to shoot.',
  );

  // And the database agrees, which is the claim that survives the render.
  const days = await daysOn(SHOOT);
  expect(days).toHaveLength(1);
  expect(days[0].notes).toBe('Two shirts, one set.');
  expect(await videosOn(days[0].id)).toEqual([
    TITLES.shelf,
    TITLES.kettle,
    TITLES.ledger,
  ].sort());
});

test('Wednesday: the calendar draws the Saturday as its own kind of event', async ({
  page,
}) => {
  await page.goto(`/calendar?month=${SHOOT_MONTH}`);

  // Two event types on one grid — the whole point of the view.
  const filmingChip = cell(page, SHOOT).locator(
    '[data-testid="calendar-chip"][data-kind="filming"]',
  );
  await expect(filmingChip).toHaveCount(1);
  await expect(filmingChip).toContainText('Filming day');

  const publishChip = cell(page, PUBLISH)
    .locator('[data-testid="calendar-chip"][data-kind="publish"]')
    .filter({ hasText: TITLES.essay });
  await expect(publishChip).toHaveCount(1);

  // The heading counts them separately: they are different kinds of thing.
  await expect(page.getByTestId('calendar-summary')).toContainText('1 filming day');

  /*
    The three that were waiting on Wednesday morning are on a day now, so the
    line no longer counts them. It still counts whatever else the account has
    sitting in Filming — which is the point: the number is derived, not a
    latch, so the booking and the count cannot drift apart.
  */
  const waiting = page.getByTestId('calendar-waiting-for-a-day');
  const stillWaiting = await waitingForADayCount();
  if (stillWaiting === 0) {
    await expect(waiting).toHaveCount(0);
  } else {
    await expect(waiting).toHaveAttribute('data-count', String(stillWaiting));
  }

  // The sidebar's Calendar entry is a real destination, not a placeholder,
  // with a count the page it opens agrees with.
  const link = page
    .getByTestId('app-sidebar')
    .getByRole('link', { name: 'Calendar', exact: true });
  await expect(link).toHaveAttribute('href', '/calendar');
  await expect(link).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('sidebar-calendar-count')).toHaveAttribute(
    'data-count',
    String(await targetsIn(SHOOT_MONTH)),
  );
});

test('Wednesday: the day expands, in place, to the videos it is for', async ({
  page,
}) => {
  await page.goto(`/calendar?month=${SHOOT_MONTH}`);
  await cell(page, SHOOT)
    .locator('[data-testid="calendar-chip"][data-kind="filming"]')
    .click();
  await page.waitForURL(`**/calendar?month=${SHOOT_MONTH}&day=${SHOOT}`);

  /*
    The seam this integration closed. The calendar used to render a read-only
    copy of a filming day beside the real one; now it renders *the* panel — the
    same component the board's dialog opens — so the day can be changed from
    the day you are looking at.
  */
  const panel = dayPanel(page, 'calendar-filming-day-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(formatDateColumn(SHOOT, 'full')!);
  await expect(panel.getByTestId('filming-day-video')).toHaveCount(3);
  await expect(panel.getByTestId('filming-day-notes')).toHaveValue(
    'Two shirts, one set.',
  );
  await expect(page.getByTestId('filming-day-headline')).toHaveText(
    '3 videos to shoot.',
  );
  // Quiet: an upcoming day with everything still to shoot is not asking for
  // anything. Colour is reserved for the shoot that did not happen.
  await expect(panel).toHaveAttribute('data-tone', 'quiet');
});

test('two filming days on one date is refused, and offers the one that exists', async ({
  page,
}) => {
  // PLAN.md's M6 review item, from the calendar rather than the board: a second
  // day on a booked date is an answer, not an error message with a constraint
  // name in it.
  await seedVideo({ slug: CHANNELS.main.slug, title: SPARE });

  await page.goto(`/calendar?month=${SHOOT_MONTH}`);
  await page.getByTestId('schedule-filming-day').click();
  await expect(dialog(page)).toBeVisible();

  await selectOnly(page, [SPARE]);
  await page.getByTestId('filming-day-date').fill(SHOOT);
  await page.getByTestId('schedule-day-submit').click();

  // Not an error and not a constraint name: the day they already have.
  const notice = page.getByTestId('filming-day-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('already have a filming day');
  await expect(
    page.getByText('filming_days_user_id_on_date_key'),
  ).toHaveCount(0);

  // It is that day, with the three it already covers.
  await expect(dayPanel(page, 'filming-day-panel')).toBeVisible();
  await expect(page.getByTestId('filming-day-video')).toHaveCount(3);

  // And the offer does what it says.
  await page.getByTestId('add-to-existing-day').click();
  await expect(page.getByTestId('filming-day-video')).toHaveCount(4);

  // Still exactly one row. `unique (user_id, on_date)` is what makes a filming
  // day *the* Saturday.
  expect(await daysOn(SHOOT)).toHaveLength(1);
});

test('Saturday: the shoot happens, and the day reports where they got to', async ({
  page,
}) => {
  // PLAN.md's other M6 review item. The videos move on the way a person moves
  // them — the stage select on their own page, through `move_video`.
  const rows = await db.query<{ id: string; title: string }>(
    'select id, title from public.videos where title = any($1::text[])',
    [[TITLES.kettle, TITLES.shelf]],
  );
  const editingId = await stageIdFor(
    (await channelRow(CHANNELS.main.slug))!.id,
    'editing',
  );

  for (const row of rows.rows) {
    await page.goto(`/videos/${row.id}?section=schedule`);
    const stageSelect = page.getByTestId('stage-select');
    await untilTaken(
      async () => {
        await stageSelect.selectOption({ label: 'Editing' });
      },
      async () => {
        await expect(stageSelect).toHaveValue(editingId, { timeout: 6_000 });
      },
    );
    // Leaving Filming is not leaving the day: the link is a fact about when it
    // was shot, not about where it is now.
    expect(await dayOfVideo(row.id)).toBe((await daysOn(SHOOT))[0].id);
  }

  await page.goto(`/calendar?month=${SHOOT_MONTH}&day=${SHOOT}`);
  const panel = dayPanel(page, 'calendar-filming-day-panel');
  await expect(panel).toBeVisible();

  // Nothing was hidden: four videos, each with the stage it is in *today*.
  await expect(panel.getByTestId('filming-day-video')).toHaveCount(4);
  await expect(
    panel.getByTestId('filming-day-video').filter({ hasText: TITLES.kettle }),
  ).toHaveAttribute('data-status', 'moved_on');
  await expect(
    panel.getByTestId('filming-day-video').filter({ hasText: TITLES.ledger }),
  ).toHaveAttribute('data-status', 'to_shoot');

  /*
    And the headline is the truth about the day rather than what was true when
    the videos were attached to it.

    This is the *upcoming* form of that sentence, because the booked date has
    not arrived yet — two of the four were simply filmed early, which is a
    normal week and not an exception. The other form ("2 of 4 moved on; 2 still
    waiting to be filmed") belongs to a day that has *passed* with videos still
    in Filming, which is the one state on this page that takes colour;
    `e2e/filming-days.spec.ts` covers that one against a past date.
  */
  await expect(page.getByTestId('filming-day-headline')).toHaveText(
    '4 videos: 2 to shoot, 2 already moved on.',
  );
  await expect(panel).toHaveAttribute('data-tone', 'quiet');
});

test('the calendar can change the day it is showing', async ({ page }) => {
  await page.goto(`/calendar?month=${SHOOT_MONTH}&day=${SHOOT}`);
  const panel = dayPanel(page, 'calendar-filming-day-panel');

  const ledger = panel
    .getByTestId('filming-day-video')
    .filter({ hasText: TITLES.ledger });
  await expect(ledger).toBeVisible();

  await untilTaken(
    async () => {
      if ((await ledger.count()) === 0) return;
      await ledger.getByTestId('filming-day-detach').click();
    },
    async () => {
      await expect(ledger).toHaveCount(0, { timeout: 4_000 });
    },
  );

  // The video is off the day and is otherwise untouched — which is the database
  // saying it, not the panel.
  const rows = await db.query<{ id: string }>(
    'select id from public.videos where title = $1',
    [TITLES.ledger],
  );
  expect(await dayOfVideo(rows.rows[0].id)).toBeNull();
  expect(await videosOn((await daysOn(SHOOT))[0].id)).toHaveLength(3);

  // And it is waiting for a block again, in both views, without a reload of
  // anybody's mental model.
  await page.goto('/calendar');
  await expect(page.getByTestId('calendar-waiting-for-a-day')).toBeVisible();
});
