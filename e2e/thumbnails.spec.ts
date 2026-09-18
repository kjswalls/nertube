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
 * M4 — the three thumbnail variants, the shipped role, and the swap log.
 *
 * Nothing here is faked. The browser puts real bytes into the real Storage API
 * with the real user session; the storage policy in `0001_init.sql` decides
 * whether it may; `swap_thumbnail` writes the log row and the role; and every
 * browser assertion is paired with a direct read of Postgres, because "a badge
 * appeared" is not evidence that a row was written and "an error showed" is not
 * evidence that nothing was.
 *
 * The two claims that matter most, and are the easiest to fake:
 *
 * 1. **The CHECK is the guard.** Shipping a role with no image is refused by
 *    `videos_shipped_role_has_asset`, in Postgres, not by a disabled button —
 *    so the spec presses the button and then reads the table to prove the
 *    refusal reached the database and came back as a sentence.
 * 2. **The swap is atomic.** `swap_thumbnail` inserts the log row *before* it
 *    updates `shipped_role`, so a refused update must take the log row with it.
 *    After every refusal this spec counts `thumbnail_swaps`.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** Differently sized, so "which image is this" is `naturalWidth`. */
const WILD = { name: 'wild.png', mimeType: 'image/png', buffer: makePng(4, 2, [220, 40, 40]) };
const WILD_V2 = { name: 'wild-2.png', mimeType: 'image/png', buffer: makePng(9, 5, [180, 90, 20]) };
const MODERATE = { name: 'moderate.png', mimeType: 'image/png', buffer: makePng(6, 3, [40, 160, 90]) };
const SAFE = { name: 'safe.png', mimeType: 'image/png', buffer: makePng(8, 4, [40, 60, 220]) };
/**
 * A file that says it is a PNG and is not one.
 *
 * `File.type` is what the browser sniffed from the picker, so this passes the
 * client-side check, uploads, and is recorded — and then fails in the one place
 * that actually decodes it. That is the real shape of this failure: a truncated
 * upload, a rename, a file that was never an image.
 */
const CORRUPT_PNG = {
  name: 'safe.png',
  mimeType: 'image/png',
  buffer: Buffer.from('this is not a png at all, not even a little bit\n'),
};

const NOT_AN_IMAGE = {
  name: 'thumbnail-notes.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('Face left, three props on the desk.\n'),
};

/** The smallest legal GIF87a — a different extension, so a different object. */
function makeGif(): Buffer {
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00,
    0x00, 0x00, 0xff, 0xff, 0xff, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
  ]);
}
const WILD_GIF = { name: 'wild.gif', mimeType: 'image/gif', buffer: makeGif() };

const CHANNEL = { name: 'M4 Thumbs', slug: 'm4-thumbs' };

let db: Client;
let userId: string;
let channelId: string;

/* -------------------------------------------------------------------------- */
/* The database, read and seeded directly                                      */
/* -------------------------------------------------------------------------- */

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
           where c.slug like 'm4-thumbs%')`,
  );
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug like 'm4-thumbs%')`,
  );
  await db.query("delete from public.channels where slug like 'm4-thumbs%'");
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
        CHANNEL_DEFAULTS.expected_ctr,
        CHANNEL_DEFAULTS.voice_guide,
        JSON.stringify(stages),
        JSON.stringify(SEED_BUCKETS.map((bucket) => ({ ...bucket, monthly_quota: null }))),
      ],
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

/** The written thumbnail concept, which the section quotes at the top. */
async function setConcept(videoId: string, concept: string): Promise<void> {
  await db.query('update public.videos set thumbnail_concept = $2 where id = $1', [
    videoId,
    concept,
  ]);
}

interface VideoThumbState {
  wild_card: string | null;
  moderate: string | null;
  safe: string | null;
  shipped_role: string | null;
}

async function thumbState(videoId: string): Promise<VideoThumbState> {
  const result = await db.query<VideoThumbState>(
    `select thumb_wild_card_path as wild_card,
            thumb_moderate_path  as moderate,
            thumb_safe_path      as safe,
            shipped_role
       from public.videos where id = $1`,
    [videoId],
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
    'select from_role, to_role, reason from public.thumbnail_swaps where video_id = $1 order by swapped_at asc',
    [videoId],
  );
  return result.rows;
}

/** Every object actually in the bucket under this video's folder. */
async function objectsFor(videoId: string): Promise<string[]> {
  const result = await db.query<{ name: string }>(
    `select name from storage.objects
      where bucket_id = 'thumbnails' and name like $1 order by name`,
    [`${userId}/${videoId}/%`],
  );
  return result.rows.map((row) => row.name);
}

/* -------------------------------------------------------------------------- */
/* The app                                                                     */
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

const slotStatus = (page: Page, role: Role): Locator =>
  slot(page, role).getByTestId('variant-status');

async function openThumbnails(page: Page, videoId: string): Promise<void> {
  await page.goto(`/videos/${videoId}?section=thumbnails`);
  await expect(page.getByTestId('thumbnails-section')).toBeVisible();
}

/** Upload through the real picker and wait for the row to have taken it. */
async function upload(
  page: Page,
  role: Role,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await slot(page, role).getByTestId('variant-file').setInputFiles(file);
  await expect(slotStatus(page, role)).toHaveText(/saved$/);
}

/** The browser's own decoder: > 0 only if real image bytes arrived. */
async function decodedWidth(image: Locator): Promise<number> {
  return image.evaluate((element) => (element as HTMLImageElement).naturalWidth);
}

/* -------------------------------------------------------------------------- */
/* Specs                                                                       */
/* -------------------------------------------------------------------------- */

test('each of the three roles takes its own image, and the concept is quoted above them', async ({
  page,
}) => {
  const videoId = await capture('Three bets');
  await setConcept(videoId, 'Hands holding a cracked phone, face out of frame.');

  await openThumbnails(page, videoId);

  // The brief the variants are working against, quoted read-only, with the way
  // back to the field that owns it.
  await expect(page.getByTestId('thumbnail-concept-quote')).toHaveText(
    'Hands holding a cracked phone, face out of frame.',
  );
  await expect(page.getByTestId('thumbnail-concept-edit-link')).toHaveAttribute(
    'href',
    `/videos/${videoId}#packaging-concept`,
  );

  // Nothing yet, and it says so without pretending anything is broken.
  await expect(page.getByTestId('thumbnails-readiness')).toHaveText(/No variants yet/);
  for (const role of ['wild_card', 'moderate', 'safe'] as const) {
    await expect(slot(page, role)).toHaveAttribute('data-state', 'empty');
    await expect(slot(page, role).getByTestId('variant-empty')).toHaveText('No image yet');
  }

  await upload(page, 'wild_card', WILD);
  await expect(page.getByTestId('thumbnails-readiness')).toHaveText(/1 of 3 ready/);

  await upload(page, 'moderate', MODERATE);
  await upload(page, 'safe', SAFE);
  await expect(page.getByTestId('thumbnails-readiness')).toHaveText('All three ready.');

  // Each frame shows its own image — checked by the size the fixture generated,
  // so a slot showing its neighbour's picture would fail here.
  await expect.poll(() => decodedWidth(slot(page, 'wild_card').getByTestId('variant-image'))).toBe(4);
  await expect.poll(() => decodedWidth(slot(page, 'moderate').getByTestId('variant-image'))).toBe(6);
  await expect.poll(() => decodedWidth(slot(page, 'safe').getByTestId('variant-image'))).toBe(8);

  // Three columns, three objects, at the stable per-role paths.
  expect(await thumbState(videoId)).toMatchObject({
    wild_card: `${userId}/${videoId}/wild_card.png`,
    moderate: `${userId}/${videoId}/moderate.png`,
    safe: `${userId}/${videoId}/safe.png`,
    shipped_role: null,
  });
  expect(await objectsFor(videoId)).toEqual([
    `${userId}/${videoId}/moderate.png`,
    `${userId}/${videoId}/safe.png`,
    `${userId}/${videoId}/wild_card.png`,
  ]);

  // And the feed strip draws the same three beside a neighbour, at feed size.
  // The row itself is the preview's comparison mode
  // (`components/preview/comparison.tsx`), which is where its test ids come
  // from; `e2e/preview.spec.ts` is where its geometry is asserted.
  await expect(page.getByTestId('preview-comparison-tile')).toHaveCount(4);

  // Each tile carries its own picture — the same fixture sizes again, so a row
  // that drew one variant three times would fail here.
  for (const [role, size] of [
    ['wild_card', 4],
    ['moderate', 6],
    ['safe', 8],
  ] as const) {
    await expect
      .poll(() =>
        decodedWidth(
          page
            .locator(`[data-testid="preview-comparison-tile"][data-role="${role}"]`)
            .getByTestId('preview-comparison-image'),
        ),
      )
      .toBe(size);
  }

  // Survives a reload: this is the row, not something the client is holding.
  await page.reload();
  await expect(page.getByTestId('thumbnails-readiness')).toHaveText('All three ready.');
});

test('a non-image is refused in the browser, and never reaches storage', async ({ page }) => {
  const videoId = await capture('Refuse this');

  const storageWrites: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/storage/v1/') && url.includes(videoId) && request.method() !== 'GET') {
      storageWrites.push(url);
    }
  });

  await openThumbnails(page, videoId);
  await slot(page, 'wild_card').getByTestId('variant-file').setInputFiles(NOT_AN_IMAGE);

  const status = slotStatus(page, 'wild_card');
  await expect(status).toHaveText(/wild card thumbnail has to be an image/);
  await expect(status).toHaveAttribute('role', 'alert');

  expect(storageWrites).toEqual([]);
  expect(await objectsFor(videoId)).toEqual([]);
  expect((await thumbState(videoId)).wild_card).toBeNull();

  // Not a dead end: the same field works immediately afterwards.
  await upload(page, 'wild_card', WILD);
});

test('shipping a role with no image is refused by the CHECK, in words, and writes no log row', async ({
  page,
}) => {
  const videoId = await capture('Nothing to ship');
  await openThumbnails(page, videoId);

  // The button is deliberately *not* disabled: the rule belongs to
  // `videos_shipped_role_has_asset` in Postgres, and a greyed-out control would
  // be the application claiming a rule it does not enforce.
  const ship = slot(page, 'safe').getByTestId('variant-ship');
  await expect(ship).toBeEnabled();
  await ship.click();

  // A sentence naming the slot and the thing to do about it — not a constraint
  // name, and not "could not save".
  await expect(slotStatus(page, 'safe')).toHaveText(
    'Safe has no image yet — upload one before shipping it.',
  );

  // The refusal reached the database and came back: nothing was shipped, and
  // — because `swap_thumbnail` inserts the log row before it updates the role —
  // the log did not gain a row for a swap that never happened.
  expect((await thumbState(videoId)).shipped_role).toBeNull();
  expect(await swapRows(videoId)).toEqual([]);

  // Upload one, and the same button now works.
  await upload(page, 'safe', SAFE);
  await slot(page, 'safe').getByTestId('variant-ship').click();
  await expect(slot(page, 'safe')).toHaveAttribute('data-live', 'true');
  expect((await thumbState(videoId)).shipped_role).toBe('safe');
});

test('the first ship is one click; changing it needs a typed reason and writes both halves', async ({
  page,
}) => {
  const videoId = await capture('Swap me');
  await openThumbnails(page, videoId);

  await upload(page, 'wild_card', WILD);
  await upload(page, 'moderate', MODERATE);

  // Nothing is live, so there is nothing to explain: one click, logged as the
  // launch choice.
  await slot(page, 'wild_card').getByTestId('variant-ship').click();
  await expect(slot(page, 'wild_card').getByTestId('variant-live-badge')).toBeVisible();
  expect((await thumbState(videoId)).shipped_role).toBe('wild_card');
  expect(await swapRows(videoId)).toEqual([
    { from_role: null, to_role: 'wild_card', reason: 'Chosen at launch.' },
  ]);

  // Changing it opens the dialog rather than swapping silently.
  await slot(page, 'moderate').getByTestId('variant-ship').click();
  const dialog = page.getByTestId('swap-dialog');
  await expect(dialog).toBeVisible();

  // An empty reason is refused before any round trip…
  await dialog.getByTestId('swap-confirm').click();
  await expect(dialog.getByTestId('swap-notice')).toHaveText(/needs a reason/);
  expect((await thumbState(videoId)).shipped_role).toBe('wild_card');
  expect(await swapRows(videoId)).toHaveLength(1);

  // …and so is one nobody could read in three months.
  await dialog.getByTestId('swap-reason-input').fill('nope');
  await dialog.getByTestId('swap-confirm').click();
  await expect(dialog.getByTestId('swap-notice')).toHaveText(/at least 12 characters/);
  expect(await swapRows(videoId)).toHaveLength(1);

  const reason = 'CTR 2.1% against an expected 4% — the wild card is not reading';
  await dialog.getByTestId('swap-reason-input').fill(reason);
  await dialog.getByTestId('swap-confirm').click();

  await expect(dialog).toBeHidden();
  await expect(slot(page, 'moderate')).toHaveAttribute('data-live', 'true');
  await expect(slot(page, 'wild_card')).toHaveAttribute('data-live', 'false');

  // Both halves, written together by `swap_thumbnail`: the role and the row.
  expect((await thumbState(videoId)).shipped_role).toBe('moderate');
  expect(await swapRows(videoId)).toEqual([
    { from_role: null, to_role: 'wild_card', reason: 'Chosen at launch.' },
    { from_role: 'wild_card', to_role: 'moderate', reason },
  ]);

  // The log renders newest first, with date, from, to and reason.
  const rows = page.getByTestId('swap-log-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-from', 'wild_card');
  await expect(rows.nth(0)).toHaveAttribute('data-to', 'moderate');
  await expect(rows.nth(0).getByTestId('swap-log-reason')).toHaveText(reason);
  await expect(rows.nth(1)).toHaveAttribute('data-to', 'wild_card');

  // The live slot carries the reason it is live, so the "why" is where the
  // decision is, not only at the bottom of the page.
  await expect(slot(page, 'moderate').getByTestId('variant-live-note')).toContainText(reason);

  // Removing the image that is live is refused by the same CHECK, read from
  // the other direction — and the image is still there afterwards.
  await slot(page, 'moderate').getByTestId('variant-remove').click();
  await expect(slotStatus(page, 'moderate')).toHaveText(/Moderate is the one that is live/);
  expect((await thumbState(videoId)).moderate).toBe(`${userId}/${videoId}/moderate.png`);
  expect(await objectsFor(videoId)).toContain(`${userId}/${videoId}/moderate.png`);
});

test('re-uploading a role replaces it instead of adding a second object', async ({ page }) => {
  const videoId = await capture('Replace me');
  const png = `${userId}/${videoId}/wild_card.png`;

  await openThumbnails(page, videoId);
  await upload(page, 'wild_card', WILD);
  await expect.poll(() => decodedWidth(slot(page, 'wild_card').getByTestId('variant-image'))).toBe(4);
  expect(await objectsFor(videoId)).toEqual([png]);

  // A second, visibly different image of the same format: same object name,
  // replaced in place by `upsert`.
  await upload(page, 'wild_card', WILD_V2);
  await expect.poll(() => decodedWidth(slot(page, 'wild_card').getByTestId('variant-image'))).toBe(9);
  expect(await objectsFor(videoId)).toEqual([png]);
  expect((await thumbState(videoId)).wild_card).toBe(png);

  // A different *format* is a different object name, so the old one has to be
  // removed or it sits in the bucket forever with nothing referencing it.
  await upload(page, 'wild_card', WILD_GIF);
  expect((await thumbState(videoId)).wild_card).toBe(`${userId}/${videoId}/wild_card.gif`);
  expect(await objectsFor(videoId)).toEqual([`${userId}/${videoId}/wild_card.gif`]);

  // And the other two slots were never touched by any of it.
  const state = await thumbState(videoId);
  expect(state.moderate).toBeNull();
  expect(state.safe).toBeNull();

  await page.reload();
  await expect.poll(() => decodedWidth(slot(page, 'wild_card').getByTestId('variant-image'))).toBe(1);
});

test('a variant that cannot be loaded says so, rather than claiming nothing was uploaded', async ({
  page,
}) => {
  const videoId = await capture('Gone missing');

  await openThumbnails(page, videoId);
  await upload(page, 'wild_card', WILD);
  await upload(page, 'moderate', MODERATE);

  // The object disappears from under the row — a hand-deleted bucket, a
  // half-finished upload, a restore that missed one. The row still names it.
  await db.query(
    `delete from storage.objects where bucket_id = 'thumbnails' and name = $1`,
    [`${userId}/${videoId}/wild_card.png`],
  );

  await page.reload();

  const wild = slot(page, 'wild_card');
  await expect(wild).toHaveAttribute('data-state', 'unreachable');
  await expect(wild.getByTestId('variant-empty')).toHaveText(/could not be reached/);
  // The lie this is here to prevent: an empty-looking slot that says nothing
  // was ever uploaded, which the person cannot act on.
  await expect(wild.getByTestId('variant-empty')).not.toHaveText('No image yet');
  // The row still names it, so the count is honest too.
  expect((await thumbState(videoId)).wild_card).toBe(`${userId}/${videoId}/wild_card.png`);
  await expect(page.getByTestId('thumbnails-readiness')).toHaveText(/2 of 3 ready/);

  // The other failure: a URL was signed, bytes came back, and the browser could
  // not decode them — a truncated upload, a file that was never really a PNG.
  // The frame must not stay a blank rectangle with no explanation on it, which
  // is exactly what an <img> with no `onError` does: it stays in the layout at
  // full size with `naturalWidth` 0 and paints nothing.
  await slot(page, 'safe').getByTestId('variant-file').setInputFiles(CORRUPT_PNG);
  await expect(slotStatus(page, 'safe')).toHaveText(/saved$/);

  const safe = slot(page, 'safe');
  await expect(safe).toHaveAttribute('data-state', 'broken');
  await expect(safe.getByTestId('variant-empty')).toHaveText(/would not load/);

  // It is still a *recorded* variant, so the app does not quietly forget it.
  expect((await thumbState(videoId)).safe).toBe(`${userId}/${videoId}/safe.png`);
});
