import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/**
 * `/now` — the Monday scenario, walked in a browser.
 *
 * PLAN.md's M3 line: *Runnable: the Monday scenario — ten minutes on `/now`,
 * complete rows without opening cards.* That sentence is the whole of this
 * file. It is not a unit test of the ranking (that is
 * `lib/next-action.test.ts`, 68 assertions against the eight rules); it is the
 * claim that a person with ten minutes can sit down in front of this page and
 * move four videos forward without ever opening one.
 *
 * Two rules it follows throughout:
 *
 * 1. **Every browser claim that changes a row is paired with a read of that
 *    row.** "The toast said it saved" and "the database has it" are different
 *    sentences, and only the second one matters on Tuesday.
 * 2. **The URL is asserted after every completion.** The page's promise is
 *    *without leaving the page*; a row that quietly navigated to
 *    `/videos/[id]` to do its work would pass every other assertion here.
 *
 * ## Why the fixture is SQL and the actions are clicks
 *
 * A week takes eight videos spread across six stages with specific ages, and
 * building that through the UI would be several minutes of dragging per test
 * and would test M1's board rather than M3's list. So the *state* is written
 * directly — as the owning user, with the same shapes `move_video` produces,
 * including its checklist snapshot — and everything this file is actually about
 * is done the way a person does it.
 *
 * The suite shares one database with every other spec, and specs that ran
 * earlier leave videos of their own in other channels, which `/now` is
 * cross-channel and therefore shows. Every assertion here is made with this
 * channel's chip switched on, which is both the scoping this file needs and the
 * filter PLAN.md asks for.
 */

const CHANNEL = { name: 'M3 Now', slug: 'm3-now' };

/**
 * The video the gate is Overdue about has **no title at all** — that is the
 * state rule 1 exists for, and it is why this one is found by id rather than by
 * name: on the page it reads "Untitled" until the row is finished.
 */
const UNTITLED = '';

const TITLES = {
  overdueTitle: UNTITLED,
  published: 'The one that went live yesterday',
  packaging: 'The one in packaging',
  readyToMove: 'The one that is ready to move',
  editing: 'The one with the editor',
  scheduled: 'The one going live next week',
  filming: 'The one that still needs filming',
  idea: 'An idea that is only an idea',
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

async function channelRow(): Promise<{ id: string; user_id: string } | null> {
  const result = await db.query<{ id: string; user_id: string }>(
    'select id, user_id from public.channels where slug = $1',
    [CHANNEL.slug],
  );
  return result.rows[0] ?? null;
}

async function stageIdFor(channelId: string, kind: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    'select id from public.stages where channel_id = $1 and kind = $2',
    [channelId, kind],
  );
  if (!result.rows[0]) throw new Error(`no ${kind} stage on ${CHANNEL.slug}`);
  return result.rows[0].id;
}

interface SeedVideo {
  title: string;
  kind: string;
  /** How long it has been in that stage, as a Postgres interval. */
  age: string;
  packagingComplete?: boolean;
  /** Copy the stage's checklist templates in, as `move_video` would. */
  withChecklist?: boolean;
  /** Tick every copied item. */
  allChecked?: boolean;
  waitingOn?: string;
  targetInDays?: number;
  publishedAgo?: string;
}

/**
 * One video, written the way `move_video` would have left it.
 *
 * The checklist copy is the same `insert … select` the function runs, which is
 * what makes "the first unticked item" a real question here rather than a
 * fixture-shaped one.
 */
async function seedVideo(
  channel: { id: string; user_id: string },
  video: SeedVideo,
): Promise<string> {
  const stageId = await stageIdFor(channel.id, video.kind);
  const complete = video.packagingComplete ?? true;

  const inserted = await db.query<{ id: string }>(
    `insert into public.videos (
       user_id, channel_id, stage_id, stage_entered_at,
       title, thumbnail_concept, hooks,
       waiting_on, waiting_since, target_publish_date, published_at
     ) values (
       $1, $2, $3, now() - $4::interval,
       $5, $6, $7::jsonb,
       $8, case when $8::text is null then null else now() - $4::interval end,
       case when $9::int is null then null else (current_date + $9::int) end,
       case when $10::text is null then null else now() - $10::interval end
     ) returning id`,
    [
      channel.user_id,
      channel.id,
      stageId,
      video.age,
      video.title,
      complete ? 'A close-up of the thing, mid-failure' : null,
      complete
        ? JSON.stringify([{ id: 'h1', text: 'The hook, as spoken', chosen: true }])
        : '[]',
      video.waitingOn ?? null,
      video.targetInDays ?? null,
      video.publishedAgo ?? null,
    ],
  );

  const id = inserted.rows[0].id;

  if (video.withChecklist) {
    await db.query(
      `insert into public.checklist_items (user_id, video_id, channel_id, stage_id, text, position, est_minutes, checked_at)
       select $1, $2, $3, $4, t.text, t.position, t.est_minutes,
              case when $5::boolean then now() else null end
         from public.checklist_templates t
        where t.stage_id = $4`,
      [channel.user_id, id, channel.id, stageId, video.allChecked ?? false],
    );
  }

  return id;
}

/**
 * The eight-video week.
 *
 * Ages carry an extra hour so that "12 days" is never within a second of the
 * boundary: a floored day count that flips halfway through a run is a flake,
 * not a finding.
 */
async function seedWeek(): Promise<Record<keyof typeof TITLES, string>> {
  const channel = await channelRow();
  if (!channel) throw new Error('the fixture channel is missing');

  return {
    // Overdue: moved past the gate, then the title was cleared.
    overdueTitle: await seedVideo(channel, {
      title: UNTITLED,
      kind: 'scripting',
      age: '11 days 1 hour',
      withChecklist: true,
    }),
    // Overdue: live 25 hours, no metrics. No checklist at all, so once the
    // numbers are in it has nothing left to offer — "zero items is not all
    // checked" from the other side.
    published: await seedVideo(channel, {
      title: TITLES.published,
      kind: 'published',
      age: '25 hours',
      publishedAgo: '25 hours',
    }),
    // Ready: the next unticked box.
    packaging: await seedVideo(channel, {
      title: TITLES.packaging,
      kind: 'packaging',
      age: '4 days 1 hour',
      withChecklist: true,
    }),
    // Ready: checklist done and the gate open, so the row is the move.
    readyToMove: await seedVideo(channel, {
      title: TITLES.readyToMove,
      kind: 'packaging',
      age: '12 days 1 hour',
      withChecklist: true,
      allChecked: true,
    }),
    // Waiting: somebody else has it.
    editing: await seedVideo(channel, {
      title: TITLES.editing,
      kind: 'editing',
      age: '6 days 1 hour',
      waitingOn: 'the editor',
      withChecklist: true,
    }),
    // Waiting: the date has not arrived.
    scheduled: await seedVideo(channel, {
      title: TITLES.scheduled,
      kind: 'scheduled',
      age: '1 day 1 hour',
      targetInDays: 7,
    }),
    // Ready, but it needs a block — the ten-minute filter hides it.
    filming: await seedVideo(channel, {
      title: TITLES.filming,
      kind: 'filming',
      age: '3 days 1 hour',
      withChecklist: true,
    }),
    // Not a row. Ever.
    idea: await seedVideo(channel, {
      title: TITLES.idea,
      kind: 'idea',
      age: '30 days',
      packagingComplete: false,
    }),
  };
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
  // `/` is PLAN.md's front door and, as of M3, it lands on `/now` rather than
  // on a board. This spec works on a board, so it goes to one the way a user
  // would — the sidebar's Board link, which points at the first channel, the
  // very one `/` used to redirect to. The post-condition is unchanged: after
  // this helper the page is on a board.
  await page.waitForURL('**/now');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Board', exact: true })
    .click();
  await page.waitForURL(/\/c\/[^/]+\/board$/);
}

async function createChannel(page: Page): Promise<void> {
  await page.goto('/c/new');
  await page.getByLabel('Channel name').fill(CHANNEL.name);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.waitForURL(`**/c/${CHANNEL.slug}/board`);
}

/** Open `/now` and narrow it to this fixture's channel. */
async function openNow(page: Page): Promise<void> {
  await page.goto('/now');
  await expect(page.getByTestId('now')).toHaveAttribute('data-ready', 'true');
  await page
    .getByTestId('channel-chip')
    .filter({ hasText: CHANNEL.name })
    .click();
}

const rows = (page: Page): Locator => page.getByTestId('now-row');

const rowFor = (page: Page, title: string): Locator =>
  rows(page).filter({ hasText: title });

/** The row for one video, by id — the only way to find a row with no title. */
const rowById = (page: Page, videoId: string): Locator =>
  page.locator(`[data-testid="now-row"][data-video-id="${videoId}"]`);

/** Every row's label, in the order the page has them. */
async function labels(page: Page): Promise<string[]> {
  return page.getByTestId('now-label').allInnerTexts();
}

let ids: Record<keyof typeof TITLES, string>;

test.beforeEach(async ({ page }) => {
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug = $1)`,
    [CHANNEL.slug],
  );

  await signIn(page);
  if ((await channelRow()) === null) await createChannel(page);
  ids = await seedWeek();
});

/* -------------------------------------------------------------------------- */
/* The list                                                                    */
/* -------------------------------------------------------------------------- */

test('the Monday list: three sections, staleness order, and no ideas', async ({
  page,
}) => {
  await openNow(page);

  await expect(rows(page)).toHaveCount(7);

  // Overdue, then Ready, then Waiting; longest in stage first inside each.
  expect(await labels(page)).toEqual([
    'Complete packaging: a working title',
    'Log 24h impressions + CTR',
    'Move to Scripting',
    'Generated 10–20 title candidates, not 3',
    "Outline visible while filming (don't rely on memory)",
    'Waiting on the editor',
    expect.stringMatching(/^Goes live /),
  ]);

  await expect(rows(page).nth(0)).toHaveAttribute('data-section', 'overdue');
  await expect(rows(page).nth(1)).toHaveAttribute('data-section', 'overdue');
  await expect(rows(page).nth(2)).toHaveAttribute('data-section', 'ready');
  await expect(rows(page).nth(5)).toHaveAttribute('data-section', 'waiting');

  // The bank contributes nothing, however old it is.
  await expect(rowFor(page, TITLES.idea)).toHaveCount(0);
});

test('"10 minutes or less" hides the work that needs a block', async ({ page }) => {
  await openNow(page);
  await expect(rows(page)).toHaveCount(7);

  await page.getByTestId('quick-filter').click();

  // Gone: Filming and Editing (they need a block) and the 15-minute packaging
  // item. Left: four rows that really are ten minutes.
  await expect(rows(page)).toHaveCount(4);
  await expect(rowFor(page, TITLES.filming)).toHaveCount(0);
  await expect(rowFor(page, TITLES.editing)).toHaveCount(0);
  await expect(rowFor(page, TITLES.packaging)).toHaveCount(0);
  await expect(rowFor(page, TITLES.published)).toHaveCount(1);
  await expect(page.getByTestId('filtered-out')).toContainText('3 hidden');

  await page.getByTestId('quick-filter').click();
  await expect(rows(page)).toHaveCount(7);
});

test('the channel chips narrow the list to one channel', async ({ page }) => {
  await page.goto('/now');
  await expect(page.getByTestId('now')).toHaveAttribute('data-ready', 'true');

  // Unfiltered, the page is cross-channel — the seeded channels are there too.
  const everything = await rows(page).count();
  expect(everything).toBeGreaterThanOrEqual(7);

  await page.getByTestId('channel-chip').filter({ hasText: CHANNEL.name }).click();
  await expect(rows(page)).toHaveCount(7);
  await expect(
    rows(page).filter({ hasText: CHANNEL.name }),
  ).toHaveCount(7);
});

/* -------------------------------------------------------------------------- */
/* Ten minutes                                                                 */
/* -------------------------------------------------------------------------- */

test('four rows finished in ten minutes, without opening a single card', async ({
  page,
}) => {
  await openNow(page);

  /* -- tick the next checklist item ------------------------------------- */

  const packagingRow = rowFor(page, TITLES.packaging);
  await packagingRow.getByTestId('now-tick').click();

  // The row does not vanish: the next item takes its place. That is the whole
  // mechanic of the page — one action, then the next one, in the same row.
  await expect(packagingRow.getByTestId('now-label')).toHaveText(
    'Chosen title sells the *result*, not the content',
  );
  expect(page.url()).toContain('/now');

  const ticked = await db.query<{ n: string }>(
    `select count(*) as n from public.checklist_items ci
       join public.videos v on v.id = ci.video_id
      where v.title = $1 and ci.checked_at is not null`,
    [TITLES.packaging],
  );
  expect(Number(ticked.rows[0].n)).toBe(1);

  /* -- write the missing title ------------------------------------------ */

  const overdueRow = rowById(page, ids.overdueTitle);
  await overdueRow.getByTestId('now-text').fill('Ten minutes is enough');
  await overdueRow.getByTestId('now-text').press('Enter');

  // Gate satisfied, so the row is no longer Overdue — it is the video's next
  // scripting item instead.
  await expect(overdueRow.getByTestId('now-label')).toHaveText(
    'Hook scripted word-for-word (rest can be bullets)',
  );
  await expect(overdueRow).toHaveAttribute('data-section', 'ready');
  expect(page.url()).toContain('/now');

  const titled = await db.query(
    'select id from public.videos where title = $1',
    ['Ten minutes is enough'],
  );
  expect(titled.rowCount).toBe(1);

  /* -- log the first 24 hours, both numbers together --------------------- */

  const publishedRow = rowFor(page, TITLES.published);
  await publishedRow.getByTestId('metrics-impressions').fill('12400');
  await publishedRow.getByTestId('metrics-ctr').fill('4.2');
  await publishedRow.getByTestId('metrics-save').click();

  // Nothing left on that video: it has no checklist in Published and there is
  // no expectation to be under.
  await expect(rowFor(page, TITLES.published)).toHaveCount(0);
  expect(page.url()).toContain('/now');

  const metrics = await db.query<{
    first24_impressions: number;
    first24_ctr: string;
    metrics_logged_at: string | null;
  }>(
    'select first24_impressions, first24_ctr, metrics_logged_at from public.videos where title = $1',
    [TITLES.published],
  );
  expect(metrics.rows[0].first24_impressions).toBe(12400);
  expect(Number(metrics.rows[0].first24_ctr)).toBeCloseTo(4.2, 2);
  expect(metrics.rows[0].metrics_logged_at).not.toBeNull();

  /* -- unblock the one that was waiting ---------------------------------- */

  const editingRow = rowFor(page, TITLES.editing);
  await editingRow.getByTestId('now-unblocked').click();

  await expect(rowFor(page, TITLES.editing)).toHaveAttribute('data-section', 'ready');
  expect(page.url()).toContain('/now');

  const unblocked = await db.query<{
    waiting_on: string | null;
    waiting_since: string | null;
  }>('select waiting_on, waiting_since from public.videos where title = $1', [
    TITLES.editing,
  ]);
  expect(unblocked.rows[0].waiting_on).toBeNull();
  // The CHECK pairs them: cleared together or not at all.
  expect(unblocked.rows[0].waiting_since).toBeNull();
});

test('a move row moves the video, and the database agrees', async ({ page }) => {
  await openNow(page);

  await rowFor(page, TITLES.readyToMove).getByTestId('now-move').click();

  await expect(page.getByTestId('toast')).toContainText('Moved to Scripting');
  expect(page.url()).toContain('/now');

  const moved = await db.query<{ kind: string; items: string }>(
    `select s.kind,
            (select count(*) from public.checklist_items ci
              where ci.video_id = v.id and ci.stage_id = v.stage_id) as items
       from public.videos v
       join public.stages s on s.id = v.stage_id
      where v.title = $1`,
    [TITLES.readyToMove],
  );
  expect(moved.rows[0].kind).toBe('scripting');
  // `move_video` snapshotted the next stage's templates on the way in.
  expect(Number(moved.rows[0].items)).toBe(9);

  // And the page caught up with what the server now knows: the video's row is
  // the first item of its new stage.
  await expect(
    rowFor(page, TITLES.readyToMove).getByTestId('now-label'),
  ).toHaveText('Hook scripted word-for-word (rest can be bullets)');
});

/* -------------------------------------------------------------------------- */
/* The keyboard                                                                */
/* -------------------------------------------------------------------------- */

test('j and k select, x completes, Enter opens', async ({ page }) => {
  await openNow(page);

  await page.keyboard.press('j');
  await expect(rows(page).nth(0)).toHaveAttribute('data-selected', 'true');

  await page.keyboard.press('j');
  await expect(rows(page).nth(1)).toHaveAttribute('data-selected', 'true');

  await page.keyboard.press('k');
  await expect(rows(page).nth(0)).toHaveAttribute('data-selected', 'true');

  // Row 0 is the Overdue "Complete packaging" row, which needs something typed:
  // `x` refuses to guess and puts the caret in the box instead.
  await page.keyboard.press('x');
  await expect(rows(page).nth(0).getByTestId('now-text')).toBeFocused();
  await rows(page).nth(0).getByTestId('now-text').blur();

  // The packaging row is a tick, and a tick is what `x` is for. Selected by
  // clicking the label rather than the row, so the click cannot land on a
  // control and do something of its own.
  await rowFor(page, TITLES.packaging).getByTestId('now-label').click();
  await expect(rowFor(page, TITLES.packaging)).toHaveAttribute(
    'data-selected',
    'true',
  );
  await page.keyboard.press('x');
  await expect(rowFor(page, TITLES.packaging).getByTestId('now-label')).toHaveText(
    'Chosen title sells the *result*, not the content',
  );

  // Enter opens the video the selected row is about.
  const videoId = await rowFor(page, TITLES.packaging).getAttribute('data-video-id');
  await page.keyboard.press('Enter');
  await page.waitForURL(`**/videos/${videoId}`);
});

/* -------------------------------------------------------------------------- */
/* The weekly strip                                                            */
/* -------------------------------------------------------------------------- */

test('the weekly strip counts each column and ages it', async ({ page }) => {
  await page.goto(`/c/${CHANNEL.slug}/board`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');

  const strip = page.getByTestId('weekly-strip');
  await expect(strip).toBeVisible();

  const packaging = strip
    .getByTestId('strip-cell')
    .filter({ has: page.getByText('Packaging (TTH)', { exact: true }) });

  // Two cards, 4 days and 12 days: oldest 12, median (4 + 12) / 2 = 8.
  await expect(packaging.getByTestId('strip-count')).toHaveText('2');
  await expect(packaging.getByTestId('strip-ages')).toContainText('12d / 8d');

  // A column with one card is its own median.
  const scripting = strip
    .getByTestId('strip-cell')
    .filter({ has: page.getByText('Scripting', { exact: true }) });
  await expect(scripting.getByTestId('strip-ages')).toContainText('11d / 11d');

  // An empty column is not drawn at all — quiet columns stay quiet.
  await expect(
    strip.getByTestId('strip-cell').filter({ hasText: 'Publish Prep' }),
  ).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* The sidebar's count is this page's count                                    */
/* -------------------------------------------------------------------------- */

/**
 * The badge beside "Now" in the sidebar, and the only property that makes it
 * worth drawing: it is the same number as the list.
 *
 * It is computed from `rankNow()` over the same rows the page renders
 * (`lib/now-data.ts`), not from a cheaper "videos not archived" count, which
 * would include the idea bank and a good deal else this page deliberately never
 * shows. The three checks below are the three ways that could come apart:
 *
 * 1. On `/now` itself the badge equals the rows on screen.
 * 2. Filtering the page does **not** move it — the chips are a narrowing the
 *    user does, and a badge that followed them would be reporting the filter.
 * 3. Away from `/now` — on a board, where the count is the only reason those
 *    reads happen — it is still the same number.
 *
 * The count is `aria-hidden` and the number is repeated in the link's `title`,
 * so the link's accessible name stays exactly "Now"; that is asserted too,
 * because it is what keeps `e2e/shell.spec.ts`'s exact-name locator honest.
 */
test('the sidebar says how many rows /now has, and keeps saying it elsewhere', async ({
  page,
}) => {
  // Deliberately NOT `openNow`, which narrows to this fixture's channel: the
  // badge counts every channel, because it is a count of the work and not of
  // the filter. The page with no filter on is the thing it has to agree with.
  await page.goto('/now');
  await expect(page.getByTestId('now')).toHaveAttribute('data-ready', 'true');

  const onScreen = await rows(page).count();
  expect(onScreen).toBeGreaterThan(0);

  const badge = page.getByTestId('sidebar-now-count');
  await expect(badge).toHaveAttribute('data-count', String(onScreen));
  await expect(badge).toHaveText(String(onScreen));

  const nowLink = page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Now', exact: true });
  await expect(nowLink).toHaveAccessibleName('Now');
  await expect(nowLink).toHaveAttribute('title', new RegExp(`^${onScreen} things? `));

  // A filter narrows the list and leaves the badge alone.
  await page.getByTestId('quick-filter').click();
  await expect(rows(page)).not.toHaveCount(onScreen);
  await expect(badge).toHaveAttribute('data-count', String(onScreen));

  // And the same number on a page that is not `/now`.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Board', exact: true })
    .click();
  await page.waitForURL(/\/c\/[^/]+\/board$/);
  await expect(page.getByTestId('sidebar-now-count')).toHaveAttribute(
    'data-count',
    String(onScreen),
  );
});
