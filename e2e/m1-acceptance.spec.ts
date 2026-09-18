import { expect, test, type Locator, type Page } from '@playwright/test';
import { Client } from 'pg';

import { SEED_STAGES } from '../lib/defaults';
import { apiKey } from '../scripts/dev-stack/jwt';
import {
  API_KEY_EXP,
  API_KEY_IAT,
  GATEWAY_URL,
  PG,
  SEED_CHANNELS,
  SEED_EMAIL,
  SEED_PASSWORD,
} from '../scripts/dev-stack/shared';
import { makePng } from './png';

/**
 * M1's acceptance, walked.
 *
 * PLAN.md's M1 line is: *capture 8 ideas across 2 channels, drag, refresh,
 * persists; dragging an idea past Packaging is refused; upload a sketch* — and
 * its review line is: *`update videos set stage_id` from the browser client
 * fails (revoke)*. The other spec files test each feature on its own, against a
 * fixture built with SQL. This one does the acceptance the way a person does
 * it: through the pages, in one order, with nothing seeded — the two channels
 * are made on `/c/new`, the eight ideas are typed into the `c` modal, the moves
 * are drags, and the only thing that comes out of Postgres is the verdict.
 *
 * Every browser assertion that says something was written is paired with a read
 * of the served database. "The card is in the Packaging column" is a statement
 * about a React tree; `select kind from stages` is a statement about the data.
 *
 * The file is serial on purpose: test one builds the channels and the eight
 * ideas the rest of the walk uses, exactly as a person would not start again
 * from scratch for each step.
 */

test.describe.configure({ mode: 'serial' });

const CHANNEL_A = { name: 'M1 Acceptance A', slug: 'm1-acceptance-a' };
const CHANNEL_B = { name: 'M1 Acceptance B', slug: 'm1-acceptance-b' };

/** Four ideas per channel: PLAN.md's eight, across two channels. */
const IDEAS_A = [
  'Acceptance A1 — desk tour',
  'Acceptance A2 — the honest timeline',
  'Acceptance A3 — what I cut',
  'Acceptance A4 — one-take build',
];
const IDEAS_B = [
  'Acceptance B1 — Sunday shipping',
  'Acceptance B2 — the build log',
  'Acceptance B3 — tiny tools',
  'Acceptance B4 — what broke',
];

const SKETCH = {
  name: 'acceptance-sketch.png',
  mimeType: 'image/png',
  buffer: makePng(6, 3, [30, 160, 90]),
};

const ANON_KEY = apiKey('anon', API_KEY_IAT, API_KEY_EXP);

/** Column headings, read from the seed rather than typed out again. */
const stageName = (kind: string): string => {
  const stage = SEED_STAGES.find((candidate) => candidate.kind === kind);
  if (!stage) throw new Error(`no seeded stage of kind ${kind}`);
  return stage.name;
};

const IDEA = stageName('idea');
const PACKAGING = stageName('packaging');
const SCRIPTING = stageName('scripting');

/* -------------------------------------------------------------------------- */
/* The database, read directly                                                 */
/* -------------------------------------------------------------------------- */

let db: Client;

test.beforeAll(async () => {
  db = new Client({
    host: PG.host,
    port: PG.port,
    user: PG.user,
    password: PG.password === '' ? undefined : PG.password,
    database: PG.database,
  });
  await db.connect();
  await cleanUp();
});

test.afterAll(async () => {
  await cleanUp().catch(() => {});
  await db?.end();
});

/**
 * Put the account back to "the two channels the stack seeds", which is what
 * PLAN.md's M1 acceptance starts from: *log in, create two channels*.
 *
 * It removes **every** channel this suite has left behind, not only this file's
 * two, and that is the point. The sidebar binds `1`..`9` to the first nine
 * channels in `created_at` order, and the walk below retargets a capture with
 * `Alt`+the digit its second channel is drawn with. Every spec file in `e2e/`
 * owns a channel and recreates it rather than dropping it, so on a *second*
 * consecutive run against an unreset stack this file's two land tenth and
 * eleventh, there is no digit for them, and the walk fails with
 * `Unknown key: "Digit10"` — a failure about leftovers, in the one spec whose
 * job is to prove the product works. Every other file rebuilds its own channel
 * in `beforeEach`, so there is nothing here for them to lose.
 *
 * Videos first: `videos -> stages` is `on delete no action`, so clearing the
 * rows before the channel cascade keeps the delete order out of the picture.
 */
async function cleanUp(): Promise<void> {
  const seeded = [...SEED_CHANNELS];
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where name <> all($1::text[]))`,
    [seeded],
  );
  await db.query('delete from public.channels where name <> all($1::text[])', [
    seeded,
  ]);
}

interface VideoRow {
  id: string;
  title: string;
  channel_slug: string;
  stage_kind: string | null;
  stage_id: string;
  stage_entered_at: string;
  thumbnail_concept_path: string | null;
}

/** Every video this walk created, with the stage it is actually in. */
async function walkVideos(): Promise<VideoRow[]> {
  const result = await db.query<VideoRow>(
    `select v.id,
            v.title,
            c.slug as channel_slug,
            s.kind as stage_kind,
            v.stage_id,
            -- ::text so pg hands back the timestamp as a string: two Date
            -- objects for the same instant are not the same object, and the
            -- assertion this feeds is "nothing moved", not "close enough".
            v.stage_entered_at::text as stage_entered_at,
            v.thumbnail_concept_path
       from public.videos v
       join public.channels c on c.id = v.channel_id
       join public.stages   s on s.id = v.stage_id
      where c.slug like 'm1-acceptance-%'
      order by v.title`,
  );
  return result.rows;
}

async function videoTitled(title: string): Promise<VideoRow> {
  const rows = await walkVideos();
  const row = rows.find((candidate) => candidate.title === title);
  if (!row) throw new Error(`no video titled ${JSON.stringify(title)} in the walk`);
  return row;
}

/** A stage of the given kind in the given channel — the id a direct write needs. */
async function stageId(channelSlug: string, kind: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `select s.id from public.stages s
       join public.channels c on c.id = s.channel_id
      where c.slug = $1 and s.kind = $2`,
    [channelSlug, kind],
  );
  if (result.rows.length !== 1) {
    throw new Error(`expected one ${kind} stage in ${channelSlug}`);
  }
  return result.rows[0].id;
}

/** 1-based position of a channel in the sidebar's order (`created_at` asc). */
async function channelPosition(slug: string): Promise<number> {
  const result = await db.query<{ slug: string }>(
    'select slug from public.channels order by created_at asc',
  );
  const index = result.rows.findIndex((row) => row.slug === slug);
  if (index === -1) throw new Error(`no channel ${slug}`);
  return index + 1;
}

/* -------------------------------------------------------------------------- */
/* The app                                                                     */
/* -------------------------------------------------------------------------- */

async function signIn(page: Page): Promise<void> {
  await page.setViewportSize({ width: 2880, height: 1000 });
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/c\/[^/]+\/board$/);
}

async function openBoard(page: Page, slug: string): Promise<void> {
  await page.goto(`/c/${slug}/board`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
}

const column = (page: Page, name: string): Locator =>
  page.getByRole('region', { name, exact: true });

const cardsIn = (page: Page, name: string): Locator =>
  column(page, name).getByTestId('board-card');

const cardIn = (page: Page, name: string, title: string): Locator =>
  cardsIn(page, name).filter({ hasText: title });

/**
 * Select a card with the mouse without opening it: the card's own title is a
 * link, so a click in the middle of it is a navigation. The days-in-stage chip
 * is inert, and the click bubbles to the card, which is what selects it.
 */
async function selectCard(card: Locator): Promise<void> {
  await card.getByTestId('days-in-stage').click();
  await expect(card).toHaveAttribute('data-selected', 'true');
}

/** One toast, found by what it says — several can be on screen at once. */
const toastSaying = (page: Page, text: string | RegExp): Locator =>
  page.getByTestId('toast').filter({ hasText: text });

/**
 * Open the capture modal with the key, not the button.
 *
 * The binding is attached by an effect, so a press before hydration does
 * nothing; the sidebar's Capture button carries `data-shortcut-ready` once the
 * registry has it, which is the app saying "the key works now".
 */
async function pressCapture(page: Page): Promise<void> {
  await expect(
    page.locator('button[aria-keyshortcuts="c"][data-shortcut-ready="true"]'),
  ).toBeVisible();
  await page.keyboard.press('c');
  await expect(page.getByRole('dialog', { name: 'Capture an idea' })).toBeVisible();
}

/**
 * Capture one idea through the modal, optionally retargeting the channel first.
 *
 * Retargeting is Alt+digit, not a bare digit: inside the title field a digit is
 * always text, so "10 things I got wrong" is typeable and cannot be filed in a
 * channel nobody asked for.
 */
async function captureIdea(
  page: Page,
  title: string,
  options: { digit?: number } = {},
): Promise<void> {
  await pressCapture(page);
  if (options.digit !== undefined) {
    await page.keyboard.press(`Alt+Digit${options.digit}`);
  }
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Capture an idea' })).toHaveCount(0);
  await expect(toastSaying(page, `Captured “${title}”`)).toBeVisible();
}

/**
 * Drive a native HTML5 drag.
 *
 * `locator.dragTo()` synthesises mouse events, which do not start an HTML5
 * drag, so the three events the board listens for are dispatched by hand,
 * sharing one `DataTransfer` exactly as the browser would.
 */
async function dragCardTo(
  page: Page,
  card: Locator,
  targetColumn: string,
): Promise<void> {
  const dropzone = column(page, targetColumn).getByTestId('column-dropzone');
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent('dragstart', { dataTransfer });
  await dropzone.dispatchEvent('dragover', { dataTransfer });
  await dropzone.dispatchEvent('drop', { dataTransfer });
  await dataTransfer.dispose();
}

/**
 * Wait until no card on the board is mid-move.
 *
 * The board writes the optimistic position *before* the server answers, so a
 * card arriving in its new column proves the click landed and nothing more.
 * Navigating on that evidence aborts the in-flight server action — which is a
 * real thing a user can do, but it is not what these steps are about, and it
 * made this walk fail on a cold `next dev` where the first compile of a route
 * is seconds rather than milliseconds.
 *
 * `aria-busy` is the card's own report that the move is still on the wire, so
 * this is an extra assertion rather than a sleep: the board has to say it
 * finished.
 */
async function movesSettled(page: Page): Promise<void> {
  await expect(
    page.locator('[data-testid="board-card"][aria-busy="true"]'),
  ).toHaveCount(0);
}

async function createChannel(page: Page, name: string, slug: string): Promise<void> {
  await page.goto('/c/new');
  await page.getByLabel('Channel name').fill(name);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.waitForURL(`**/c/${slug}/board`);
}

/* -------------------------------------------------------------------------- */
/* 1. The walk                                                                 */
/* -------------------------------------------------------------------------- */

test('two channels, eight ideas, dragged, reloaded, and still there', async ({
  page,
}) => {
  await signIn(page);

  // ---- Two channels, made the way a person makes them.
  await createChannel(page, CHANNEL_A.name, CHANNEL_A.slug);
  await createChannel(page, CHANNEL_B.name, CHANNEL_B.slug);

  const digitB = await channelPosition(CHANNEL_B.slug);
  const digitA = await channelPosition(CHANNEL_A.slug);

  // ---- Eight ideas. Four typed into channel A's board, which is the channel
  // the route is about; four aimed at B — two of them from A's board using the
  // digit that retargets the capture, which is the case where getting the
  // channel wrong would be silent and expensive.
  await openBoard(page, CHANNEL_A.slug);
  for (const title of IDEAS_A) await captureIdea(page, title);

  for (const title of IDEAS_B.slice(0, 2)) {
    await captureIdea(page, title, { digit: digitB });
  }

  await openBoard(page, CHANNEL_B.slug);
  for (const title of IDEAS_B.slice(2)) await captureIdea(page, title);

  // ---- Eight rows, four per channel, every one of them in its own channel's
  // Idea stage. Read from Postgres: the modal closing is not evidence.
  const captured = await walkVideos();
  expect(captured).toHaveLength(8);
  expect(captured.every((row) => row.stage_kind === 'idea')).toBe(true);
  expect(
    captured.filter((row) => row.channel_slug === CHANNEL_A.slug).map((r) => r.title),
  ).toEqual([...IDEAS_A].sort());
  expect(
    captured.filter((row) => row.channel_slug === CHANNEL_B.slug).map((r) => r.title),
  ).toEqual([...IDEAS_B].sort());

  // ---- And on the boards: four cards each, in the Idea column.
  await openBoard(page, CHANNEL_A.slug);
  await expect(cardsIn(page, IDEA)).toHaveCount(4);
  await openBoard(page, CHANNEL_B.slug);
  await expect(cardsIn(page, IDEA)).toHaveCount(4);

  // ---- Drag. Idea -> Packaging is never gated; the gate guards what comes
  // after packaging.
  await dragCardTo(page, cardIn(page, IDEA, IDEAS_B[0]), PACKAGING);
  await expect(cardIn(page, PACKAGING, IDEAS_B[0])).toBeVisible();
  await movesSettled(page);

  await openBoard(page, CHANNEL_A.slug);
  await dragCardTo(page, cardIn(page, IDEA, IDEAS_A[0]), PACKAGING);
  await expect(cardIn(page, PACKAGING, IDEAS_A[0])).toBeVisible();
  // The keyboard path moves a second one, through the same RPC and gate.
  const second = cardIn(page, IDEA, IDEAS_A[1]);
  await selectCard(second);
  await page.keyboard.press(']');
  await expect(cardIn(page, PACKAGING, IDEAS_A[1])).toBeVisible();
  await movesSettled(page);

  // ---- Refresh. Both boards agree with themselves after a full reload…
  await openBoard(page, CHANNEL_A.slug);
  await expect(cardsIn(page, IDEA)).toHaveCount(2);
  await expect(cardsIn(page, PACKAGING)).toHaveCount(2);
  await openBoard(page, CHANNEL_B.slug);
  await expect(cardsIn(page, IDEA)).toHaveCount(3);
  await expect(cardIn(page, PACKAGING, IDEAS_B[0])).toBeVisible();

  // …and so does the database, which is what "persists" means.
  const moved = await walkVideos();
  const inPackaging = moved
    .filter((row) => row.stage_kind === 'packaging')
    .map((row) => row.title)
    .sort();
  expect(inPackaging).toEqual([IDEAS_A[0], IDEAS_A[1], IDEAS_B[0]].sort());
  expect(moved.filter((row) => row.stage_kind === 'idea')).toHaveLength(5);

  // `move_video` stamps `stage_entered_at`; a move that only happened in React
  // would have left the capture-time value behind.
  for (const row of moved.filter((r) => r.stage_kind === 'packaging')) {
    expect(Date.now() - Date.parse(row.stage_entered_at)).toBeLessThan(600_000);
  }

  // The digit that switches channel is drawn on the chip, so the shortcut is
  // discoverable rather than folklore.
  await expect(
    page.getByRole('link', { name: CHANNEL_A.name, exact: true }),
  ).toHaveAttribute('aria-keyshortcuts', String(digitA));
});

/* -------------------------------------------------------------------------- */
/* 2. The gate                                                                 */
/* -------------------------------------------------------------------------- */

test('dragging an idea past Packaging is refused, and nothing moves', async ({
  page,
}) => {
  await signIn(page);
  await openBoard(page, CHANNEL_A.slug);

  const title = IDEAS_A[2];
  const before = await videoTitled(title);
  expect(before.stage_kind).toBe('idea');

  // Scripting is one stage past Packaging in CORE_KIND_ORDER, and this idea has
  // a title and nothing else — no thumbnail concept, no chosen hook.
  await dragCardTo(page, cardIn(page, IDEA, title), SCRIPTING);

  // The refusal names the field the plpgsql function stopped on, and offers the
  // two ways out PLAN.md asks for.
  const toast = toastSaying(page, /thumbnail concept/i);
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute('data-tone', 'error');
  // Two links, and both land on something that exists: M2 restored the pair
  // PLAN.md asks for once there were fields to point at.
  await expect(toast.getByRole('link')).toHaveCount(2);
  await expect(toast.getByRole('link', { name: 'Fix packaging' })).toHaveAttribute(
    'href',
    /^\/videos\/[0-9a-f-]+#packaging-concept$/,
  );
  await expect(toast.getByRole('link', { name: /Skip gate/ })).toHaveAttribute(
    'href',
    /^\/videos\/[0-9a-f-]+#packaging-skip$/,
  );

  // Snapped back: not left sitting in the column the database refused.
  await expect(cardIn(page, IDEA, title)).toBeVisible();
  await expect(cardIn(page, SCRIPTING, title)).toHaveCount(0);

  await openBoard(page, CHANNEL_A.slug);
  await expect(cardIn(page, IDEA, title)).toBeVisible();

  const after = await videoTitled(title);
  expect(after.stage_kind).toBe('idea');
  expect(after.stage_id).toBe(before.stage_id);
  expect(after.stage_entered_at).toBe(before.stage_entered_at);

  // The same refusal reaches the keyboard path, because it is the same RPC.
  await selectCard(cardIn(page, IDEA, title));
  await page.keyboard.press(']');
  await expect(cardIn(page, PACKAGING, title)).toBeVisible(); // Idea -> Packaging: allowed
  // Wait for the move to *land*, not just to be drawn: the board applies a move
  // optimistically and refuses a second one for the same card while the first
  // is still in flight, so pressing again immediately would be dropped.
  await expect(page.getByTestId('board-announcer')).toContainText(
    `Moved “${title}” to ${PACKAGING}.`,
  );
  await page.keyboard.press(']'); // Packaging -> Scripting: gated
  await expect(toastSaying(page, /thumbnail concept/i)).toBeVisible();
  expect((await videoTitled(title)).stage_kind).toBe('packaging');
});

/* -------------------------------------------------------------------------- */
/* 3. The sketch                                                               */
/* -------------------------------------------------------------------------- */

test('a sketch uploaded on the detail page shows up on the board card', async ({
  page,
}) => {
  await signIn(page);

  const title = IDEAS_A[3];
  const video = await videoTitled(title);
  expect(video.thumbnail_concept_path).toBeNull();

  await page.goto(`/videos/${video.id}`);
  await expect(page.getByTestId('concept-sketch-frame')).toHaveAttribute(
    'data-has-sketch',
    'false',
  );

  await page.locator('input[type="file"]').setInputFiles(SKETCH);
  await expect(page.getByTestId('sketch-status')).toHaveText('Sketch saved');

  // The browser decoded real bytes from a real signed URL, at the size the
  // fixture generated.
  const image = page.getByTestId('concept-sketch-image');
  await expect(image).toBeVisible();
  expect(await image.getAttribute('src')).toContain(
    `${GATEWAY_URL}/storage/v1/object/sign/thumbnails/`,
  );
  await expect
    .poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBe(6);

  // The row names the object, at the stable path the convention gives it.
  const stored = await videoTitled(title);
  expect(stored.thumbnail_concept_path).toMatch(
    new RegExp(`^[0-9a-f-]{36}/${video.id}/concept\\.png$`),
  );
  const objects = await db.query<{ name: string }>(
    "select name from storage.objects where bucket_id = 'thumbnails' and name like $1",
    [`%/${video.id}/%`],
  );
  expect(objects.rows.map((row) => row.name)).toEqual([
    stored.thumbnail_concept_path,
  ]);

  // And on the card, from the board's one batched signing call.
  await openBoard(page, CHANNEL_A.slug);
  const card = page.getByTestId('board-card').filter({ hasText: title });
  await expect(card.locator('[data-slot="thumbnail-concept"]')).toHaveAttribute(
    'data-showing-sketch',
    'true',
  );
  await expect
    .poll(() =>
      card
        .getByTestId('card-sketch')
        .evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBe(6);
});

/* -------------------------------------------------------------------------- */
/* 4. The two revokes, from the browser                                        */
/* -------------------------------------------------------------------------- */

/**
 * What a client can do to `videos` with its own session, run inside the page.
 *
 * This is the review line M1 has to survive: *`update videos set stage_id` from
 * the browser client fails (revoke)*. Proving it in SQL proves the grant;
 * proving it here proves the grant is what a real browser, holding a real
 * session for a row it really owns, actually hits — PostgREST, the gateway and
 * RLS included.
 *
 * The control matters as much as the two refusals: the same token, in the same
 * request shape, writing a column the client *is* granted, has to succeed. Two
 * failures and no control would be equally consistent with a broken token.
 */
async function directWrites(
  page: Page,
  input: { videoId: string; channelId: string; targetStageId: string },
): Promise<{
  tokenOk: boolean;
  control: { status: number; body: string };
  stage: { status: number; body: string };
  insert: { status: number; body: string };
}> {
  return page.evaluate(
    async ({ gateway, anon, email, password, videoId, channelId, targetStageId }) => {
      const session = await fetch(`${gateway}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: anon, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const tokenOk = session.ok;
      const { access_token: token } = (await session.json()) as {
        access_token?: string;
      };

      const headers = {
        apikey: anon,
        Authorization: `Bearer ${token ?? ''}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      };

      async function attempt(
        url: string,
        method: string,
        body: unknown,
      ): Promise<{ status: number; body: string }> {
        const response = await fetch(url, {
          method,
          headers,
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.text() };
      }

      // 1. A column the client holds: this is the row, and this is a write the
      //    app itself makes. It must succeed, or the two refusals below prove
      //    nothing.
      //    `waiting_since` rides along because 0004_waiting_since.sql pairs the
      //    two with a CHECK — writing the text alone is a 400 from the
      //    constraint, which would look like a permission failure here and
      //    prove the opposite of what this control is for.
      const control = await attempt(
        `${gateway}/rest/v1/videos?id=eq.${videoId}`,
        'PATCH',
        {
          waiting_on: 'a direct write the client is allowed to make',
          waiting_since: new Date().toISOString(),
        },
      );
      // Put it back, so the fixture is unchanged for whatever runs next.
      await attempt(`${gateway}/rest/v1/videos?id=eq.${videoId}`, 'PATCH', {
        waiting_on: null,
        waiting_since: null,
      });

      // 2. The revoked column, on that same row.
      const stage = await attempt(
        `${gateway}/rest/v1/videos?id=eq.${videoId}`,
        'PATCH',
        { stage_id: targetStageId },
      );

      // 3. A direct INSERT — the other half of "the SQL functions are the only
      //    write path".
      const insert = await attempt(`${gateway}/rest/v1/videos`, 'POST', {
        channel_id: channelId,
        stage_id: targetStageId,
        title: 'Direct insert, from the browser',
      });

      return { tokenOk, control, stage, insert };
    },
    {
      gateway: GATEWAY_URL,
      anon: ANON_KEY,
      email: SEED_EMAIL,
      password: SEED_PASSWORD,
      videoId: input.videoId,
      channelId: input.channelId,
      targetStageId: input.targetStageId,
    },
  );
}

test('the browser cannot set stage_id, and cannot insert a video', async ({
  page,
}) => {
  await signIn(page);
  await openBoard(page, CHANNEL_A.slug);

  const video = await videoTitled(IDEAS_A[2]);
  const channel = await db.query<{ id: string }>(
    'select id from public.channels where slug = $1',
    [CHANNEL_A.slug],
  );
  const scripting = await stageId(CHANNEL_A.slug, 'scripting');

  const result = await directWrites(page, {
    videoId: video.id,
    channelId: channel.rows[0].id,
    targetStageId: scripting,
  });

  // The session is real and the row is writable — the control succeeded.
  expect(result.tokenOk).toBe(true);
  expect(result.control.status).toBeGreaterThanOrEqual(200);
  expect(result.control.status).toBeLessThan(300);

  // `UPDATE (stage_id)` is revoked: Postgres refuses, and says so.
  expect(result.stage.status).toBeGreaterThanOrEqual(400);
  expect(result.stage.body).toMatch(/permission denied|42501/i);

  // `INSERT` on videos is revoked outright, so `capture_video` is the only way
  // a video comes into existence.
  expect(result.insert.status).toBeGreaterThanOrEqual(400);
  expect(result.insert.body).toMatch(/permission denied|42501/i);

  // Neither attempt left a mark.
  const after = await videoTitled(IDEAS_A[2]);
  expect(after.stage_id).toBe(video.stage_id);
  expect(after.stage_entered_at).toBe(video.stage_entered_at);
  const invented = await db.query(
    "select id from public.videos where title = 'Direct insert, from the browser'",
  );
  expect(invented.rows).toHaveLength(0);
});

/* -------------------------------------------------------------------------- */
/* 5. One keyboard, on every route                                             */
/* -------------------------------------------------------------------------- */

test('the keyboard set is one set, and it only claims the keys that work', async ({
  page,
}) => {
  await signIn(page);
  await openBoard(page, CHANNEL_A.slug);

  // The hint bar is generated from the live registry, so this is the app
  // listing its own bindings rather than a paragraph somebody wrote once.
  const hints = page.getByTestId('shortcut-hints');
  await expect(hints).toContainText('capture');
  await expect(hints).toContainText('switch channel');
  await expect(hints).toContainText('select a card');
  await expect(hints).toContainText('move a stage');

  // `1..9` switches channel from anywhere signed in. Each hop waits for the
  // destination to have *arrived* — its own <h1> — and not merely for the URL
  // to have changed: `router.push` writes the URL first, so a URL check alone
  // lets the next key be pressed at a page that is still the old one.
  const digitB = await channelPosition(CHANNEL_B.slug);
  await page.keyboard.press(String(digitB));
  await page.waitForURL(`**/c/${CHANNEL_B.slug}/board`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(CHANNEL_B.name);

  const digitA = await channelPosition(CHANNEL_A.slug);
  await page.keyboard.press(String(digitA));
  await page.waitForURL(`**/c/${CHANNEL_A.slug}/board`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(CHANNEL_A.name);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');

  // …but never while typing. A digit in the capture field is a digit, and the
  // board keys behind the dialog are inert while it is open.
  await pressCapture(page);
  const field = page.getByRole('dialog').getByLabel('Idea');
  await field.fill('Ten');
  await page.keyboard.type('10 things');
  await expect(field).toHaveValue('Ten10 things');
  await page.keyboard.press('j');
  await expect(field).toHaveValue('Ten10 thingsj');
  expect(page.url()).toContain(`/c/${CHANNEL_A.slug}/board`);

  // Escape closes the dialog and writes nothing.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await walkVideos()).filter((row) => row.title.includes('10 things'))).toEqual(
    [],
  );

  // j selects, Escape clears the selection rather than doing nothing visible.
  await page.keyboard.press('j');
  const selected = page.locator('[data-testid="board-card"][data-selected="true"]');
  await expect(selected).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(
    page.locator('[data-testid="board-card"][data-selected="true"]'),
  ).toHaveCount(0);

  // On a route with no board, the board's keys are not advertised and pressing
  // them does nothing at all — no navigation, no error, no overlay.
  const video = await videoTitled(IDEAS_A[3]);
  await page.goto(`/videos/${video.id}`);
  await expect(page.getByTestId('shortcut-hints')).toContainText('capture');
  await expect(page.getByTestId('shortcut-hints')).not.toContainText('select a card');
  await expect(page.getByTestId('shortcut-hints')).not.toContainText('move a stage');

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const key of ['j', 'k', '[', ']', 'Enter', 'Escape']) {
    await page.keyboard.press(key);
  }
  expect(errors).toEqual([]);
  expect(page.url()).toContain(`/videos/${video.id}`);

  // And `c` still works here, because it is bound by the sidebar, not the board.
  await pressCapture(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
