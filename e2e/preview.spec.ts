import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import {
  CHANNEL_DEFAULTS,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
} from '../lib/defaults';
import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/**
 * M3 — the section navigation and the YouTube preview.
 *
 * Two claims, driven through the real application against the real stack:
 *
 * 1. **The preview tells the truth about the title.** It redraws as the title
 *    is typed — before anything is saved — and when a title runs past the
 *    feed's two-line clamp it is drawn cut, at the measured point, and the
 *    packaging section says how many characters went.
 * 2. **The sections cost nothing.** A `?section=` URL opens where it says,
 *    clicking a tab changes the address bar, and neither loses what is in a
 *    field that has not been committed.
 *
 * The second one is the reason the sections are hidden rather than unmounted,
 * so it is asserted against the state that would actually be destroyed by a
 * remount: the "add a candidate" box, which is committed by its own button and
 * by nothing else — not by a blur, and not by changing tabs.
 */

const CHANNEL = { name: 'M3 Preview', slug: 'm3-preview' };

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
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug = $1)`,
    [CHANNEL.slug],
  );
  await db.query('delete from public.channels where slug = $1', [CHANNEL.slug]);
  channelId = await createChannel(CHANNEL.name, CHANNEL.slug);
});

/** Everything a fixture writes goes through RLS and the column grants. */
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

async function capture(title: string): Promise<string> {
  return asUser(async () => {
    const result = await db.query<{ id: string }>(
      'select id from capture_video($1::uuid, $2::text)',
      [channelId, title],
    );
    return result.rows[0].id;
  });
}

async function readRow(videoId: string): Promise<{
  title: string;
  title_candidates: unknown[];
}> {
  const result = await db.query<{ title: string; title_candidates: unknown[] }>(
    'select title, title_candidates from public.videos where id = $1',
    [videoId],
  );
  return result.rows[0];
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/c\/[^/]+\/board$/);
}

/* -------------------------------------------------------------------------- */
/* Titles                                                                      */
/* -------------------------------------------------------------------------- */

/** Comfortably inside two lines on every surface. */
const SHORT_TITLE = 'I rebuilt my studio in a cupboard';

/**
 * Long enough to run past the feed's two-line clamp (a ~288px column at 16px)
 * and still sit inside the search row's (a 600px column at 18px). The gap
 * between those two is roughly sixty characters wide, so this is not a
 * knife-edge measurement.
 */
const FEED_CUT_TITLE =
  'I rebuilt my entire studio inside a kitchen cupboard for under two hundred pounds and it actually worked';

/* -------------------------------------------------------------------------- */
/* 1. The preview follows what is being typed                                  */
/* -------------------------------------------------------------------------- */

test('typing a title redraws all three renderings before anything is saved', async ({
  page,
}) => {
  const videoId = await capture('Captured title');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  const preview = page.getByTestId('youtube-preview');
  await expect(preview).toBeVisible();

  // What the server drew: the saved title, in all three.
  for (const testId of [
    'preview-title-feed',
    'preview-title-search',
    'preview-title-phone',
  ]) {
    await expect(page.getByTestId(testId)).toHaveText('Captured title');
  }

  // Typed, not blurred, not saved.
  const title = page.getByTestId('working-title');
  await title.click();
  await title.fill(SHORT_TITLE);

  for (const testId of [
    'preview-title-feed',
    'preview-title-search',
    'preview-title-phone',
  ]) {
    await expect(page.getByTestId(testId)).toHaveText(SHORT_TITLE);
  }

  // The row is untouched: the preview is drawing the draft, not a round trip.
  expect((await readRow(videoId)).title).toBe('Captured title');

  // The phone rendering is the video between two sample tiles — that is what
  // makes it a comparison rather than a picture.
  await expect(
    page.getByTestId('preview-phone').locator('[data-sample="true"]'),
  ).toHaveCount(2);
});

/* -------------------------------------------------------------------------- */
/* 2. The clamp, drawn and counted                                             */
/* -------------------------------------------------------------------------- */

test('a title past the feed clamp is drawn cut, and the warning names how much', async ({
  page,
}) => {
  const videoId = await capture('Clamp walk');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  const feed = page.getByTestId('preview-title-feed');
  const search = page.getByTestId('preview-title-search');
  const warning = page.getByTestId('truncation-warning');

  // A short title: nothing is cut anywhere, and the warning says so quietly.
  await page.getByTestId('working-title').fill(SHORT_TITLE);
  await expect(feed).toHaveAttribute('data-truncated', 'false');
  await expect(warning).toHaveAttribute('data-state', 'clear');

  // A long one: the feed cuts it.
  await page.getByTestId('working-title').fill(FEED_CUT_TITLE);
  await expect(feed).toHaveAttribute('data-truncated', 'true');
  await expect(feed).toHaveText(/…$/);

  // And the same title survives the search row, which is the point of drawing
  // both: the feed is the surface that bites first.
  await expect(search).toHaveAttribute('data-truncated', 'false');
  await expect(search).toHaveText(FEED_CUT_TITLE);

  // The warning names the count, and the count is the one the preview drew.
  await expect(warning).toHaveAttribute('data-state', 'cut');
  await expect(page.getByTestId('truncation-summary')).toHaveText(
    /would cut 1 of 1 title/,
  );

  const row = page.getByTestId('truncation-row');
  await expect(row).toHaveCount(1);

  const cutFromWarning = Number(await row.getAttribute('data-cut'));
  const cutFromPreview = Number(await feed.getAttribute('data-cut'));
  expect(cutFromWarning).toBe(cutFromPreview);
  expect(cutFromWarning).toBeGreaterThan(0);

  // The drawn title plus what was cut is the whole title — the ellipsis is
  // where the measurement says it is, not where a character count guessed.
  const drawn = (await feed.textContent()) ?? '';
  const visible = drawn.replace(/…$/, '');
  expect(FEED_CUT_TITLE.startsWith(visible)).toBe(true);
  expect(FEED_CUT_TITLE.length - visible.length).toBe(cutFromWarning);
});

test('a candidate the feed would cut is named even when the working title fits', async ({
  page,
}) => {
  const videoId = await capture('Candidate clamp');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  await page.getByTestId('working-title').fill(SHORT_TITLE);
  await expect(page.getByTestId('truncation-warning')).toHaveAttribute(
    'data-state',
    'clear',
  );

  await page.getByTestId('candidate-input').fill(FEED_CUT_TITLE);
  await page.getByTestId('candidate-add').click();

  await expect(page.getByTestId('truncation-summary')).toHaveText(
    /would cut 1 of 2 titles/,
  );
  await expect(page.getByTestId('truncation-row')).toContainText('Candidate 1');
});

/* -------------------------------------------------------------------------- */
/* 3. The sections                                                             */
/* -------------------------------------------------------------------------- */

test('a section is a URL: pasted, clicked and gone back to', async ({ page }) => {
  const videoId = await capture('Section routing');
  await signIn(page);

  // Pasted.
  await page.goto(`/videos/${videoId}?section=script`);
  await expect(page.getByTestId('section-panel-script')).toBeVisible();
  await expect(page.getByTestId('section-panel-packaging')).toBeHidden();
  await expect(page.getByTestId('section-tab-script')).toHaveAttribute(
    'aria-current',
    'page',
  );
  // Nothing in it yet, and it says why rather than pretending to be an editor.
  await expect(page.getByTestId('script-empty')).toContainText('into Scripting');

  // Clicked.
  await page.getByTestId('section-tab-schedule').click();
  await expect(page).toHaveURL(new RegExp(`/videos/${videoId}\\?section=schedule$`));
  await expect(page.getByTestId('section-panel-schedule')).toBeVisible();
  await expect(page.getByTestId('section-panel-script')).toBeHidden();

  // Back: the sections are history entries, not a mode switch.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/videos/${videoId}\\?section=script$`));
  await expect(page.getByTestId('section-panel-script')).toBeVisible();

  // The default section is the bare URL, so there are not two links to it.
  await page.getByTestId('section-tab-packaging').click();
  await expect(page).toHaveURL(new RegExp(`/videos/${videoId}$`));
  await expect(page.getByTestId('section-panel-packaging')).toBeVisible();

  // An unknown section is the default, not a 404.
  await page.goto(`/videos/${videoId}?section=nonsense`);
  await expect(page.getByTestId('section-panel-packaging')).toBeVisible();

  // Every tab says what it is holding. A fresh capture has a title and nothing
  // else, so packaging is one of the gate's three fields.
  // `toContainText`, not `toHaveText`: the mark carries screen-reader text
  // around the digits ("…, 1/3 done"), which is the point of it.
  await expect(
    page.getByTestId('section-tab-packaging').getByTestId('section-mark'),
  ).toContainText('1/3');
  await expect(
    page.getByTestId('section-tab-thumbnails').getByTestId('section-mark'),
  ).toHaveAttribute('data-mark', 'locked');
});

test('switching sections keeps edits that have not been committed', async ({
  page,
}) => {
  const videoId = await capture('Unsaved edits');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  const pending = 'A candidate I have not added yet';

  await page.getByTestId('working-title').fill(SHORT_TITLE);
  // Typed into the "add a candidate" box and deliberately not added: this is
  // state that lives only in the browser, and a remount would take it.
  await page.getByTestId('candidate-input').fill(pending);

  await page.getByTestId('section-tab-schedule').click();
  await expect(page.getByTestId('section-panel-schedule')).toBeVisible();
  await page.getByTestId('section-tab-packaging').click();

  await expect(page.getByTestId('candidate-input')).toHaveValue(pending);
  await expect(page.getByTestId('working-title')).toHaveValue(SHORT_TITLE);
  // The preview came back with it, too.
  await expect(page.getByTestId('preview-title-feed')).toHaveText(SHORT_TITLE);

  // And it really was uncommitted: no candidate was written.
  expect((await readRow(videoId)).title_candidates).toEqual([]);
  await expect(page.getByTestId('candidate-list')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* 4. The assists, inert                                                       */
/* -------------------------------------------------------------------------- */

test('the assist controls are present, disabled, and say when they arrive', async ({
  page,
}) => {
  const videoId = await capture('Assists');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  const pills = page.getByTestId('assist-pill');
  await expect(pills).toHaveCount(3);

  for (const verb of ['Generate 20', 'Suggest concepts', 'Draft a third']) {
    const pill = page.locator(`[data-assist="${verb}"]`);
    await expect(pill).toBeVisible();
    await expect(pill).toBeDisabled();
    await expect(pill).toHaveAttribute('title', /Arrives in M8\.$/);
    // The milestone is drawn on the control as well as hidden in its tooltip:
    // a disabled button cannot be focused, so the tooltip alone reaches nobody
    // using a keyboard.
    await expect(pill).toContainText('M8');
  }
});
