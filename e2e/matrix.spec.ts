import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/**
 * The content-bucket matrix, walked in a browser.
 *
 * BRIEF.md's sentence about this feature is *"Matrix view where each empty cell
 * is a prompt for a new idea"*, and PLAN.md's M5 line is *"matrix with counts
 * and n/quota (videos with `target_publish_date` in the current month per
 * bucket), empty cell → prefilled capture"*. Five claims, one per thing that
 * could be quietly wrong:
 *
 * 1. **The grid is the channel's own buckets**, both axes, in position order.
 * 2. **A cell's count is the videos at that intersection** — checked against
 *    the database filtered the same way, not against the page's own other half.
 * 3. **An empty cell opens capture with both buckets already set**, and what it
 *    writes really carries them.
 * 4. **A quota counts this month and nothing else** — last month, next month
 *    and no date at all are all excluded, and a bucket with no quota gets no
 *    bar.
 * 5. **A channel with no pillars degrades honestly** rather than drawing an
 *    empty grid.
 *
 * ## Two rules, the same two the rest of this suite follows
 *
 * **The fixture is SQL and the actions are clicks.** Pillars cannot be created
 * from the product yet — the bucket editor is M7 — and getting eleven videos
 * into eleven states through the board would be testing M1. The *state* is
 * written directly, as the owning user; everything the matrix is actually about
 * is done the way a person does it.
 *
 * **Every browser claim that changes a row is paired with a read of that row.**
 * A capture that says it filed an idea under two buckets and a row that carries
 * two bucket ids are different sentences.
 */

const CHANNEL = { name: 'M5 Matrix', slug: 'm5-matrix' };
/** A second channel that never gets pillars: claim 5 is about the first visit. */
const BARE = { name: 'M5 Matrix Bare', slug: 'm5-matrix-bare' };

/** The three pillars the fixture gives the channel, in position order. */
const PILLARS = ['money', 'focus', 'craft'] as const;

/* -------------------------------------------------------------------------- */
/* The month, computed the way the application computes it                     */
/* -------------------------------------------------------------------------- */

/**
 * Four dates around the current month, in UTC.
 *
 * The application decides "this month" from `Date.now()` in UTC
 * (`components/ideas/matrix/tally.ts`), so the fixture has to mean the same
 * month — a date built from the database's `current_date` would be the
 * *server's* timezone, and the two disagree for an hour a day in half the
 * world. Computed rather than hard-coded, because a quota test pinned to
 * September 2026 passes for a month and then rots.
 */
function monthDates() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const iso = (date: Date) => date.toISOString().slice(0, 10);

  const firstOfThis = new Date(Date.UTC(year, month, 1));
  const firstOfNext = new Date(Date.UTC(year, month + 1, 1));
  const lastOfThis = new Date(firstOfNext.getTime() - 86_400_000);
  const lastOfPrevious = new Date(firstOfThis.getTime() - 86_400_000);

  return {
    first: iso(firstOfThis),
    last: iso(lastOfThis),
    previousMonth: iso(lastOfPrevious),
    nextMonth: iso(firstOfNext),
    label: new Intl.DateTimeFormat('en-GB', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(firstOfThis),
  };
}

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

async function channelRow(slug: string): Promise<{ id: string; user_id: string } | null> {
  const result = await db.query<{ id: string; user_id: string }>(
    'select id, user_id from public.channels where slug = $1',
    [slug],
  );
  return result.rows[0] ?? null;
}

async function bucketId(
  channelId: string,
  axis: 'vertical' | 'horizontal',
  name: string,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    'select id from public.buckets where channel_id = $1 and axis = $2 and name = $3',
    [channelId, axis, name],
  );
  if (!result.rows[0]) throw new Error(`no ${axis} bucket "${name}" on that channel`);
  return result.rows[0].id;
}

async function stageIdFor(channelId: string, kind: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    'select id from public.stages where channel_id = $1 and kind = $2',
    [channelId, kind],
  );
  if (!result.rows[0]) throw new Error(`no ${kind} stage on that channel`);
  return result.rows[0].id;
}

interface SeedVideo {
  title: string;
  vertical?: string;
  horizontal?: string;
  /** Stage kind. Defaults to `idea`, which is what a capture produces. */
  kind?: string;
  targetPublishDate?: string;
  /** Live. `published_at` is what "has ever been published" means here. */
  publishedAgo?: string;
  archived?: boolean;
}

async function seedVideos(
  channel: { id: string; user_id: string },
  videos: readonly SeedVideo[],
): Promise<void> {
  for (const video of videos) {
    const stageId = await stageIdFor(channel.id, video.kind ?? 'idea');
    await db.query(
      `insert into public.videos (
         user_id, channel_id, stage_id, title,
         vertical_id, horizontal_id, target_publish_date, published_at, archived_at
       ) values (
         $1, $2, $3, $4,
         case when $5::text is null then null else
           (select id from public.buckets
             where channel_id = $2 and axis = 'vertical' and name = $5) end,
         case when $6::text is null then null else
           (select id from public.buckets
             where channel_id = $2 and axis = 'horizontal' and name = $6) end,
         $7::date,
         case when $8::text is null then null else now() - $8::interval end,
         case when $9::boolean then now() else null end
       )`,
      [
        channel.user_id,
        channel.id,
        stageId,
        video.title,
        video.vertical ?? null,
        video.horizontal ?? null,
        video.targetPublishDate ?? null,
        video.publishedAgo ?? null,
        video.archived ?? false,
      ],
    );
  }
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

async function openMatrix(page: Page, slug: string): Promise<void> {
  await page.goto(`/c/${slug}/ideas?view=matrix`);
}

/**
 * Wait for the route to have hydrated.
 *
 * An empty cell is a real `<a href="/capture?…">` that the browser will follow
 * if it is clicked before React has attached its handler — that is the
 * progressive-enhancement design, and in a test it looks like the modal
 * failing to open. The sidebar's Capture button carries `data-shortcut-ready`
 * once its binding is live, which is the app's own existing signal that the
 * tree has hydrated; the rest of the suite waits on the same attribute.
 */
async function hydrated(page: Page): Promise<void> {
  await expect(
    page.locator('button[aria-keyshortcuts="c"][data-shortcut-ready="true"]'),
  ).toBeVisible();
}

/** The cell at one intersection, by the names on its two axes. */
function cell(page: Page, vertical: string, horizontal: string) {
  return page.locator(
    `[data-testid="matrix-cell"][data-vertical="${vertical}"][data-horizontal="${horizontal}"]`,
  );
}

/* -------------------------------------------------------------------------- */
/* Setup                                                                       */
/* -------------------------------------------------------------------------- */

let channel: { id: string; user_id: string };
const month = monthDates();

test.beforeEach(async ({ page }) => {
  await signIn(page);

  if ((await channelRow(CHANNEL.slug)) === null) await createChannel(page, CHANNEL);
  if ((await channelRow(BARE.slug)) === null) await createChannel(page, BARE);

  const found = await channelRow(CHANNEL.slug);
  if (!found) throw new Error('the fixture channel is missing');
  channel = found;

  // Start from nothing every time: the capture test adds a row, and a count
  // assertion that depended on which tests ran before it would be worthless.
  await db.query('delete from public.videos where channel_id = $1', [channel.id]);
  await db.query(
    "delete from public.buckets where channel_id = $1 and axis = 'vertical'",
    [channel.id],
  );

  /*
    The three pillars. They are written in SQL because the product has no way
    to create one yet — `lib/defaults.ts` seeds the eight formats from BRIEF.md
    and leaves the verticals empty on purpose, and the bucket editor is M7.
    That is exactly the situation claim 5 is about.
  */
  for (const [index, name] of PILLARS.entries()) {
    await db.query(
      `insert into public.buckets (user_id, channel_id, axis, name, position)
       values ($1, $2, 'vertical', $3, $4)`,
      [channel.user_id, channel.id, name, index + 1],
    );
  }

  // Quotas: "2 reviews a month" is the brief's own example. `tutorial` keeps
  // its null quota, so the page has to show one bucket with a bar and one
  // without.
  await db.query(
    `update public.buckets set monthly_quota = 2
      where channel_id = $1 and axis = 'horizontal' and name = 'review'`,
    [channel.id],
  );
  await db.query(
    `update public.buckets set monthly_quota = 3
      where channel_id = $1 and axis = 'vertical' and name = 'money'`,
    [channel.id],
  );

  await seedVideos(channel, [
    // money × tutorial: three, one of them live — the only cell with anything
    // published in it.
    { title: 'Budgeting in a spreadsheet', vertical: 'money', horizontal: 'tutorial' },
    { title: 'Index funds, slowly', vertical: 'money', horizontal: 'tutorial' },
    {
      title: 'The tax return I did on camera',
      vertical: 'money',
      horizontal: 'tutorial',
      kind: 'published',
      publishedAgo: '20 days',
    },
    // money × review: the quota rows. Two land in this month, and the other
    // three are the three ways of not landing in it.
    {
      title: 'This budgeting app, honestly',
      vertical: 'money',
      horizontal: 'review',
      targetPublishDate: month.first,
    },
    {
      title: 'The other budgeting app',
      vertical: 'money',
      horizontal: 'review',
      targetPublishDate: month.last,
    },
    {
      title: 'Last month’s review',
      vertical: 'money',
      horizontal: 'review',
      targetPublishDate: month.previousMonth,
    },
    {
      title: 'Next month’s review',
      vertical: 'money',
      horizontal: 'review',
      targetPublishDate: month.nextMonth,
    },
    { title: 'A review with no date yet', vertical: 'money', horizontal: 'review' },
    // focus × listicle: one, never published.
    { title: 'Five ways to stop checking email', vertical: 'focus', horizontal: 'listicle' },
    // Off the grid: a pillar with no format, and nothing at all.
    { title: 'Something about craft', vertical: 'craft' },
    { title: 'An unfiled thought' },
    // Archived: shelved is not invested. It must not appear in any count.
    {
      title: 'An abandoned money tutorial',
      vertical: 'money',
      horizontal: 'tutorial',
      archived: true,
    },
  ]);
});

/* -------------------------------------------------------------------------- */
/* 1. The grid is this channel's buckets                                       */
/* -------------------------------------------------------------------------- */

test('the grid draws the channel’s own buckets on both axes', async ({ page }) => {
  await openMatrix(page, CHANNEL.slug);

  const grid = page.getByTestId('matrix-grid');
  await expect(grid).toBeVisible();

  // Three pillars down, the eight seeded formats across — the brief's shape.
  await expect(grid).toHaveAttribute('data-verticals', '3');
  await expect(grid).toHaveAttribute('data-horizontals', '8');

  // In position order, which is what the axes mean.
  const rowNames = await page
    .getByTestId('matrix-row')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-bucket')));
  expect(rowNames).toEqual([...PILLARS]);

  const columnNames = await page
    .getByTestId('matrix-column')
    .evaluateAll((columns) => columns.map((column) => column.getAttribute('data-bucket')));
  expect(columnNames).toEqual([
    'tutorial',
    'listicle',
    'review',
    'self-experiment',
    'vlog',
    'reaction',
    'case study',
    'interview',
  ]);

  // Every intersection is drawn, populated or not: 3 × 8.
  await expect(page.getByTestId('matrix-cell')).toHaveCount(24);

  // Reading at a glance, and not by colour: the count is a number, the
  // published mark is a shape with a number on it, and the legend says what
  // both mean.
  await expect(cell(page, 'money', 'tutorial')).toHaveAttribute('data-count', '3');
  await expect(cell(page, 'money', 'tutorial')).toHaveAttribute('data-published', '1');
  await expect(cell(page, 'money', 'tutorial')).toContainText('●1');
  // One video, never published: the mark is absent, which is the signal.
  await expect(cell(page, 'focus', 'listicle')).toHaveAttribute('data-published', '0');
  await expect(cell(page, 'focus', 'listicle')).not.toContainText('●');
  await expect(page.getByTestId('matrix-legend')).toBeVisible();

  // The videos that are in no cell are counted and explained, so the grid's
  // numbers and the bank's do not look like a disagreement.
  await expect(page.getByTestId('matrix-off-grid')).toHaveAttribute('data-count', '2');
});

/* -------------------------------------------------------------------------- */
/* 2. A cell's count is the videos at that intersection                        */
/* -------------------------------------------------------------------------- */

test('a cell’s count is the videos filtered the same way, and it lists them', async ({
  page,
}) => {
  await openMatrix(page, CHANNEL.slug);

  const vertical = await bucketId(channel.id, 'vertical', 'money');
  const horizontal = await bucketId(channel.id, 'horizontal', 'tutorial');

  // What the database says, asked exactly the way the cell claims to ask.
  const rows = await db.query<{ title: string }>(
    `select title from public.videos
      where channel_id = $1 and vertical_id = $2 and horizontal_id = $3
        and archived_at is null
      order by title`,
    [channel.id, vertical, horizontal],
  );
  expect(rows.rowCount).toBe(3);

  const target = cell(page, 'money', 'tutorial');
  await expect(target).toHaveAttribute('data-count', String(rows.rowCount));

  // The cell lists them: PLAN.md's "a populated cell lists or links to them".
  await target.click();

  const panel = page.getByTestId('matrix-cell-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-count', '3');
  await expect(panel.getByTestId('cell-video')).toHaveCount(3);

  const listed = await panel
    .getByTestId('cell-video')
    .evaluateAll((items) => items.map((item) => item.textContent ?? ''));
  for (const row of rows.rows) {
    expect(listed.some((text) => text.includes(row.title))).toBe(true);
  }

  // The archived one is in neither: it is excluded from the count and from the
  // list, by the same rule.
  await expect(panel).not.toContainText('An abandoned money tutorial');
});

/* -------------------------------------------------------------------------- */
/* 3. An empty cell is the prompt                                              */
/* -------------------------------------------------------------------------- */

test('an empty cell opens capture with both buckets already chosen', async ({ page }) => {
  await openMatrix(page, CHANNEL.slug);
  await hydrated(page);

  const empty = cell(page, 'craft', 'interview');
  await expect(empty).toHaveAttribute('data-empty', 'true');
  await expect(empty).toHaveAttribute('data-count', '0');

  // Without JavaScript it is a link to the standalone capture page, carrying
  // the same two ids. That is what makes it work on a phone and in a new tab.
  const vertical = await bucketId(channel.id, 'vertical', 'craft');
  const horizontal = await bucketId(channel.id, 'horizontal', 'interview');
  const href = await empty.getAttribute('href');
  expect(href).toContain(`vertical=${vertical}`);
  expect(href).toContain(`horizontal=${horizontal}`);
  expect(href).toContain(`c=${CHANNEL.slug}`);

  await empty.click();

  const dialog = page.getByTestId('matrix-capture');
  await expect(dialog).toBeVisible();
  // It says where it is filing the idea, rather than filing it silently.
  await expect(dialog.getByTestId('capture-prefill')).toContainText('craft');
  await expect(dialog.getByTestId('capture-prefill')).toContainText('interview');

  const title = 'The interview I keep not asking for';
  await dialog.getByLabel('Idea').fill(title);
  await dialog.getByLabel('Idea').press('Enter');

  // The row really carries both buckets, and it landed in the Idea stage —
  // `capture_video` is the only path a client has to create a video at all.
  await expect(async () => {
    const written = await db.query<{
      vertical_id: string | null;
      horizontal_id: string | null;
      kind: string | null;
    }>(
      `select v.vertical_id, v.horizontal_id, s.kind
         from public.videos v join public.stages s on s.id = v.stage_id
        where v.channel_id = $1 and v.title = $2`,
      [channel.id, title],
    );
    expect(written.rowCount).toBe(1);
    expect(written.rows[0].vertical_id).toBe(vertical);
    expect(written.rows[0].horizontal_id).toBe(horizontal);
    expect(written.rows[0].kind).toBe('idea');
  }).toPass({ timeout: 15_000 });

  // And the hole has closed on the page that sent the capture.
  await expect(cell(page, 'craft', 'interview')).toHaveAttribute('data-count', '1', {
    timeout: 15_000,
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The quota counts this month                                              */
/* -------------------------------------------------------------------------- */

test('quota progress counts only videos targeted at the current month', async ({
  page,
}) => {
  await openMatrix(page, CHANNEL.slug);

  /*
    `review` holds five videos. Two are targeted at this month (its first and
    its last day), one at last month, one at next month, and one has no target
    date at all. A quota of 2 is therefore met, by exactly the two.
  */
  const review = page.locator('[data-testid="matrix-column"][data-bucket="review"]');
  const meter = review.getByTestId('quota-meter');
  await expect(meter).toHaveAttribute('data-count', '2');
  await expect(meter).toHaveAttribute('data-quota', '2');
  await expect(meter).toHaveAttribute('data-met', 'true');
  await expect(meter).toContainText('2 of 2');
  // "Met" is a word, not only a colour.
  await expect(meter).toContainText('met');
  // The bucket total is a different number, and says so: five videos carry it.
  await expect(review.getByTestId('bucket-total')).toHaveText('5');

  // The pillar's quota is not met, and the month says which month it is.
  const money = page.locator('[data-testid="matrix-row"][data-bucket="money"]');
  const moneyMeter = money.getByTestId('quota-meter');
  await expect(moneyMeter).toHaveAttribute('data-count', '2');
  await expect(moneyMeter).toHaveAttribute('data-quota', '3');
  await expect(moneyMeter).toHaveAttribute('data-met', 'false');
  await expect(page.getByTestId('matrix-legend')).toContainText(month.label);

  // A bucket with no quota gets a count and no bar — never an invented target.
  const tutorial = page.locator('[data-testid="matrix-column"][data-bucket="tutorial"]');
  await expect(tutorial.getByTestId('quota-meter')).toHaveCount(0);
  await expect(tutorial.getByTestId('bucket-total')).toHaveText('3');

  /*
    And the count really is the date's doing. Push one of the two out of the
    month and the meter drops to one — same rows, same buckets, one date.
  */
  await db.query(
    `update public.videos set target_publish_date = $2
      where channel_id = $1 and title = 'The other budgeting app'`,
    [channel.id, month.nextMonth],
  );
  await page.reload();
  await expect(
    page
      .locator('[data-testid="matrix-column"][data-bucket="review"]')
      .getByTestId('quota-meter'),
  ).toHaveAttribute('data-count', '1');
});

/* -------------------------------------------------------------------------- */
/* 5. No pillars, no pretending                                                */
/* -------------------------------------------------------------------------- */

test('a channel with no pillars says so instead of drawing an empty grid', async ({
  page,
}) => {
  await openMatrix(page, BARE.slug);

  // No grid at all.
  await expect(page.getByTestId('matrix-grid')).toHaveCount(0);

  const panel = page.getByTestId('matrix-needs-buckets');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-verticals', '0');
  await expect(panel).toHaveAttribute('data-horizontals', '8');
  await expect(panel).toContainText('No topic pillars yet');

  // It names the way to add them, and since M7 the control is the link it
  // used to stand in for: it opens the channel's bucket editor, on the
  // pillars axis, and a keyboard can reach it like any other link.
  const add = page.getByTestId('add-buckets');
  await expect(add).toBeVisible();
  await expect(add).toHaveAttribute('href', `/settings/buckets/${BARE.slug}`);
  // The link says what is missing, as the heading does.
  await expect(add).toHaveText('Name your pillars');
  await expect(add).not.toHaveAttribute('aria-disabled', /.*/);
  await add.focus();
  await expect(add).toBeFocused();
  await expect(page.getByTestId('add-buckets-note')).toContainText('settings');
  await add.click();
  await page.waitForURL(`**/settings/buckets/${BARE.slug}`);
  await expect(page.getByTestId('settings-buckets')).toHaveAttribute('data-channel', BARE.slug);
  await expect(page.getByTestId('bucket-axis-empty')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('matrix-needs-buckets')).toBeVisible();

  // The axis it does have is still shown, and is not called a matrix.
  await expect(page.getByTestId('format-chip')).toHaveCount(8);
  await expect(page.getByTestId('format-strip')).toContainText('tutorial');
});

/* -------------------------------------------------------------------------- */
/* The M5 review's findings                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The blocker, findings 4 and 22: the two bucket ids rode as hidden inputs only
 * while the disclosure was **closed**. Opening it unmounted them and handed the
 * two names to `<select>`s that are `disabled` until `listBuckets` answers —
 * and a disabled control contributes nothing to `FormData`. So an Enter during
 * that window wrote the idea unfiled, silently, with "Filing it under X · Y"
 * still on screen. The form now takes both values from its own state at submit
 * time, which is the same state that sentence is derived from.
 *
 * Shift+Enter is the product's own way of opening the disclosure, and every
 * POST is held long enough that the pickers are provably still loading when the
 * capture is sent.
 */
test('a prefilled capture keeps both buckets even with the pickers still loading', async ({
  page,
}) => {
  await openMatrix(page, CHANNEL.slug);
  await hydrated(page);

  // Hold every write and every server action for a beat, so the window this is
  // about is wide enough to act inside deliberately rather than by luck.
  await page.route(`**/c/${CHANNEL.slug}/ideas**`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.continue();
  });

  const empty = cell(page, 'focus', 'interview');
  await expect(empty).toHaveAttribute('data-empty', 'true');
  await empty.click();

  const dialog = page.getByTestId('matrix-capture');
  await expect(dialog).toBeVisible();

  const title = 'Filed while the pickers were still loading';
  await dialog.getByLabel('Idea').fill(title);
  // Shift+Enter opens the disclosure, which is what mounts the pickers and
  // sends them off to fetch this channel's buckets.
  await dialog.getByLabel('Idea').press('Shift+Enter');

  // Proof that the window is open: the status line says loading and the
  // vertical picker is disabled, so it will post nothing.
  await expect(dialog.getByTestId('capture-buckets-status')).toHaveAttribute(
    'data-status',
    'loading',
  );
  await expect(dialog.getByTestId('capture-vertical')).toBeDisabled();
  // And the form is still claiming, on screen, that it is filing the idea.
  await expect(dialog.getByTestId('capture-prefill')).toContainText('focus');

  await dialog.getByLabel('Idea').press('Enter');

  const vertical = await bucketId(channel.id, 'vertical', 'focus');
  const horizontal = await bucketId(channel.id, 'horizontal', 'interview');

  await expect(async () => {
    const written = await db.query<{
      vertical_id: string | null;
      horizontal_id: string | null;
    }>(
      `select vertical_id, horizontal_id from public.videos
        where channel_id = $1 and title = $2`,
      [channel.id, title],
    );
    expect(written.rowCount).toBe(1);
    expect(written.rows[0].vertical_id).toBe(vertical);
    expect(written.rows[0].horizontal_id).toBe(horizontal);
  }).toPass({ timeout: 20_000 });

  await page.unroute(`**/c/${CHANNEL.slug}/ideas**`);
});

/**
 * Finding 17: after a capture from an empty cell, `router.refresh()` replaces
 * the opener, so `Modal`'s return-focus guard finds a detached node and focus
 * lands on `<body>` exactly when something did happen.
 */
test('capturing into a cell leaves focus on the cell that replaced it', async ({
  page,
}) => {
  await openMatrix(page, CHANNEL.slug);
  await hydrated(page);

  const empty = cell(page, 'craft', 'vlog');
  await expect(empty).toHaveAttribute('data-empty', 'true');
  await empty.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByTestId('matrix-capture');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Idea').fill('Keyboard capture probe');
  await dialog.getByLabel('Idea').press('Enter');

  await expect(dialog).toHaveCount(0);
  // The same intersection, now populated — and holding the reading position.
  const filled = cell(page, 'craft', 'vlog');
  await expect(filled).toHaveAttribute('data-count', '1', { timeout: 20_000 });
  await expect(filled).toBeFocused();
});

/**
 * Finding 16: the panel's `id="cell"` was inert — no href in the product ever
 * carried the fragment — so activating a cell moved neither focus nor the
 * reading position, leaving the revealed content an entire grid away in the tab
 * order. Finding 3: the panel listed every video in the cell with no cap.
 */
test('the drill-down takes the reading position, and caps its list at ten', async ({
  page,
}) => {
  // Twelve at one intersection, so the cap has something to do.
  await seedVideos(
    channel,
    Array.from({ length: 12 }, (_, index) => ({
      title: `Focus tutorial ${index + 1}`,
      vertical: 'focus',
      horizontal: 'tutorial',
    })),
  );

  await openMatrix(page, CHANNEL.slug);
  await hydrated(page);

  const target = cell(page, 'focus', 'tutorial');
  await expect(target).toHaveAttribute('data-count', '12');
  // The fragment is in the href, which is what makes the browser move.
  expect(await target.getAttribute('href')).toContain('#cell');

  await target.focus();
  await page.keyboard.press('Enter');

  const panel = page.getByTestId('matrix-cell-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-count', '12');

  // Ten listed, two counted — the board's Idea column's own convention.
  await expect(panel.getByTestId('cell-video')).toHaveCount(10);
  await expect(panel.getByTestId('cell-overflow')).toHaveAttribute(
    'data-count',
    '2',
  );

  // And the reading position is in the panel rather than back up the grid.
  await expect(panel).toBeFocused();
});
