import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import {
  CHANNEL_DEFAULTS,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
} from '../lib/defaults';
import { apiKey } from '../scripts/dev-stack/jwt';
import {
  API_KEY_EXP,
  API_KEY_IAT,
  GATEWAY_URL,
  PG,
  SEED_EMAIL,
  SEED_PASSWORD,
} from '../scripts/dev-stack/shared';

const ANON_KEY = apiKey('anon', API_KEY_IAT, API_KEY_EXP);

/**
 * M7 — buckets, quotas and the channel's own settings:
 * `/settings/buckets/[slug]` and `/settings/channel/[slug]`.
 *
 * Every claim the task names, driven through the real editors against the
 * real PostgREST + RLS stack, with every browser claim paired with a read of
 * the row it is supposed to have written — and, for the consequence claims,
 * a second screen that has to show the change:
 *
 * 1. A new bucket appears on the matrix immediately.
 * 2. A duplicate name is refused with a readable message, whatever the case
 *    — in the add form before the request, and by the action on a rename.
 * 3. A quota of zero is refused before the database's CHECK is reached.
 * 4. Changing a quota changes the matrix's denominator.
 * 5. Changing the WIP threshold changes the board's warning.
 * 6. The voice guide and the script template round-trip a paragraph with
 *    its newlines intact.
 *
 * And two decisions this slice took without the user, so they are proved
 * rather than described: removing a bucket unfiles the videos under it and
 * changes nothing else about them (the key is `on delete set null`), and a
 * reorder is one statement that leaves the axis renumbered 1..n.
 */

const CHANNEL = { name: 'M7 Channel', slug: 'm7-channel' };

/** The seeded formats, in position order. */
const FORMATS = SEED_BUCKETS.map((bucket) => bucket.name);

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

let db: pg.Client;
let userId: string;
let channelId: string;

test.beforeAll(async () => {
  db = new pg.Client({
    host: PG.host,
    port: PG.port,
    user: PG.user,
    password: PG.password === '' ? undefined : PG.password,
    database: PG.database,
  });
  await db.connect();

  const found = await db.query<{ id: string }>(
    'select id from auth.users where lower(email) = lower($1)',
    [SEED_EMAIL],
  );
  if (found.rows.length === 0) {
    throw new Error(
      `the dev stack has no user ${SEED_EMAIL}; is it the stack this suite started?`,
    );
  }
  userId = found.rows[0].id;
});

test.afterAll(async () => {
  await db?.end();
});

test.beforeEach(async () => {
  // Rebuilt per test: these specs assert exact names, positions and quotas.
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug = $1)`,
    [CHANNEL.slug],
  );
  await db.query('delete from public.channels where slug = $1', [CHANNEL.slug]);
  channelId = await createChannel(CHANNEL.name, CHANNEL.slug);
});

/** Run `fn` as the signed-in user, the way a PostgREST request runs it. */
async function asUser<T>(fn: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({
        sub: userId,
        role: 'authenticated',
        aud: 'authenticated',
        email: SEED_EMAIL,
      }),
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

async function createChannel(name: string, slug: string): Promise<string> {
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
        name,
        slug,
        SCRIPT_TEMPLATE,
        CHANNEL_DEFAULTS.wip_threshold,
        CHANNEL_DEFAULTS.stale_days,
        CHANNEL_DEFAULTS.expected_ctr,
        CHANNEL_DEFAULTS.voice_guide,
        JSON.stringify(stages),
        JSON.stringify(
          SEED_BUCKETS.map((bucket) => ({ ...bucket, monthly_quota: null })),
        ),
      ],
    );
    return result.rows[0].id;
  });
}

interface BucketRow {
  id: string;
  axis: string;
  name: string;
  position: number;
  monthly_quota: number | null;
}

/** One axis of the channel, in position order, straight from the table. */
async function readAxis(axis: 'vertical' | 'horizontal'): Promise<BucketRow[]> {
  const result = await db.query<BucketRow>(
    `select id, axis, name, position, monthly_quota
       from public.buckets
      where channel_id = $1 and axis = $2
      order by position asc, id asc`,
    [channelId, axis],
  );
  return result.rows;
}

/** A pillar, written the way the settings page writes one. */
async function addPillar(name: string, quota: number | null = null): Promise<string> {
  const current = await readAxis('vertical');
  const position = current.length === 0 ? 1 : Math.max(...current.map((b) => b.position)) + 1;
  return asUser(async () => {
    const result = await db.query<{ id: string }>(
      `insert into public.buckets (channel_id, axis, name, position, monthly_quota)
       values ($1, 'vertical', $2, $3, $4) returning id`,
      [channelId, name, position, quota],
    );
    return result.rows[0].id;
  });
}

/** `capture_video` — the only client path to a new video, always into Idea. */
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

/** `move_video` as the client calls it. */
async function move(videoId: string, kind: string): Promise<void> {
  const stageId = await stageIdOf(kind);
  await asUser(async () => {
    await db.query('select move_video($1::uuid, $2::uuid)', [videoId, stageId]);
  });
}

/** File a video under a pillar and a format, with a target date, as the client would. */
async function file(
  videoId: string,
  slots: { vertical?: string | null; horizontal?: string | null; targetDate?: string | null },
): Promise<void> {
  await asUser(async () => {
    await db.query(
      `update public.videos
          set vertical_id = coalesce($2::uuid, vertical_id),
              horizontal_id = coalesce($3::uuid, horizontal_id),
              target_publish_date = coalesce($4::date, target_publish_date)
        where id = $1`,
      [videoId, slots.vertical ?? null, slots.horizontal ?? null, slots.targetDate ?? null],
    );
  });
}

interface VideoSlots {
  id: string;
  vertical_id: string | null;
  horizontal_id: string | null;
  archived_at: string | null;
}

async function readVideo(videoId: string): Promise<VideoSlots | null> {
  const result = await db.query<VideoSlots>(
    'select id, vertical_id, horizontal_id, archived_at::text from public.videos where id = $1',
    [videoId],
  );
  return result.rows[0] ?? null;
}

interface ChannelRow {
  voice_guide: string | null;
  script_template: string;
  wip_threshold: number;
  stale_days: number;
  expected_ctr: string | null;
}

async function readChannel(): Promise<ChannelRow> {
  const result = await db.query<ChannelRow>(
    `select voice_guide, script_template, wip_threshold, stale_days, expected_ctr::text
       from public.channels where id = $1`,
    [channelId],
  );
  return result.rows[0];
}

/** A date in the current month, so it counts towards this month's quota. */
function midMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15))
    .toISOString()
    .slice(0, 10);
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

/**
 * The sidebar's Capture button carries `data-shortcut-ready` once its binding
 * is live — the app's own signal that the tree has hydrated. A fill that
 * lands before that is swallowed by a control with no handler yet.
 */
async function hydrated(page: Page): Promise<void> {
  await expect(
    page.locator('button[aria-keyshortcuts="c"][data-shortcut-ready="true"]'),
  ).toBeVisible();
}

async function openBuckets(page: Page): Promise<void> {
  await page.goto(`/settings/buckets/${CHANNEL.slug}`);
  await expect(page.getByTestId('settings-buckets')).toHaveAttribute('data-channel', CHANNEL.slug);
  await hydrated(page);
}

async function openChannel(page: Page): Promise<void> {
  await page.goto(`/settings/channel/${CHANNEL.slug}`);
  await expect(page.getByTestId('settings-channel')).toHaveAttribute('data-channel', CHANNEL.slug);
  await hydrated(page);
}

async function openMatrix(page: Page): Promise<void> {
  await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix`);
  await hydrated(page);
}

async function openBoard(page: Page): Promise<void> {
  await page.goto(`/c/${CHANNEL.slug}/board`);
  await hydrated(page);
}

const axisEditor = (page: Page, axis: 'vertical' | 'horizontal'): Locator =>
  page.locator(`[data-testid="bucket-axis"][data-axis="${axis}"]`);

const rowByName = (page: Page, name: string): Locator =>
  page.locator(`[data-testid="bucket-row"][data-bucket-name="${name}"]`);

const boardColumn = (page: Page, name: string): Locator =>
  page.getByRole('region', { name, exact: true });

/** Fill an input and commit it the way a person does: Enter. */
async function commit(input: Locator, value: string): Promise<void> {
  await input.fill(value);
  await input.press('Enter');
}

/* -------------------------------------------------------------------------- */
/* 1. A new bucket is on the matrix immediately                                */
/* -------------------------------------------------------------------------- */

test('a new pillar appears on the matrix immediately, and the axis says where it stands against the brief', async ({
  page,
}) => {
  await signIn(page);
  await openBuckets(page);

  // The four settings screens are one row of links, this one current.
  await expect(
    page.locator('[data-testid="settings-nav-link"][data-section="buckets"]'),
  ).toHaveAttribute('aria-current', 'page');

  const pillars = axisEditor(page, 'vertical');
  await expect(pillars).toHaveAttribute('data-count', '0');
  await expect(pillars.getByTestId('bucket-axis-count')).toContainText(
    'No topic pillars yet — most channels do well with 3–5.',
  );
  await expect(pillars.getByTestId('bucket-axis-empty')).toContainText('has no rows');

  // Before: the matrix has no rows and says so.
  await openMatrix(page);
  await expect(page.getByTestId('matrix-needs-buckets')).toHaveAttribute('data-verticals', '0');
  await expect(page.getByTestId('matrix-grid')).toHaveCount(0);

  await openBuckets(page);
  const add = page.getByTestId('add-bucket-vertical');
  await add.getByTestId('add-bucket-name').fill('money');
  await add.getByTestId('add-bucket-submit').click();

  await expect(rowByName(page, 'money')).toBeVisible();
  await expect(rowByName(page, 'money').getByTestId('bucket-filed')).toHaveAttribute('data-count', '0');
  await expect(pillars).toHaveAttribute('data-count', '1');
  await expect(pillars.getByTestId('bucket-axis-count')).toContainText(
    '1 topic pillar — most channels do well with 3–5.',
  );
  // The add form is ready for the next one: cleared and focused.
  await expect(add.getByTestId('add-bucket-name')).toHaveValue('');
  await expect(add.getByTestId('add-bucket-name')).toBeFocused();

  await expect.poll(async () => (await readAxis('vertical')).map((b) => [b.name, b.position])).toEqual([
    ['money', 1],
  ]);

  // The formats stay exactly as seeded — the other axis was not touched.
  expect((await readAxis('horizontal')).map((b) => b.name)).toEqual(FORMATS);

  // After: the matrix has a row, named by the new pillar, crossed with all eight formats.
  await openMatrix(page);
  await expect(page.getByTestId('matrix-grid')).toBeVisible();
  await expect(page.locator('[data-testid="matrix-row"][data-bucket="money"]')).toBeVisible();
  await expect(page.getByTestId('matrix-cell')).toHaveCount(FORMATS.length);

  // Two more, and the axis is within the brief's shape.
  await openBuckets(page);
  for (const name of ['health', 'productivity']) {
    await add.getByTestId('add-bucket-name').fill(name);
    await add.getByTestId('add-bucket-submit').click();
    await expect(rowByName(page, name)).toBeVisible();
  }
  await expect(pillars.getByTestId('bucket-axis-count')).toContainText(
    '3 topic pillars — within the 3–5 most channels do well with.',
  );
  await expect(pillars).toHaveAttribute('data-standing', 'within');
  expect((await readAxis('vertical')).map((b) => [b.name, b.position])).toEqual([
    ['money', 1],
    ['health', 2],
    ['productivity', 3],
  ]);
});

/* -------------------------------------------------------------------------- */
/* 2. A duplicate name is refused, in words, whatever the case                 */
/* -------------------------------------------------------------------------- */

test('a duplicate bucket name is refused with a readable message, in the add form and on a rename, whatever the case', async ({
  page,
}) => {
  await signIn(page);
  await openBuckets(page);

  const add = page.getByTestId('add-bucket-horizontal');
  const status = add.getByTestId('add-bucket-status');

  // Before the request is made: the button is off and the line says why.
  await add.getByTestId('add-bucket-name').fill('review');
  await expect(status).toHaveText(
    'This channel already has a format called “review”. Two with one name would be two matrix headings nobody could tell apart.',
  );
  await expect(status).toHaveAttribute('role', 'alert');
  await expect(add.getByTestId('add-bucket-submit')).toBeDisabled();

  // A different case is the same name to a person, so it is the same refusal.
  await add.getByTestId('add-bucket-name').fill('  Review ');
  await expect(status).toContainText('already has a format called “Review”');
  await expect(add.getByTestId('add-bucket-submit')).toBeDisabled();

  // Nothing reached the table.
  expect((await readAxis('horizontal')).map((b) => b.name)).toEqual(FORMATS);

  // The rename path has no client-side check: the action refuses it, and the
  // row keeps its old name in the table while the box keeps what was typed.
  const vlog = rowByName(page, 'vlog');
  await commit(vlog.getByTestId('bucket-name'), 'Review');
  await expect(vlog.getByTestId('bucket-status')).toContainText(
    'This channel already has a format called “Review”.',
  );
  await expect(vlog.getByTestId('bucket-status')).toHaveAttribute('data-state', 'error');
  expect((await readAxis('horizontal')).map((b) => b.name)).toEqual(FORMATS);

  // A real rename lands, and re-files nothing: the id is what videos carry.
  const before = (await readAxis('horizontal')).find((b) => b.name === 'vlog')!;
  await commit(vlog.getByTestId('bucket-name'), 'video diary');
  await expect(rowByName(page, 'video diary').getByTestId('bucket-status')).toHaveText(/^Saved$/);
  await expect.poll(async () => (await readAxis('horizontal')).find((b) => b.id === before.id)?.name).toBe(
    'video diary',
  );

  // The matrix column carries the new label at once.
  await addPillar('money');
  await openMatrix(page);
  await expect(page.locator('[data-testid="matrix-column"][data-bucket="video diary"]')).toBeVisible();
  await expect(page.locator('[data-testid="matrix-column"][data-bucket="vlog"]')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* 3. Quota zero is refused before the database                                */
/* -------------------------------------------------------------------------- */

test('a quota of zero is refused in words before the database sees it, and an empty box means no quota', async ({
  page,
}) => {
  await signIn(page);
  await openBuckets(page);

  const review = rowByName(page, 'review');
  const quota = review.getByTestId('bucket-quota');
  const status = review.getByTestId('bucket-status');

  await commit(quota, '0');
  await expect(status).toHaveText(
    'A quota of zero is not a quota. Leave the box empty to have no target instead.',
  );
  await expect(status).toHaveAttribute('data-state', 'error');
  await expect(quota).toHaveAttribute('aria-invalid', 'true');
  // What was typed is still in the box — a refusal never reverts the screen.
  await expect(quota).toHaveValue('0');

  await commit(quota, '-3');
  await expect(status).toHaveAttribute('data-state', 'error');
  await commit(quota, '2.5');
  await expect(status).toContainText('whole number');

  // None of that reached the table.
  expect((await readAxis('horizontal')).find((b) => b.name === 'review')?.monthly_quota).toBeNull();

  // A real quota lands.
  await commit(quota, '2');
  await expect(status).toHaveText(/^Saved$/);
  await expect.poll(
    async () => (await readAxis('horizontal')).find((b) => b.name === 'review')?.monthly_quota,
  ).toBe(2);

  // Emptying the box clears it — the only way back to "no quota".
  await commit(quota, '');
  await expect(status).toHaveText(/^Saved$/);
  await expect.poll(
    async () => (await readAxis('horizontal')).find((b) => b.name === 'review')?.monthly_quota,
  ).toBeNull();

  // The add form refuses the same way, before anything is sent.
  const add = page.getByTestId('add-bucket-vertical');
  await add.getByTestId('add-bucket-name').fill('money');
  await add.getByTestId('add-bucket-quota').fill('0');
  await add.getByTestId('add-bucket-submit').click();
  await expect(add.getByTestId('add-bucket-status')).toContainText('A quota of zero is not a quota');
  expect(await readAxis('vertical')).toEqual([]);

  // And with a quota that is one, it is created carrying it.
  await add.getByTestId('add-bucket-quota').fill('3');
  await add.getByTestId('add-bucket-submit').click();
  await expect(rowByName(page, 'money')).toHaveAttribute('data-quota', '3');
  await expect.poll(async () => (await readAxis('vertical')).map((b) => [b.name, b.monthly_quota])).toEqual([
    ['money', 3],
  ]);

  // The database's own CHECK is still there behind all of this.
  await expect(
    asUser(() =>
      db.query("update public.buckets set monthly_quota = 0 where channel_id = $1 and name = 'money'", [
        channelId,
      ]),
    ),
  ).rejects.toMatchObject({ code: '23514' });
});

/* -------------------------------------------------------------------------- */
/* 4. The quota is the matrix's denominator                                    */
/* -------------------------------------------------------------------------- */

test('changing a quota changes the denominator the matrix draws', async ({ page }) => {
  const money = await addPillar('money', 2);
  const tutorial = (await readAxis('horizontal')).find((b) => b.name === 'tutorial')!.id;
  const video = await capture('Budgeting in a spreadsheet');
  await file(video, { vertical: money, horizontal: tutorial, targetDate: midMonth() });

  await signIn(page);
  await openMatrix(page);
  const meter = page.locator('[data-testid="quota-meter"][data-bucket="money"]');
  await expect(meter).toHaveAttribute('data-quota', '2');
  await expect(meter).toHaveAttribute('data-count', '1');
  await expect(meter).toContainText('1 of 2');

  await openBuckets(page);
  const row = rowByName(page, 'money');
  await expect(row.getByTestId('bucket-quota')).toHaveValue('2');
  await expect(row.getByTestId('bucket-filed')).toHaveAttribute('data-count', '1');
  await commit(row.getByTestId('bucket-quota'), '4');
  await expect(row.getByTestId('bucket-status')).toHaveText(/^Saved$/);
  await expect(row).toHaveAttribute('data-quota', '4');

  await openMatrix(page);
  await expect(meter).toHaveAttribute('data-quota', '4');
  await expect(meter).toContainText('1 of 4');

  // One video against a quota of one: met, and the bar says so in a word.
  await openBuckets(page);
  await commit(row.getByTestId('bucket-quota'), '1');
  await expect(row.getByTestId('bucket-status')).toHaveText(/^Saved$/);
  await openMatrix(page);
  await expect(meter).toHaveAttribute('data-met', 'true');
  await expect(meter).toContainText('met');

  // No quota, no bar: the count stays.
  await openBuckets(page);
  await commit(row.getByTestId('bucket-quota'), '');
  await expect(row.getByTestId('bucket-status')).toHaveText(/^Saved$/);
  await openMatrix(page);
  await expect(meter).toHaveCount(0);
  await expect(
    page.locator('[data-testid="matrix-row"][data-bucket="money"]').getByTestId('bucket-total'),
  ).toHaveText('1');
});

/* -------------------------------------------------------------------------- */
/* 5. The WIP threshold is the board's warning                                 */
/* -------------------------------------------------------------------------- */

test('changing the WIP threshold changes the warning on the board, and the other two numbers save with their own refusals', async ({
  page,
}) => {
  for (const title of ['One', 'Two', 'Three']) {
    await move(await capture(title), 'packaging');
  }

  await signIn(page);
  await openBoard(page);
  const packaging = boardColumn(page, 'Packaging (TTH)');
  await expect(packaging.getByTestId('column-count')).toContainText('3');
  await expect(packaging).toHaveAttribute('data-wip-warning', 'false');

  await openChannel(page);
  await expect(
    page.locator('[data-testid="settings-nav-link"][data-section="channel"]'),
  ).toHaveAttribute('aria-current', 'page');
  const wip = page.getByTestId('wip-threshold');
  await expect(wip).toHaveValue(String(CHANNEL_DEFAULTS.wip_threshold));

  // Zero is refused in words; the box keeps what was typed, is marked
  // invalid, and points at the sentence so it can be re-read on return.
  await commit(wip, '0');
  await expect(page.getByTestId('wip-threshold-status')).toContainText('One is the lowest');
  await expect(page.getByTestId('wip-threshold-status')).toHaveAttribute('data-state', 'error');
  await expect(wip).toHaveAttribute('aria-invalid', 'true');
  expect(await wip.getAttribute('aria-describedby')).toContain(
    await page.getByTestId('wip-threshold-status').getAttribute('id'),
  );
  expect((await readChannel()).wip_threshold).toBe(CHANNEL_DEFAULTS.wip_threshold);

  await commit(wip, '2');
  await expect(page.getByTestId('wip-threshold-status')).toHaveText(/^Saved$/);
  await expect(wip).not.toHaveAttribute('aria-invalid', /.*/);
  await expect.poll(async () => (await readChannel()).wip_threshold).toBe(2);

  await openBoard(page);
  await expect(packaging).toHaveAttribute('data-wip-warning', 'true');
  await expect(packaging.getByTestId('wip-warning')).toContainText('3 in progress, threshold 2');
  // Idea never warns, whatever the threshold.
  await expect(boardColumn(page, 'Idea')).toHaveAttribute('data-wip-warning', 'false');

  // Stale days and expected CTR: the same save, the same shape of refusal.
  await openChannel(page);
  await commit(page.getByTestId('stale-days'), '0');
  await expect(page.getByTestId('stale-days-status')).toHaveAttribute('data-state', 'error');
  await commit(page.getByTestId('stale-days'), '10');
  await expect(page.getByTestId('stale-days-status')).toHaveText(/^Saved$/);
  await expect.poll(async () => (await readChannel()).stale_days).toBe(10);

  const ctr = page.getByTestId('expected-ctr');
  await expect(ctr).toHaveValue('');
  await commit(ctr, '0');
  await expect(page.getByTestId('expected-ctr-status')).toContainText('never be missed');
  await commit(ctr, '4.5');
  await expect(page.getByTestId('expected-ctr-status')).toHaveText(/^Saved$/);
  await expect.poll(async () => (await readChannel()).expected_ctr).toBe('4.50');
  await commit(ctr, '');
  await expect(page.getByTestId('expected-ctr-status')).toHaveText(/^Saved$/);
  await expect.poll(async () => (await readChannel()).expected_ctr).toBeNull();

  // A reload shows what the row holds.
  await openChannel(page);
  await expect(page.getByTestId('wip-threshold')).toHaveValue('2');
  await expect(page.getByTestId('stale-days')).toHaveValue('10');
  await expect(page.getByTestId('expected-ctr')).toHaveValue('');
});

/* -------------------------------------------------------------------------- */
/* 6. The two texts round-trip                                                 */
/* -------------------------------------------------------------------------- */

test('the voice guide and the script template round-trip a paragraph with its newlines intact', async ({
  page,
}) => {
  const guide = [
    'Direct and a little dry. Second person, present tense.',
    '',
    'Never:',
    '  - "in this video"',
    '  - "welcome back"',
    '',
    'Reach for the concrete number over the adjective.',
  ].join('\n');

  const template = [
    '## Cold open',
    '',
    '{{hook}}',
    '',
    '## The three things',
    '',
    '1.',
    '2.',
    '3.',
    '',
    '## Send them somewhere',
  ].join('\n');

  await signIn(page);
  await openChannel(page);

  const voice = page.getByTestId('voice-guide');
  await expect(voice).toHaveValue('');
  await expect(page.getByTestId('voice-guide-status')).toContainText('Empty.');
  await voice.fill(guide);
  await voice.blur();
  await expect(page.getByTestId('voice-guide-status')).toHaveText(/^Saved$/);
  await expect.poll(async () => (await readChannel()).voice_guide).toBe(guide);

  const script = page.getByTestId('script-template');
  // As seeded, trailing newline included: the box shows what the row holds.
  await expect(script).toHaveValue(SCRIPT_TEMPLATE);
  await expect(page.getByTestId('script-template-no-hook')).toHaveCount(0);

  // Without the placeholder the page warns, and still saves: the template is
  // the user's own shape.
  await script.fill('## Body only\n\n-\n-');
  await expect(page.getByTestId('script-template-no-hook')).toContainText('no {{hook}}');
  await script.blur();
  await expect(page.getByTestId('script-template-status')).toHaveText(/^Saved$/);
  await expect.poll(async () => (await readChannel()).script_template).toBe('## Body only\n\n-\n-');

  await script.fill(template);
  await expect(page.getByTestId('script-template-no-hook')).toHaveCount(0);
  await script.blur();
  await expect(page.getByTestId('script-template-status')).toHaveText(/^Saved$/);
  await expect.poll(async () => (await readChannel()).script_template).toBe(template);

  // Blank is refused: `not null`, and a blank template writes blank scripts.
  await script.fill('   \n ');
  await script.blur();
  await expect(page.getByTestId('script-template-status')).toContainText('cannot be empty');
  expect((await readChannel()).script_template).toBe(template);

  // Reload: both boxes hold exactly what was typed, newlines and indentation.
  await openChannel(page);
  await expect(page.getByTestId('voice-guide')).toHaveValue(guide);
  await expect(page.getByTestId('script-template')).toHaveValue(template);

  // And the template is what a video's script is made from, hook spliced in.
  const video = await capture('Round trip');
  await asUser(() =>
    db.query(
      `update public.videos
          set title = 'Round trip', thumbnail_concept = 'a coin',
              hooks = '[{"id":"h1","text":"You are losing money every month.","chosen":true}]'::jsonb
        where id = $1`,
      [video],
    ),
  );
  await move(video, 'packaging');
  await move(video, 'scripting');
  const scripted = await db.query<{ script: string }>('select script from public.videos where id = $1', [
    video,
  ]);
  expect(scripted.rows[0].script).toBe(template.replace('{{hook}}', 'You are losing money every month.'));
});

/* -------------------------------------------------------------------------- */
/* Two decisions, proved: removal unfiles, and reorder is one statement        */
/* -------------------------------------------------------------------------- */

test('removing a bucket unfiles the videos under it and changes nothing else; reordering renumbers the axis in one statement', async ({
  page,
}) => {
  const money = await addPillar('money');
  const health = await addPillar('health');
  const tutorial = (await readAxis('horizontal')).find((b) => b.name === 'tutorial')!.id;
  const first = await capture('Budgeting');
  const second = await capture('Index funds');
  const other = await capture('Sleep');
  await file(first, { vertical: money, horizontal: tutorial });
  await file(second, { vertical: money });
  await file(other, { vertical: health, horizontal: tutorial });
  // An archived video under the pillar too: not on the row's count (that is
  // the matrix's number), but unfiled by the key all the same, so the note
  // afterwards has to name it apart rather than fold it into a number that
  // disagrees with the sentence before the click (M7's review).
  const archived = await capture('Budgeting, the first attempt');
  await file(archived, { vertical: money });
  await db.query('update public.videos set archived_at = now() where id = $1', [archived]);

  await signIn(page);
  await openBuckets(page);

  const row = rowByName(page, 'money');
  await expect(row.getByTestId('bucket-filed')).toHaveAttribute('data-count', '2');
  await expect(row.getByTestId('bucket-filed')).toHaveText('2 videos');
  // The row's controls carry its name: eight "a month" boxes and eight
  // "Remove" buttons are eight of nothing to a screen reader.
  await expect(row.getByRole('spinbutton', { name: 'Monthly quota for money, a month' })).toBeVisible();
  const remove = row.getByRole('button', { name: 'Remove money' });

  // The sentence before the click says what the click does, with the count.
  await remove.click();
  await expect(row.getByTestId('bucket-remove-confirm')).toContainText(
    '2 videos are filed under “money”. Removing it leaves them with no topic pillar — nothing else about them changes',
  );
  // The question took focus as it appeared...
  await expect(row.getByTestId('bucket-remove-yes')).toBeFocused();
  // ...and keeping it is a real option, which hands focus back to Remove.
  await row.getByTestId('bucket-remove-keep').click();
  await expect(row.getByTestId('bucket-remove-confirm')).toHaveCount(0);
  await expect(row.getByTestId('bucket-remove')).toBeFocused();
  expect((await readAxis('vertical')).map((b) => b.name)).toEqual(['money', 'health']);

  await row.getByTestId('bucket-remove').click();
  await row.getByTestId('bucket-remove-yes').click();
  await expect(rowByName(page, 'money')).toHaveCount(0);
  await expect(page.getByTestId('bucket-removed-note')).toContainText(
    'Removed “money” and unfiled 2 videos and one archived video',
  );
  // The row went with its button; focus moved to the row that follows it.
  await expect(rowByName(page, 'health').getByTestId('bucket-name')).toBeFocused();

  // The videos are all still there; the three lose the pillar and keep the format.
  expect((await readAxis('vertical')).map((b) => b.name)).toEqual(['health']);
  expect(await readVideo(first)).toMatchObject({ vertical_id: null, horizontal_id: tutorial, archived_at: null });
  expect(await readVideo(second)).toMatchObject({ vertical_id: null, horizontal_id: null });
  expect(await readVideo(archived)).toMatchObject({ vertical_id: null });
  expect(await readVideo(other)).toMatchObject({ vertical_id: health, horizontal_id: tutorial });

  // Reorder: `review` up one, and the whole axis is renumbered 1..n.
  const review = rowByName(page, 'review');
  await review.getByTestId('bucket-move-up').click();
  await expect(rowByName(page, 'review')).toHaveAttribute('data-position', '2');
  await expect.poll(async () => (await readAxis('horizontal')).map((b) => b.name)).toEqual([
    'tutorial',
    'review',
    'listicle',
    'self-experiment',
    'vlog',
    'reaction',
    'case study',
    'interview',
  ]);
  expect((await readAxis('horizontal')).map((b) => b.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

  // Focus followed the row to the arrow that is still offered.
  await expect(rowByName(page, 'review').getByTestId('bucket-move-up')).toBeFocused();

  // The first row's "up" and the last row's "down" are disabled, not hidden.
  await expect(rowByName(page, 'tutorial').getByTestId('bucket-move-up')).toBeDisabled();
  await expect(rowByName(page, 'interview').getByTestId('bucket-move-down')).toBeDisabled();

  // The matrix draws the columns in the new order.
  await openMatrix(page);
  const columns = await page
    .getByTestId('matrix-column')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-bucket')));
  expect(columns.slice(0, 3)).toEqual(['tutorial', 'review', 'listicle']);

  // The same swap as two client writes is refused halfway — the reason the
  // action writes the axis as one statement.
  await expect(
    asUser(async () => {
      await db.query(
        "update public.buckets set position = 1 where channel_id = $1 and axis = 'horizontal' and name = 'review'",
        [channelId],
      );
      // The deferred unique is checked at commit; force it now, as a second
      // request's commit would.
      await db.query('set constraints all immediate');
    }),
  ).rejects.toMatchObject({ code: '23505' });
  expect((await readAxis('horizontal')).map((b) => b.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

/* -------------------------------------------------------------------------- */
/* Typed text survives leaving the page                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every field here saves on blur, and two ways of leaving do not blur: the
 * browser's Back button (a client-side popstate that unmounts the field) and
 * a reload. M7's review typed a page of voice guide and pressed Back; it was
 * gone with no warning. The one save queue now commits on unmount and asks
 * before an unload.
 */
test('text typed into the voice guide survives the browser’s Back button, and a reload asks first', async ({
  page,
}) => {
  await signIn(page);
  // Arrive by an in-app link, so Back is a client-side navigation — the
  // case that unmounts the field with the text still in it.
  await page.goto(`/settings/stages/${CHANNEL.slug}`);
  await hydrated(page);
  await page.locator('[data-testid="settings-nav-link"][data-section="channel"]').click();
  await page.waitForURL(`**/settings/channel/${CHANNEL.slug}`);
  await hydrated(page);

  const voice = page.getByTestId('voice-guide');
  await voice.fill('Draft typed, then Back — never blurred.');
  await page.goBack();
  await page.waitForURL(`**/settings/stages/${CHANNEL.slug}`);
  await expect
    .poll(async () => (await readChannel()).voice_guide)
    .toBe('Draft typed, then Back — never blurred.');

  // A reload with text in the box: the browser asks. The dialog is the
  // browser's own, accepted here so the test can go on; what is asserted is
  // that it was raised at all, and only while something was unsaved.
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.accept();
  });
  await openChannel(page);
  await expect(page.getByTestId('voice-guide')).toHaveValue('Draft typed, then Back — never blurred.');
  await page.reload();
  await hydrated(page);
  expect(dialogs).toEqual([]);

  await page.getByTestId('voice-guide').fill('Draft typed, then reload.');
  await page.reload();
  await hydrated(page);
  expect(dialogs).toEqual(['beforeunload']);
});

/* -------------------------------------------------------------------------- */
/* The channel row's grant is the five settings columns and nothing else      */
/* -------------------------------------------------------------------------- */

/**
 * With a real session token against PostgREST: the columns the screen edits
 * write; `slug` and `name` — editable nowhere in the app, and a blank slug
 * leaves the channel unreachable at `/c//board` — are not the client's to
 * write at all; and the numbers the screen bounds are bounded by the
 * database too (0008_settings_boundary.sql).
 */
test('a forged PATCH cannot blank the channel’s slug or name, nor zero its thresholds', async ({
  page,
}) => {
  await signIn(page);
  await openChannel(page);

  const result = await page.evaluate(
    async ({ gateway, anon, email, password, channelId }) => {
      const session = await fetch(`${gateway}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: anon, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const { access_token: token } = (await session.json()) as { access_token?: string };
      const headers = {
        apikey: anon,
        Authorization: `Bearer ${token ?? ''}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      };
      async function patch(body: unknown) {
        const response = await fetch(`${gateway}/rest/v1/channels?id=eq.${channelId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.text() };
      }
      return {
        control: await patch({ stale_days: 9 }),
        slug: await patch({ slug: '' }),
        name: await patch({ name: '' }),
        wip: await patch({ wip_threshold: 0 }),
        stale: await patch({ stale_days: -1 }),
        ctr: await patch({ expected_ctr: 0 }),
        script: await patch({ script_template: '' }),
        ghost: await patch({ script_template: '\u200b' }),
      };
    },
    { gateway: GATEWAY_URL, anon: ANON_KEY, email: SEED_EMAIL, password: SEED_PASSWORD, channelId },
  );

  // The session is good: a settings column writes.
  expect(result.control.status).toBe(200);
  await expect.poll(async () => (await readChannel()).stale_days).toBe(9);
  // The address and the name are not the client's.
  expect(result.slug.status).toBe(403);
  expect(result.slug.body).toContain('42501');
  expect(result.name.status).toBe(403);
  // The floors are the database's: 23514, not a quiet 200.
  for (const refused of [result.wip, result.stale, result.ctr, result.script, result.ghost]) {
    expect(refused.status).toBe(400);
    expect(refused.body).toContain('23514');
  }
  const after = await readChannel();
  expect(after.wip_threshold).toBe(CHANNEL_DEFAULTS.wip_threshold);
  expect(after.stale_days).toBe(9);
  expect(after.expected_ctr).toBeNull();
  expect(after.script_template).toBe(SCRIPT_TEMPLATE);
});
