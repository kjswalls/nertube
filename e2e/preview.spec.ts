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

/* -------------------------------------------------------------------------- */
/* 7. The face is Roboto, and the measurement can tell                         */
/* -------------------------------------------------------------------------- */

/**
 * The fidelity claim that the rest of the preview rests on.
 *
 * Until M3's integration this measured in whatever the machine fell back to —
 * Liberation Sans here — and the clamp it drew was therefore Liberation Sans's
 * clamp with Roboto's numbers on it. Three things are asserted, and the third is
 * the one that makes the first two mean something:
 *
 * 1. The drawn title's own computed family starts with Roboto.
 * 2. That face is *loaded*, not merely asked for — `document.fonts.check`, so a
 *    `display: swap` window that never closed would fail here.
 * 3. A control against a family that does not exist. A name the browser cannot
 *    resolve falls back to the default sans — which is precisely what "Roboto"
 *    itself did before this face was loaded, so if it were still falling back
 *    the two measurements would be *identical*. They are not, and the assertion
 *    is exact rather than approximate: Roboto and Arial happen to be within a
 *    pixel of each other on a short string, which is exactly why a threshold
 *    would have been the wrong test.
 */
test('titles are drawn and measured in Roboto, not in a fallback', async ({
  page,
}) => {
  const videoId = await capture('Roboto check');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  const feed = page.getByTestId('preview-title-feed');
  await expect(feed).toBeVisible();
  // The measurement has run: `data-cut` only exists once a clamp came back.
  await expect(feed).toHaveAttribute('data-cut', /\d+/);

  const evidence = await page.evaluate(() => {
    const element = document.querySelector('[data-testid="preview-title-feed"]');
    if (!element) throw new Error('no feed title');
    const family = getComputedStyle(element).fontFamily;

    // The first family in the resolved list, unquoted — what `next/font`
    // published on `--font-face-youtube`.
    const first = (family.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');

    const context = document.createElement('canvas').getContext('2d');
    if (!context) throw new Error('no 2d context');
    // Long enough that a per-glyph difference accumulates past any rounding.
    const sample =
      'Wide wondering willows, mmmm iiii WWWW jjjj — I rebuilt my entire ' +
      'studio inside a kitchen cupboard for under two hundred pounds';

    context.font = `500 16px "${first}"`;
    const inRoboto = context.measureText(sample).width;
    // A family no machine has. The browser falls back to its default sans —
    // which is what `"Roboto"` resolved to before this face was loaded.
    context.font = '500 16px "NerTubeNoSuchFace"';
    const inFallback = context.measureText(sample).width;

    return {
      family,
      first,
      loaded: document.fonts.check(`500 16px "${first}"`),
      inRoboto,
      inFallback,
    };
  });

  expect(evidence.first).toMatch(/^Roboto/);
  expect(evidence.family).toMatch(/^Roboto/);
  expect(
    evidence.loaded,
    `${evidence.first} should be loaded, not still swapping`,
  ).toBe(true);
  expect(
    evidence.inRoboto,
    `"${evidence.first}" laid the sample out at ${evidence.inRoboto}px and an ` +
      `unresolvable family at ${evidence.inFallback}px. Equal widths would mean ` +
      'the browser is falling back for both, and this test would be proving nothing',
  ).not.toBe(evidence.inFallback);
});

/* -------------------------------------------------------------------------- */
/* 8. The right rail                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Where the preview lives, at both widths that matter.
 *
 * Wide, it is a right rail beside the packaging block, so the clamp moves while
 * the title is typed rather than a scroll away. Narrow, there is no room for a
 * 452px rail next to a readable measure — and shrinking YouTube's own pixel
 * sizes to fit would answer "does this read?" wrongly — so it stacks under the
 * block at full size, exactly where it was before the rail existed.
 *
 * Either way the page itself must not scroll sideways. The search row is 976px
 * and scrolls inside its own frame; that is the frame's business and not the
 * page's.
 */
test('the preview is a right rail when there is room, and stacks when there is not', async ({
  page,
}) => {
  const videoId = await capture('Rail walk');
  await signIn(page);

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/videos/${videoId}`);

  const rail = page.getByTestId('video-rail');
  const block = page.getByTestId('packaging-block');
  const preview = page.getByTestId('youtube-preview');

  await expect(rail).toHaveAttribute('data-filled', 'true');
  await expect(preview).toBeVisible();

  const wideRail = (await rail.boundingBox())!;
  const wideBlock = (await block.boundingBox())!;

  // Beside, not below: the rail starts to the right of where the block ends.
  expect(wideRail.x).toBeGreaterThanOrEqual(wideBlock.x + wideBlock.width);
  // Within the design's range for a rail.
  expect(wideRail.width).toBeLessThanOrEqual(452);
  expect(wideRail.width).toBeGreaterThanOrEqual(276);

  // The page does not scroll sideways, however wide the search frame is.
  const overflows = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
  expect(await overflows()).toBe(false);

  // A section with no rail empties it and leaves the tabs where they were.
  const tabs = page.getByRole('navigation', { name: 'Video sections' });
  const tabsBefore = (await tabs.boundingBox())!;
  await page.getByTestId('section-tab-script').click();
  await expect(rail).toHaveAttribute('data-filled', 'false');
  const tabsAfter = (await tabs.boundingBox())!;
  expect(tabsAfter.y).toBe(tabsBefore.y);
  expect(tabsAfter.width).toBe(tabsBefore.width);

  // Narrow: the rail's content is not dropped, it goes underneath — and it is
  // still drawn at full size rather than squeezed.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`/videos/${videoId}`);
  await expect(preview).toBeVisible();

  const narrowRail = (await page.getByTestId('video-rail').boundingBox())!;
  const narrowBlock = (await block.boundingBox())!;
  expect(narrowRail.y).toBeGreaterThan(narrowBlock.y);
  expect(narrowRail.x).toBeLessThan(narrowBlock.x + narrowBlock.width);
  expect(await overflows()).toBe(false);
});
