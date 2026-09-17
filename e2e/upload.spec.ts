import { deflateSync } from 'node:zlib';

import { expect, test, type Locator, type Page } from '@playwright/test';
import { Client } from 'pg';

import {
  CHANNEL_DEFAULTS,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
} from '../lib/defaults';
import {
  GATEWAY_URL,
  PG,
  SEED_EMAIL,
  SEED_PASSWORD,
} from '../scripts/dev-stack/shared';

/**
 * M1 — the thumbnail-concept sketch, end to end.
 *
 * The whole point of this file is that nothing about the upload is faked. The
 * browser puts the bytes into the real Storage API with the real user session;
 * the storage policy in `0001_init.sql` is what decides whether it may; the
 * path is recorded by the real server action; and the picture that comes back
 * onto the page is fetched from a real signed URL. Every browser assertion is
 * paired with a direct read of Postgres — `storage.objects` as well as
 * `public.videos` — because "an image appeared" is not evidence that exactly
 * one object exists, and that is the invariant M1's review asks for.
 *
 * ## The fixture PNG is generated, not committed
 *
 * `makePng()` below writes the eight-byte signature, an IHDR, a zlib-deflated
 * IDAT and an IEND by hand. It is twenty lines, and it means the bytes under
 * test are bytes this file can explain — a base64 blob pasted into a spec is a
 * thing nobody ever reads again, and when a browser refuses to decode it there
 * is no way to tell whether the spec or the app is wrong. Each upload here uses
 * a *differently sized* image, so "the picture changed" is checkable as
 * `naturalWidth`, from the browser's own decoder.
 */

/* -------------------------------------------------------------------------- */
/* A PNG, written out                                                          */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** A solid-colour 8-bit RGB PNG of the given size. */
function makePng(
  width: number,
  height: number,
  [r, g, b]: [number, number, number],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  // 10..12: compression 0, filter 0, interlace 0 — all already zero.

  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // per-scanline filter: none
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A GIF, for the one case the path convention has to handle specially: a new
 * upload in a *different format* is a different object name, so the old object
 * has to be deleted rather than left behind. This is the smallest legal GIF87a
 * — a 1x1 with a two-colour table — assembled the same way, byte by byte.
 */
function makeGif(): Buffer {
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x37, 0x61, // "GIF87a"
    0x01, 0x00, 0x01, 0x00, // 1 x 1
    0x80, 0x00, 0x00, // global colour table, 2 entries
    0x00, 0x00, 0x00, 0xff, 0xff, 0xff, // black, white
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // image descriptor
    0x02, 0x02, 0x44, 0x01, 0x00, // LZW data
    0x3b, // trailer
  ]);
}

const RED_4x2 = { name: 'sketch.png', mimeType: 'image/png', buffer: makePng(4, 2, [220, 40, 40]) };
const BLUE_9x5 = { name: 'sketch-v2.png', mimeType: 'image/png', buffer: makePng(9, 5, [40, 60, 220]) };
const GIF_1x1 = { name: 'sketch.gif', mimeType: 'image/gif', buffer: makeGif() };
const NOT_AN_IMAGE = {
  name: 'thumbnail-notes.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('Face left, three props on the desk.\n'),
};

/* -------------------------------------------------------------------------- */
/* The database, read and seeded directly                                      */
/* -------------------------------------------------------------------------- */

const CHANNEL = { name: 'M1 Upload', slug: 'm1-upload' };

/** A second account, so "another user's video" is a real other user. */
const OTHER_EMAIL = 'm1-upload-other@example.test';

let db: Client;
let userId: string;
let otherUserId: string;
let channelId: string;

test.beforeAll(async () => {
  db = new Client({ ...PG });
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
  otherUserId = await ensureOtherUser();
});

test.afterAll(async () => {
  await cleanUp();
  await db?.end();
});

test.beforeEach(async ({ page }) => {
  await cleanUp();
  channelId = await createChannel(userId, CHANNEL.name, CHANNEL.slug);
  await signIn(page);
});

async function cleanUp(): Promise<void> {
  // Objects first: they are keyed by user id and video id, and the video rows
  // are about to go. Anything under a fixture video's folder is this file's.
  await db.query(
    `delete from storage.objects
      where bucket_id = 'thumbnails'
        and split_part(name, '/', 2) in (
          select v.id::text from public.videos v
            join public.channels c on c.id = v.channel_id
           where c.slug like 'm1-upload%')`,
  );
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug like 'm1-upload%')`,
  );
  await db.query("delete from public.channels where slug like 'm1-upload%'");
}

/** Run `fn` the way a PostgREST request runs it: that role, those claims. */
async function asUser<T>(id: string, email: string, fn: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: id, role: 'authenticated', aud: 'authenticated', email }),
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

async function ensureOtherUser(): Promise<string> {
  const existing = await db.query<{ id: string }>(
    'select id from auth.users where lower(email) = lower($1)',
    [OTHER_EMAIL],
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const created = await db.query<{ id: string }>(
    `insert into auth.users (email, encrypted_password, email_confirmed_at, aud, role)
     values (lower($1), crypt('never-signed-in', gen_salt('bf')), now(), 'authenticated', 'authenticated')
     returning id`,
    [OTHER_EMAIL],
  );
  return created.rows[0].id;
}

/** The same `create_channel` transaction the app calls, with the same seed. */
async function createChannel(
  ownerId: string,
  name: string,
  slug: string,
): Promise<string> {
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

  return asUser(ownerId, ownerId === userId ? SEED_EMAIL : OTHER_EMAIL, async () => {
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
        JSON.stringify(SEED_BUCKETS.map((bucket) => ({ ...bucket, monthly_quota: null }))),
      ],
    );
    return result.rows[0].id;
  });
}

/** `capture_video` — the only client path to a new video, always into Idea. */
async function capture(
  ownerId: string,
  ownerChannelId: string,
  title: string,
): Promise<string> {
  return asUser(ownerId, ownerId === userId ? SEED_EMAIL : OTHER_EMAIL, async () => {
    const result = await db.query<{ id: string }>(
      'select id from capture_video($1::uuid, $2::text)',
      [ownerChannelId, title],
    );
    return result.rows[0].id;
  });
}

/** What the row says the sketch is. */
async function storedPath(videoId: string): Promise<string | null> {
  const result = await db.query<{ thumbnail_concept_path: string | null }>(
    'select thumbnail_concept_path from public.videos where id = $1',
    [videoId],
  );
  return result.rows[0]?.thumbnail_concept_path ?? null;
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
  await page.waitForURL(/\/c\/[^/]+\/board$/);
}

const sketchInput = (page: Page): Locator => page.locator('input[type="file"]');
const sketchImage = (page: Page): Locator => page.getByTestId('concept-sketch-image');
const sketchFrame = (page: Page): Locator => page.getByTestId('concept-sketch-frame');
const sketchStatus = (page: Page): Locator => page.getByTestId('sketch-status');

/** The browser's own decoder: > 0 only if real image bytes arrived. */
async function decodedWidth(image: Locator): Promise<number> {
  return image.evaluate((element) => (element as HTMLImageElement).naturalWidth);
}

/** Upload a file through the real picker and wait for the app to settle. */
async function upload(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await sketchInput(page).setInputFiles(file);
  await expect(sketchStatus(page)).toHaveText('Sketch saved');
}

/* -------------------------------------------------------------------------- */
/* Specs                                                                       */
/* -------------------------------------------------------------------------- */

test('a sketch uploads from the browser, shows on the detail page, and shows on the board card', async ({
  page,
}) => {
  const videoId = await capture(userId, channelId, 'Sketch me');

  await page.goto(`/videos/${videoId}`);

  // It starts empty, and says so rather than showing a broken frame.
  await expect(sketchFrame(page)).toHaveAttribute('data-has-sketch', 'false');
  await expect(page.getByText('No sketch yet')).toBeVisible();
  await expect(sketchImage(page)).toHaveCount(0);
  expect(await storedPath(videoId)).toBeNull();

  // The picker is labelled, so this is the control a person actually uses.
  await expect(page.getByLabel('Upload a sketch')).toBeVisible();

  await upload(page, RED_4x2);

  // The picture on the page comes from a signed URL on the storage origin —
  // not from a local object URL, and not from the app's own server.
  const image = sketchImage(page);
  await expect(image).toBeVisible();
  const src = await image.getAttribute('src');
  expect(src).toContain(`${GATEWAY_URL}/storage/v1/object/sign/thumbnails/`);
  expect(src).toContain('token=');

  // And the browser decoded it: the bytes are really there, at the size the
  // fixture generated.
  await expect.poll(() => decodedWidth(image)).toBe(4);

  // The row points at the stable path, and there is exactly one object.
  expect(await storedPath(videoId)).toBe(`${userId}/${videoId}/concept.png`);
  expect(await objectsFor(videoId)).toEqual([`${userId}/${videoId}/concept.png`]);

  // Survives a reload: this is server state, not something the client is
  // holding on to.
  await page.reload();
  await expect(sketchFrame(page)).toHaveAttribute('data-has-sketch', 'true');
  await expect.poll(() => decodedWidth(sketchImage(page))).toBe(4);
  await expect(page.getByLabel('Replace the sketch')).toBeVisible();

  // The same sketch on the board card, from the board's batched signing.
  await page.goto(`/c/${CHANNEL.slug}/board`);
  const card = page.locator('[data-testid="board-card"]', { hasText: 'Sketch me' });
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();

  const cardImage = card.getByTestId('card-sketch');
  await expect(cardImage).toHaveCount(1);
  await expect.poll(() => decodedWidth(cardImage)).toBe(4);
  await expect(card.locator('[data-slot="thumbnail-concept"]')).toHaveAttribute(
    'data-showing-sketch',
    'true',
  );
});

test('re-uploading replaces the sketch instead of adding a second object', async ({
  page,
}) => {
  const videoId = await capture(userId, channelId, 'Replace me');
  const path = `${userId}/${videoId}/concept.png`;

  await page.goto(`/videos/${videoId}`);
  await upload(page, RED_4x2);
  await expect.poll(() => decodedWidth(sketchImage(page))).toBe(4);
  expect(await objectsFor(videoId)).toEqual([path]);

  // A second, visibly different image of the same format.
  await upload(page, BLUE_9x5);

  // The picture on the page is the new one — the signed URL was re-issued and
  // the bytes behind it changed.
  await expect.poll(() => decodedWidth(sketchImage(page))).toBe(9);

  // One object, same name. This is the invariant M1's review asks for: the
  // stable path plus `upsert` means a re-upload cannot orphan anything.
  expect(await objectsFor(videoId)).toEqual([path]);
  expect(await storedPath(videoId)).toBe(path);

  // And a hard reload agrees, so it is not a stale signed URL being reused.
  await page.reload();
  await expect.poll(() => decodedWidth(sketchImage(page))).toBe(9);
});

test('uploading a different format removes the object the old extension left behind', async ({
  page,
}) => {
  const videoId = await capture(userId, channelId, 'Change my format');

  await page.goto(`/videos/${videoId}`);
  await upload(page, RED_4x2);
  expect(await objectsFor(videoId)).toEqual([`${userId}/${videoId}/concept.png`]);

  // A GIF is a different object name, so without the delete in
  // `recordConceptSketch` the PNG would sit in the bucket forever with nothing
  // referencing it.
  await upload(page, GIF_1x1);

  expect(await storedPath(videoId)).toBe(`${userId}/${videoId}/concept.gif`);
  expect(await objectsFor(videoId)).toEqual([`${userId}/${videoId}/concept.gif`]);

  await page.reload();
  await expect.poll(() => decodedWidth(sketchImage(page))).toBe(1);
});

test('a non-image is refused in the browser, before anything is uploaded', async ({
  page,
}) => {
  const videoId = await capture(userId, channelId, 'Refuse this');

  const storageRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/storage/v1/')) storageRequests.push(request.url());
  });

  await page.goto(`/videos/${videoId}`);
  await sketchInput(page).setInputFiles(NOT_AN_IMAGE);

  // The refusal names what is wrong, and it is an alert rather than a status.
  const status = sketchStatus(page);
  await expect(status).toHaveText(/has to be an image/);
  await expect(status).toHaveAttribute('role', 'alert');

  // Nothing left the browser, nothing was written, and the frame is untouched.
  expect(storageRequests).toEqual([]);
  expect(await storedPath(videoId)).toBeNull();
  expect(await objectsFor(videoId)).toEqual([]);
  await expect(sketchFrame(page)).toHaveAttribute('data-has-sketch', 'false');

  // The same field still works immediately afterwards — the refusal is not a
  // dead end.
  await upload(page, RED_4x2);
  await expect.poll(() => decodedWidth(sketchImage(page))).toBe(4);
  expect(await objectsFor(videoId)).toEqual([`${userId}/${videoId}/concept.png`]);
});

test('the working title autosaves on blur and reaches the board', async ({ page }) => {
  const videoId = await capture(userId, channelId, 'Before');

  await page.goto(`/videos/${videoId}`);
  const field = page.getByLabel('Working title');
  await expect(field).toHaveValue('Before');

  await field.fill('  After, with the edges trimmed  ');
  // Enter blurs the field, which is what saves — the same path as clicking
  // away.
  await field.press('Enter');
  await expect(page.getByTestId('title-status')).toHaveText('Saved');

  // Trimmed on the way in, and actually in Postgres.
  await expect(field).toHaveValue('After, with the edges trimmed');
  const row = await db.query<{ title: string }>(
    'select title from public.videos where id = $1',
    [videoId],
  );
  expect(row.rows[0].title).toBe('After, with the edges trimmed');

  await page.goto(`/c/${CHANNEL.slug}/board`);
  await expect(
    page.locator('[data-testid="board-card"]', {
      hasText: 'After, with the edges trimmed',
    }),
  ).toBeVisible();
});

test("another user's video is a 404, not a 403 with details", async ({ page }) => {
  const otherChannelId = await createChannel(
    otherUserId,
    'M1 Upload Other',
    'm1-upload-other',
  );
  const theirVideo = await capture(otherUserId, otherChannelId, 'Not yours');

  const response = await page.goto(`/videos/${theirVideo}`);
  expect(response?.status()).toBe(404);
  // Nothing about the row leaks into the page.
  await expect(page.locator('body')).not.toContainText('Not yours');
  await expect(page.locator('input[type="file"]')).toHaveCount(0);

  // An id that never existed is indistinguishable from it.
  const missing = await page.goto('/videos/00000000-0000-4000-8000-000000000000');
  expect(missing?.status()).toBe(404);

  // And a malformed id is a 404 too, rather than a 500 out of PostgREST.
  const malformed = await page.goto('/videos/not-a-uuid');
  expect(malformed?.status()).toBe(404);
});
