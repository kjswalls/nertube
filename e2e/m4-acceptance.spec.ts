import { expect, test, type Locator, type Page } from '@playwright/test';
import { Client } from 'pg';

import {
  CHANNEL_DEFAULTS,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
} from '../lib/defaults';
import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';
import { makePng } from './png';

/**
 * M4 acceptance — PLAN.md's own list, walked in a browser.
 *
 * > *Runnable:* the Thursday scenario.
 *
 * Thursday is the day after a video went out. The creator opens it, writes down
 * what the first twenty-four hours did, looks at the click-through against what
 * this channel normally does, decides the thumbnail is the problem, swaps it,
 * and says why. One person, one video, one sitting — which is the thing the two
 * detailed specs beside this one (`e2e/thumbnails.spec.ts`,
 * `e2e/post-publish.spec.ts`) deliberately do not check, because each of them
 * owns one half of it.
 *
 * What this file is really for is the **seam**. The three parts of M4 landed
 * from three directions: the variants and the swap log, the post-publish block,
 * and the feed comparison. Each is tested. What nobody's own spec can show is
 * that a number typed into the Publish tab changes what the Thumbnails tab
 * offers, that swapping there answers the question asked here, and that the
 * five section tabs count all of it truthfully on the way past. So every step
 * below asserts three things: what the page says, what the *tabs* say, and what
 * is actually in Postgres.
 *
 * The tab assertions are not decoration. A readiness counter is the only part
 * of this page that makes a claim about a section you are not looking at, which
 * makes it the one part that can be wrong for months without anybody noticing.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** Three different pictures, so "which one is this" is `naturalWidth`. */
const WILD = { name: 'wild.png', mimeType: 'image/png', buffer: makePng(4, 2, [220, 40, 40]) };
const MODERATE = { name: 'moderate.png', mimeType: 'image/png', buffer: makePng(6, 3, [40, 160, 90]) };
const SAFE = { name: 'safe.png', mimeType: 'image/png', buffer: makePng(8, 4, [40, 60, 220]) };

const CHANNEL = { name: 'M4 Acceptance', slug: 'm4-acceptance' };

const TITLE = 'I tried the 5am club for 30 days';
const CONCEPT = 'Me at 4:58am, face lit by the phone, kettle steaming behind.';
const REASON = 'CTR 2.1% against a 5% median — the wild card is not reading at tile size.';
const URL = 'https://www.youtube.com/watch?v=m4acceptance';

/**
 * The first twenty-four hours, as they would be copied out of Studio.
 *
 * 2.1% against a channel that normally does 5% is the Thursday scenario's whole
 * premise: plainly below, not arguably below, so the verdict the page draws is
 * not a judgement call that could go either way on a rounding change.
 */
const IMPRESSIONS = 9_400;
const CTR = 2.1;
const VIEWS = 198;
const NEW_VIEWERS = 'Two thirds were not subscribed, which is the only good news here.';

let db: Client;
let userId: string;
let channelId: string;

test.beforeAll(async () => {
  db = new Client({ ...PG });
  await db.connect();

  const found = await db.query<{ id: string }>(
    'select id from auth.users where lower(email) = lower($1)',
    [SEED_EMAIL],
  );
  if (found.rows.length === 0) {
    throw new Error(`the dev stack has no user ${SEED_EMAIL}; is it the stack this suite started?`);
  }
  userId = found.rows[0].id;
});

test.afterAll(async () => {
  await cleanUp();
  await db?.end();
});

test.beforeEach(async ({ page }) => {
  await cleanUp();
  channelId = await createChannel();
  await signIn(page);
});

async function cleanUp(): Promise<void> {
  await db.query(
    `delete from storage.objects
      where bucket_id = 'thumbnails'
        and split_part(name, '/', 2) in (
          select v.id::text from public.videos v
            join public.channels c on c.id = v.channel_id
           where c.slug like 'm4-acceptance%')`,
  );
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug like 'm4-acceptance%')`,
  );
  await db.query("delete from public.channels where slug like 'm4-acceptance%'");
}

/** Run `fn` the way a PostgREST request runs it: that role, those claims. */
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

/** The same `create_channel` transaction the app calls, with the same seed. */
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
        // Deliberately left as the default (null). The channel's expected CTR
        // has no UI until M7, so on Thursday the bar a real video is judged
        // against is the median of what this channel has already done — which
        // is the branch worth walking.
        CHANNEL_DEFAULTS.expected_ctr,
        CHANNEL_DEFAULTS.voice_guide,
        JSON.stringify(stages),
        JSON.stringify(SEED_BUCKETS.map((bucket) => ({ ...bucket, monthly_quota: null }))),
      ],
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

/**
 * A video scheduled for today, with its packaging filled in.
 *
 * Everything up to here is M1 and M2's, and both have their own acceptance
 * walks; doing it again through the board would make this file a test of
 * dragging. The gate is still evaluated for real — `move_video` reads the three
 * fields at move time — so a video that arrives in Scheduled arrived through
 * the same door the board uses.
 */
async function scheduledForToday(title: string): Promise<{ id: string; target: string }> {
  const id = await capture(title);
  const target = new Date().toISOString().slice(0, 10);

  await db.query(
    `update public.videos
        set thumbnail_concept = $2,
            hooks = $3::jsonb,
            target_publish_date = $4::date
      where id = $1`,
    [
      id,
      CONCEPT,
      JSON.stringify([{ id: 'h1', text: 'I set five alarms and hated every one.', chosen: true }]),
      target,
    ],
  );

  const scheduled = await stageIdOf('scheduled');
  await asUser(async () => {
    await db.query('select * from move_video($1::uuid, $2::uuid)', [id, scheduled]);
  });

  return { id, target };
}

/**
 * Two videos this channel already published and logged.
 *
 * Without them there is no expectation and the prompt correctly refuses to have
 * a verdict — which is its own spec, in `e2e/post-publish.spec.ts`. Thursday is
 * the day the bar exists.
 */
async function seedPastPerformance(): Promise<void> {
  const published = await stageIdOf('published');
  for (const [index, ctr] of [5.4, 5.0].entries()) {
    const id = await capture(`Earlier video ${index + 1}`);
    await db.query(
      `update public.videos
          set stage_id = $2,
              published_at = now() - ($3 || ' days')::interval,
              first24_impressions = 11000,
              first24_ctr = $4,
              metrics_logged_at = now() - ($3 || ' days')::interval
        where id = $1`,
      [id, published, String(20 + index * 7), ctr],
    );
  }
}

interface VideoRow {
  shipped_role: string | null;
  published_at: string | null;
  youtube_url: string | null;
  first24_impressions: number | null;
  first24_ctr: string | null;
  first24_views: number | null;
  new_viewers_note: string | null;
  metrics_logged_at: string | null;
  swap_dismissed_at: string | null;
  stage_kind: string | null;
  wild_card: string | null;
  moderate: string | null;
  safe: string | null;
}

async function videoRow(id: string): Promise<VideoRow> {
  const result = await db.query<VideoRow>(
    `select v.shipped_role, v.published_at, v.youtube_url,
            v.first24_impressions, v.first24_ctr, v.first24_views,
            v.new_viewers_note, v.metrics_logged_at, v.swap_dismissed_at,
            v.thumb_wild_card_path as wild_card,
            v.thumb_moderate_path  as moderate,
            v.thumb_safe_path      as safe,
            s.kind as stage_kind
       from public.videos v
       join public.stages s on s.id = v.stage_id
      where v.id = $1`,
    [id],
  );
  return result.rows[0];
}

interface SwapRow {
  from_role: string | null;
  to_role: string;
  reason: string;
}

async function swapRows(videoId: string): Promise<SwapRow[]> {
  const result = await db.query<SwapRow>(
    `select from_role, to_role, reason from public.thumbnail_swaps
      where video_id = $1 order by swapped_at asc, created_at asc`,
    [videoId],
  );
  return result.rows;
}

/* -------------------------------------------------------------------------- */
/* Browser helpers                                                             */
/* -------------------------------------------------------------------------- */

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}

type Role = 'wild_card' | 'moderate' | 'safe';

const slot = (page: Page, role: Role): Locator =>
  page.locator(`[data-testid="variant-slot"][data-role="${role}"]`);

const tab = (page: Page, id: string): Locator => page.getByTestId(`section-tab-${id}`);

/**
 * What a tab claims: `3/3`, `done`, `locked`, or nothing at all.
 *
 * Read from the mark's `data-mark` rather than from the tooltip, because the
 * mark is what a person actually sees from across the page.
 */
async function tabMark(page: Page, id: string): Promise<string> {
  const mark = tab(page, id).getByTestId('section-mark');
  if ((await mark.count()) === 0) return 'quiet';
  const kind = await mark.getAttribute('data-mark');
  if (kind !== 'ratio') return kind ?? 'quiet';
  // The visible ratio, without the screen-reader commentary the mark wraps it
  // in (", " before and " done" after, so a screen reader reads the tab as a
  // sentence rather than as "Thumbnails zero three").
  const text = (await mark.innerText()).replace(/\s+/g, ' ');
  return /(\d+)\/(\d+)/.exec(text)?.[0] ?? text.trim();
}

/**
 * Wait for a tab to say what it should.
 *
 * Polled rather than read once, because the tabs are rendered from the row and
 * the Thumbnails section deliberately keeps no optimistic copy of it: an upload
 * runs its action, adopts the returned `updated_at` and calls `router.refresh()`
 * — so the mark changes when the *server* says so, a beat after the slot does.
 * That is the design (one source of truth, no eighth optimistic-save bug), and
 * asserting it with a poll is asserting it honestly rather than papering over a
 * race with a sleep.
 */
async function expectTabMark(page: Page, id: string, expected: string): Promise<void> {
  await expect(async () => {
    expect(await tabMark(page, id)).toBe(expected);
  }).toPass();
}

async function upload(page: Page, role: Role, file: typeof WILD): Promise<void> {
  await slot(page, role).getByTestId('variant-file').setInputFiles(file);
  await expect(slot(page, role).getByTestId('variant-status')).toHaveText(/saved$/);
}

/* -------------------------------------------------------------------------- */
/* Thursday                                                                    */
/* -------------------------------------------------------------------------- */

test('the Thursday scenario: live, logged, under the bar, swapped with a reason', async ({
  page,
}) => {
  await seedPastPerformance();
  const { id, target } = await scheduledForToday(TITLE);

  /* ---------------------------------------------------------------- 1 ---- */
  /* The three variants, made before it goes out — which is the whole point of
     having three (BRIEF.md principle 7): the swap later costs minutes because
     the images already exist. */

  await page.goto(`/videos/${id}?section=thumbnails`);
  await expect(page.getByTestId('thumbnails-section')).toBeVisible();

  // Before anything: the Thumbnails tab says how many of three exist, and the
  // Publish tab is NOT locked — this video is Scheduled, and the one thing the
  // Publish section is holding for it is the offer to confirm it live.
  await expectTabMark(page, 'thumbnails', '0/3');
  await expectTabMark(page, 'publish', 'quiet');

  // The concept is quoted at the top, as the brief the three are working
  // against. Concept and asset are different things at different stages, and
  // this is the screen where they would otherwise blur.
  await expect(page.getByTestId('thumbnail-concept-quote')).toContainText(CONCEPT);

  await upload(page, 'wild_card', WILD);
  await expectTabMark(page, 'thumbnails', '1/3');
  await upload(page, 'moderate', MODERATE);
  await upload(page, 'safe', SAFE);

  // Three files and nothing live is not finished — nobody can tell which one is
  // on YouTube — so the tab still counts rather than ticking.
  await expectTabMark(page, 'thumbnails', '3/3');

  const afterUploads = await videoRow(id);
  expect(afterUploads.wild_card).not.toBeNull();
  expect(afterUploads.moderate).not.toBeNull();
  expect(afterUploads.safe).not.toBeNull();
  expect(afterUploads.shipped_role).toBeNull();

  /* ---------------------------------------------------------------- 2 ---- */
  /* Ship the wild card. The first one is one click: nothing is being replaced,
     so there is nothing to explain, and the log says so in the app's voice. */

  await slot(page, 'wild_card').getByTestId('variant-ship').click();
  await expect(slot(page, 'wild_card').getByTestId('variant-live-badge')).toBeVisible();

  expect((await videoRow(id)).shipped_role).toBe('wild_card');
  expect(await swapRows(id)).toEqual([
    { from_role: null, to_role: 'wild_card', reason: 'Chosen at launch.' },
  ]);

  // Three variants and one of them live: now it ticks.
  await expectTabMark(page, 'thumbnails', 'done');

  /* ---------------------------------------------------------------- 3 ---- */
  /* Wednesday night: it goes out. */

  await tab(page, 'publish').click();
  const confirm = page.getByTestId('confirm-live');
  await expect(confirm).toBeVisible();
  await confirm.getByTestId('confirm-live-url').fill(URL);
  await confirm.getByTestId('confirm-live-save').click();

  await expect(page.getByTestId('publish-live')).toBeVisible();

  const live = await videoRow(id);
  expect(live.stage_kind).toBe('published');
  expect(live.youtube_url).toBe(URL);
  // `published_at` is the date it was *aimed* at, not the moment the row was
  // ticked: `published_at + 24h` is what the metrics prompt counts from, so the
  // whole post-publish loop is a day late if this is wrong.
  expect(live.published_at).not.toBeNull();
  expect(new Date(live.published_at as string).toISOString().slice(0, 10)).toBe(target);

  // Live, nothing written down: step 0 of BRIEF.md principle 8's two.
  await expectTabMark(page, 'publish', '0/2');

  /* ---------------------------------------------------------------- 4 ---- */
  /* Thursday morning: the numbers go in. Impressions and click-through are one
     control and are typed together. */

  const pair = page.getByTestId('metrics-pair');
  await expect(pair).toBeVisible();
  await pair.getByTestId('metrics-impressions').fill(String(IMPRESSIONS));
  await pair.getByTestId('metrics-ctr').fill(String(CTR));
  await pair.getByTestId('metrics-views').fill(String(VIEWS));
  await pair.getByTestId('metrics-new-viewers').fill(NEW_VIEWERS);
  await pair.getByTestId('metrics-save').click();

  await expect(page.getByTestId('metrics-logged-at')).toContainText('Logged');

  const logged = await videoRow(id);
  expect(logged.first24_impressions).toBe(IMPRESSIONS);
  expect(Number(logged.first24_ctr)).toBe(CTR);
  expect(logged.first24_views).toBe(VIEWS);
  expect(logged.new_viewers_note).toBe(NEW_VIEWERS);
  expect(logged.metrics_logged_at).not.toBeNull();

  /* ---------------------------------------------------------------- 5 ---- */
  /* The click-through is under the bar, and the page says so with the bar it
     used — not with a number it invented. */

  const prompt = page.getByTestId('swap-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveAttribute('data-verdict', 'below');
  await expect(prompt).toHaveAttribute('data-urgent', 'true');

  // Both numbers, never one: the pair rule holds in the prompt as well as in
  // the form it came from.
  await expect(prompt.getByTestId('swap-prompt-numbers')).toHaveText(
    '9,400 impressions · 2.1% click-through',
  );

  // The bar is the median of this channel's logged videos, and the sentence
  // names the sample it was taken over — 5.4, 5.0 and this video's own 2.1.
  await expect(prompt.getByTestId('swap-prompt-verdict')).toContainText(
    'median of its last 3 logged videos',
  );
  await expect(prompt.getByTestId('swap-prompt-verdict')).toContainText('5%');

  // Logged, nothing decided: 1 of 2. A number nobody acted on is exactly the
  // state the post-publish loop exists to get out of.
  await expectTabMark(page, 'publish', '1/2');

  /* ---------------------------------------------------------------- 6 ---- */
  /* The decision is made where the three variants are, beside a competitor's
     tile — because the question is which one wins in a feed, not which one is
     nicest on its own. */

  await prompt.getByTestId('swap-prompt-open').click();
  await expect(page.getByTestId('thumbnails-section')).toBeVisible();
  await expect(page.getByTestId('preview-comparison')).toBeVisible();

  await slot(page, 'moderate').getByTestId('variant-ship').click();

  const dialog = page.getByTestId('swap-dialog');
  await expect(dialog).toBeVisible();

  // While a modal is open the page underneath is quiet. `c` is the global
  // capture key; pressing it here must not open a second dialog on top of this
  // one. (It did, while the swap dialog was a native `<dialog>` of its own —
  // see components/modal.tsx.)
  await dialog.getByTestId('swap-cancel').focus();
  await page.keyboard.press('c');
  await expect(page.getByRole('dialog', { name: 'Capture an idea' })).toHaveCount(0);

  // A change has to be explained. The log is the only record of why a thumbnail
  // moved, and "x" would satisfy the database and tell a reader nothing.
  await dialog.getByTestId('swap-confirm').click();
  await expect(dialog.getByTestId('swap-notice')).toHaveText(/needs a reason/);
  expect(await swapRows(id)).toHaveLength(1);

  await dialog.getByTestId('swap-reason-input').fill(REASON);
  await dialog.getByTestId('swap-confirm').click();
  await expect(dialog).toHaveCount(0);

  /* ---------------------------------------------------------------- 7 ---- */
  /* The log records it: one row, both halves, written in one transaction. */

  await expect(slot(page, 'moderate').getByTestId('variant-live-badge')).toBeVisible();
  expect((await videoRow(id)).shipped_role).toBe('moderate');

  expect(await swapRows(id)).toEqual([
    { from_role: null, to_role: 'wild_card', reason: 'Chosen at launch.' },
    { from_role: 'wild_card', to_role: 'moderate', reason: REASON },
  ]);

  const rows = page.getByTestId('swap-log-row');
  await expect(rows).toHaveCount(2);
  // Newest first.
  await expect(rows.first().getByTestId('swap-log-reason')).toHaveText(REASON);
  await expect(rows.first().getByTestId('swap-log-roles')).toContainText('Moderate');

  // The live slot now carries the date and the reason it went live, so the
  // "why" is on the picture and not only at the bottom of the page.
  await expect(slot(page, 'moderate').getByTestId('variant-live-note')).toContainText(
    REASON,
  );

  /* ---------------------------------------------------------------- 8 ---- */
  /* And the question stops being asked, in both places that ask it. */

  await page.goto(`/videos/${id}?section=publish`);
  await expect(page.getByTestId('swap-prompt-already-swapped')).toBeVisible();
  await expectTabMark(page, 'publish', 'done');
  // Answered by acting, not by dismissing: "keep it" was never pressed.
  expect((await videoRow(id)).swap_dismissed_at).toBeNull();

  await page.goto('/now');
  await expect(page.getByTestId('now')).toBeVisible();
  const swapRow = page
    .getByTestId('now-row')
    .filter({ has: page.getByTestId('now-video-link').filter({ hasText: TITLE }) })
    .filter({ has: page.getByTestId('now-swap-open') });
  await expect(swapRow).toHaveCount(0);
});
