import { expect, test, type Locator, type Page } from '@playwright/test';
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
 * M1 — the pipeline board.
 *
 * Everything here drives the real application in a real browser against the
 * real PostgREST + RLS stack (`scripts/dev-stack`). Nothing about the board is
 * stubbed: a drag calls the `move_video` RPC through the `moveVideo` server
 * action, and when the gate refuses, the refusal comes out of plpgsql.
 *
 * ## The fixture
 *
 * Two throwaway channels are built before each test, through the same
 * `create_channel` / `capture_video` / `move_video` functions the app calls,
 * over a connection with `set local role authenticated` and
 * `request.jwt.claims` set — so RLS and the column grants apply exactly as they
 * do to a request. A seed that used plain superuser INSERTs could produce a
 * board state the app itself can never reach (a video past the gate, say), and
 * would then prove nothing about the gate.
 *
 * The one thing done with full privilege is back-dating `stage_entered_at` and
 * `updated_at`. `UPDATE (stage_entered_at)` is revoked from clients on purpose,
 * and `now()` inside one transaction is one value for every row in it — so
 * without back-dating there is no "in this stage for 20 days" to test staleness
 * with and no deterministic order for the cards that share a target date.
 *
 * | Channel     | Column     | Cards                                            |
 * |-------------|------------|--------------------------------------------------|
 * | M1 Board A  | Idea       | 12 — the column caps at 10 and counts the rest     |
 * |             | Packaging  | "Gate blocked": a title and nothing else           |
 * |             | Scripting  | 6 — one over the default WIP threshold of 5        |
 * |             | Filming    | 2                                                  |
 * | M1 Board B  | Packaging  | "Keyboard mover": packaging complete               |
 * |             | Filming    | 1                                                  |
 *
 * Filming therefore holds 3 across the two channels while neither channel has
 * 3 of its own — which is what makes the batch-day badge a cross-channel test
 * rather than a per-column one.
 */

const CHANNEL_A = { name: 'M1 Board A', slug: 'm1-board-a' };
const CHANNEL_B = { name: 'M1 Board B', slug: 'm1-board-b' };

/** `channels.wip_threshold` / `stale_days` for both fixture channels. */
const WIP_THRESHOLD = CHANNEL_DEFAULTS.wip_threshold; // 5
const STALE_DAYS = CHANNEL_DEFAULTS.stale_days; // 7

const stageName = (kind: string): string => {
  const stage = SEED_STAGES.find((candidate) => candidate.kind === kind);
  if (!stage) throw new Error(`no seeded stage of kind ${kind}`);
  return stage.name;
};

const IDEA = stageName('idea');
const PACKAGING = stageName('packaging');
const SCRIPTING = stageName('scripting');
const FILMING = stageName('filming');

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

let db: pg.Client;
let userId: string;

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
  await resetFixture();
});

/** Run `fn` as the signed-in user, the way a PostgREST request runs. */
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
        JSON.stringify(SEED_BUCKETS.map((b) => ({ ...b, monthly_quota: null }))),
      ],
    );
    return result.rows[0].id;
  });
}

/** `capture_video` — the only client path to a new video, always into Idea. */
async function capture(channelId: string, title: string): Promise<string> {
  return asUser(async () => {
    const result = await db.query<{ id: string }>(
      'select id from capture_video($1::uuid, $2::text)',
      [channelId, title],
    );
    return result.rows[0].id;
  });
}

/** Fill the three gate fields, as a client legitimately can. */
async function completePackaging(videoId: string): Promise<void> {
  await asUser(async () => {
    await db.query(
      `update public.videos
          set thumbnail_concept = 'Face left, three props on the desk',
              hooks = $2::jsonb,
              updated_at = now()
        where id = $1`,
      [
        videoId,
        JSON.stringify([{ id: 'h1', text: 'The first ten seconds', chosen: true }]),
      ],
    );
  });
}

async function moveTo(videoId: string, channelId: string, kind: string): Promise<void> {
  await asUser(async () => {
    await db.query(
      `select move_video($1::uuid,
                         (select id from public.stages
                           where channel_id = $2::uuid and kind = $3::text))`,
      [videoId, channelId, kind],
    );
  });
}

/**
 * Back-date a card. Superuser, because `UPDATE (stage_entered_at)` is revoked
 * from clients — see the header comment.
 */
async function backdate(
  videoId: string,
  options: { stageDays?: number; updatedMinutes?: number; targetDate?: string },
): Promise<void> {
  await db.query(
    `update public.videos
        set stage_entered_at    = coalesce($2::timestamptz, stage_entered_at),
            updated_at          = coalesce($3::timestamptz, updated_at),
            target_publish_date = coalesce($4::date, target_publish_date)
      where id = $1`,
    [
      videoId,
      options.stageDays === undefined
        ? null
        : new Date(Date.now() - options.stageDays * 86_400_000).toISOString(),
      options.updatedMinutes === undefined
        ? null
        : new Date(Date.now() - options.updatedMinutes * 60_000).toISOString(),
      options.targetDate ?? null,
    ],
  );
}

async function resetFixture(): Promise<void> {
  // Videos first: videos -> stages is `on delete no action`, so clearing the
  // rows before the channel cascade keeps the delete order out of the picture.
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug like 'm1-board-%')`,
  );
  await db.query("delete from public.channels where slug like 'm1-board-%'");

  const channelA = await createChannel(CHANNEL_A.name, CHANNEL_A.slug);
  const channelB = await createChannel(CHANNEL_B.name, CHANNEL_B.slug);

  // ---- Channel A: twelve ideas. "Idea 01" is the most recently updated, so
  // the ten the column renders are 01..10 and the count says twelve.
  for (let n = 1; n <= 12; n += 1) {
    const id = await capture(channelA, `Idea ${String(n).padStart(2, '0')}`);
    await backdate(id, { updatedMinutes: n, stageDays: n });
  }

  // ---- Channel A: the gate fixture. A title (capture_video sets it) and
  // nothing else, so the first missing field is the thumbnail concept.
  const blocked = await capture(channelA, 'Gate blocked');
  await moveTo(blocked, channelA, 'packaging');
  await backdate(blocked, { stageDays: 2 });

  // ---- Channel A: six in Scripting, one over the WIP threshold of five.
  // Two carry target dates, which is what the sort is checked against; one is
  // three weeks stale.
  for (let n = 1; n <= 6; n += 1) {
    const id = await capture(channelA, `Script ${n}`);
    await completePackaging(id);
    await moveTo(id, channelA, 'scripting');
    await backdate(id, {
      // Script 3 is three weeks stale and the rest get older as they were
      // captured later, so the undated cards come out in the reverse of
      // creation order — a sort, not an accident of insertion.
      stageDays: n === 3 ? 21 : n,
      ...(n === 1 ? { targetDate: '2026-01-10' } : {}),
      ...(n === 2 ? { targetDate: '2026-01-05' } : {}),
    });
  }

  // ---- Channel A: two in Filming.
  for (const title of ['Film A1', 'Film A2']) {
    const id = await capture(channelA, title);
    await completePackaging(id);
    await moveTo(id, channelA, 'filming');
  }

  // ---- Channel B: the keyboard fixture, plus the third Filming card.
  const keyboard = await capture(channelB, 'Keyboard mover');
  await completePackaging(keyboard);
  await moveTo(keyboard, channelB, 'packaging');

  const filmB = await capture(channelB, 'Film B1');
  await completePackaging(filmB);
  await moveTo(filmB, channelB, 'filming');
}

/* -------------------------------------------------------------------------- */
/* Browser helpers                                                             */
/* -------------------------------------------------------------------------- */

async function signInAndOpen(page: Page, slug: string): Promise<void> {
  await page.setViewportSize({ width: 2880, height: 1000 });
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/c\/[^/]+\/board$/);
  await openBoard(page, slug);
}

/**
 * Open a board and wait until it can actually be used.
 *
 * The columns and cards are server-rendered, so they are on screen before the
 * board has hydrated — and until it has, a drag, a move button and `j` all do
 * nothing. Asserting on a visible column and then pressing a key is the flake
 * this avoids: `data-ready` is set by the board's own mount effect.
 */
async function openBoard(page: Page, slug: string): Promise<void> {
  await page.goto(`/c/${slug}/board`);
  await waitForBoardReady(page);
}

async function waitForBoardReady(page: Page): Promise<void> {
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
}

const column = (page: Page, name: string): Locator =>
  page.getByRole('region', { name, exact: true });

const cardsIn = (page: Page, name: string): Locator =>
  column(page, name).getByTestId('board-card');

const cardIn = (page: Page, name: string, title: string): Locator =>
  cardsIn(page, name).filter({ hasText: title });

/**
 * Drive a native HTML5 drag.
 *
 * `locator.dragTo()` synthesises mouse events, which do not start an HTML5
 * drag, so the three events the board actually listens for are dispatched by
 * hand — sharing one `DataTransfer`, exactly as the browser would.
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

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

test('cards render in the right columns, capped and sorted', async ({ page }) => {
  await signInAndOpen(page, CHANNEL_A.slug);

  // The Idea column: twelve ideas, ten rendered, the rest counted. The badge
  // carries both the number that is drawn and the words a screen reader hears,
  // so both are checked.
  const ideaCount = column(page, IDEA).getByTestId('column-count');
  await expect(ideaCount).toContainText('12 videos');
  await expect(ideaCount.locator('[aria-hidden="true"]')).toHaveText('12');
  await expect(cardsIn(page, IDEA)).toHaveCount(10);
  await expect(column(page, IDEA).getByTestId('idea-overflow')).toHaveText(
    '+2 more in Ideas',
  );
  // The ten shown are the ten most recently updated.
  await expect(cardIn(page, IDEA, 'Idea 01')).toBeVisible();
  await expect(cardIn(page, IDEA, 'Idea 11')).toHaveCount(0);
  await expect(cardIn(page, IDEA, 'Idea 12')).toHaveCount(0);

  // Every other column holds exactly what the fixture put in it.
  await expect(cardsIn(page, PACKAGING)).toHaveCount(1);
  await expect(cardIn(page, PACKAGING, 'Gate blocked')).toBeVisible();
  await expect(cardsIn(page, SCRIPTING)).toHaveCount(6);
  await expect(cardsIn(page, FILMING)).toHaveCount(2);

  // target_publish_date asc nulls last, then stage_entered_at asc. Script 2
  // (5 Jan) then Script 1 (10 Jan) come first even though they were captured
  // first; the undated four follow oldest-entered first — which is Script 3
  // (21 days), then 6, 5, 4.
  await expect(cardsIn(page, SCRIPTING).locator('h3')).toHaveText([
    'Script 2',
    'Script 1',
    'Script 3',
    'Script 6',
    'Script 5',
    'Script 4',
  ]);

  // Days in stage, with the stale treatment past channels.stale_days.
  await expect(
    cardIn(page, SCRIPTING, 'Script 3').getByTestId('days-in-stage'),
  ).toHaveText(`Stale · 21 days in stage`);
  await expect(cardIn(page, SCRIPTING, 'Script 3')).toHaveAttribute(
    'data-stale',
    'true',
  );
  // Script 1 entered yesterday, well inside the seven-day mark.
  expect(STALE_DAYS).toBe(7);
  await expect(cardIn(page, SCRIPTING, 'Script 1')).toHaveAttribute(
    'data-stale',
    'false',
  );

  // The card face: channel chip, target date, and the two slots that are
  // deliberately empty rather than faked.
  const dated = cardIn(page, SCRIPTING, 'Script 2');
  await expect(dated).toContainText(CHANNEL_A.name);
  await expect(dated.getByTestId('target-date')).toContainText('5 Jan');
  await expect(dated.locator('[data-slot="thumbnail-concept"]')).toHaveCount(1);
  // The checklist ratio is M3 and nothing stands in for it — not even an empty
  // element. A card must never show "0/0", which reads as "nothing to do".
  await expect(dated.locator('[data-slot="checklist-ratio"]')).toHaveCount(0);
  await expect(dated).not.toContainText('0/0');
});

test('the WIP warning fires past the threshold and never on Idea', async ({
  page,
}) => {
  await signInAndOpen(page, CHANNEL_A.slug);

  expect(WIP_THRESHOLD).toBe(5);

  // Scripting holds six, one over the threshold.
  await expect(column(page, SCRIPTING)).toHaveAttribute('data-wip-warning', 'true');
  await expect(column(page, SCRIPTING).getByTestId('wip-warning')).toContainText(
    'Over WIP',
  );

  // Idea holds twelve — more than double the threshold — and must stay calm:
  // the bank is not a bottleneck, and a board that cries wolf there teaches its
  // one user to ignore the colour everywhere else.
  await expect(column(page, IDEA)).toHaveAttribute('data-wip-warning', 'false');
  await expect(column(page, IDEA).getByTestId('wip-warning')).toHaveCount(0);

  // Nor do the terminal columns, whatever they hold.
  for (const name of ['Published', 'Repurposed']) {
    await expect(column(page, name)).toHaveAttribute('data-wip-warning', 'false');
  }

  // And an in-flight column under the threshold is not warned either.
  await expect(column(page, FILMING)).toHaveAttribute('data-wip-warning', 'false');
});

test('the Filming badge counts across all channels and appears at three', async ({
  page,
}) => {
  await signInAndOpen(page, CHANNEL_A.slug);

  // Channel A has two of the three. The badge still says three, because there
  // is one creator and one camera — and it says *where the three are*, because
  // the column's own count badge directly above it says two and two numbers
  // that disagree with no explanation read as a miscount.
  await expect(cardsIn(page, FILMING)).toHaveCount(2);
  await expect(column(page, FILMING).getByTestId('filming-badge')).toHaveText(
    '3 in Filming across all channels — schedule batch day?',
  );

  // The same badge is on the other channel's board, which holds the third.
  await openBoard(page, CHANNEL_B.slug);
  await expect(cardsIn(page, FILMING)).toHaveCount(1);
  await expect(column(page, FILMING).getByTestId('filming-badge')).toHaveText(
    '3 in Filming across all channels — schedule batch day?',
  );

  // Drop below three and it goes: move the one in channel B forward to Editing.
  await dragCardTo(page, cardIn(page, FILMING, 'Film B1'), 'Editing');
  await expect(cardIn(page, 'Editing', 'Film B1')).toBeVisible();
  await expect(column(page, FILMING).getByTestId('filming-badge')).toHaveCount(0);
});

test('dragging an idea into Packaging moves it, and it survives a reload', async ({
  page,
}) => {
  await signInAndOpen(page, CHANNEL_A.slug);

  await expect(cardIn(page, IDEA, 'Idea 01')).toBeVisible();
  await expect(cardsIn(page, PACKAGING)).toHaveCount(1);

  await dragCardTo(page, cardIn(page, IDEA, 'Idea 01'), PACKAGING);

  // Idea -> Packaging is never gated: the gate guards the stages *after*
  // packaging.
  await expect(cardIn(page, PACKAGING, 'Idea 01')).toBeVisible();
  await expect(cardIn(page, IDEA, 'Idea 01')).toHaveCount(0);
  await expect(cardsIn(page, PACKAGING)).toHaveCount(2);
  await expect(page.getByTestId('toast')).toHaveCount(0);

  // No full reload was needed to see that; and a real one agrees, so the RPC
  // wrote it rather than the board pretending.
  await page.reload();
  await waitForBoardReady(page);
  await expect(cardIn(page, PACKAGING, 'Idea 01')).toBeVisible();
  await expect(cardIn(page, IDEA, 'Idea 01')).toHaveCount(0);

  // The card is fresh in its new column.
  await expect(
    cardIn(page, PACKAGING, 'Idea 01').getByTestId('days-in-stage'),
  ).toHaveText('today in stage');
});

test('a gated drag is refused, the card snaps back, and the toast names the missing field', async ({
  page,
}) => {
  await signInAndOpen(page, CHANNEL_A.slug);

  const blocked = cardIn(page, PACKAGING, 'Gate blocked');
  await expect(blocked).toBeVisible();
  await expect(cardsIn(page, SCRIPTING)).toHaveCount(6);

  await dragCardTo(page, blocked, SCRIPTING);

  // The toast names what is missing — not "could not move".
  const toast = page.getByTestId('toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(/thumbnail concept/i);
  await expect(toast).toContainText('Gate blocked');
  // PLAN.md wants "Fix packaging" and "Skip gate…" out of a refusal. M1 shipped
  // neither, on purpose: both fragments pointed at a page that had no packaging
  // fields on it. M2 builds the block, so the pair is restored — and "Fix
  // packaging" carries the anchor of the field the database actually stopped
  // on, which here is the written concept.
  const fixLink = toast.getByRole('link', { name: 'Fix packaging' });
  const skipLink = toast.getByRole('link', { name: /Skip gate/ });
  await expect(fixLink).toBeVisible();
  await expect(skipLink).toBeVisible();
  await expect(fixLink).toHaveAttribute(
    'href',
    /^\/videos\/[0-9a-f-]+#packaging-concept$/,
  );
  await expect(skipLink).toHaveAttribute(
    'href',
    /^\/videos\/[0-9a-f-]+#packaging-skip$/,
  );

  // Snapped back: it is in Packaging, it is not in Scripting, and Scripting is
  // the size it was.
  await expect(cardIn(page, PACKAGING, 'Gate blocked')).toBeVisible();
  await expect(cardIn(page, SCRIPTING, 'Gate blocked')).toHaveCount(0);
  await expect(cardsIn(page, SCRIPTING)).toHaveCount(6);

  // And the database never moved it, so a reload agrees.
  await page.reload();
  await waitForBoardReady(page);
  await expect(cardIn(page, PACKAGING, 'Gate blocked')).toBeVisible();
  await expect(cardIn(page, SCRIPTING, 'Gate blocked')).toHaveCount(0);
});

test('the same gate refuses the keyboard move, on a video with no packaging', async ({
  page,
}) => {
  await signInAndOpen(page, CHANNEL_A.slug);

  // Select "Gate blocked" with j/k rather than the mouse: it is the eleventh
  // card in board order (ten ideas, then Packaging's one).
  await page.keyboard.press('j');
  for (let n = 0; n < 10; n += 1) await page.keyboard.press('j');

  const blocked = cardIn(page, PACKAGING, 'Gate blocked');
  await expect(blocked).toHaveAttribute('data-selected', 'true');

  await page.keyboard.press(']');

  await expect(page.getByTestId('toast')).toContainText(/thumbnail concept/i);
  await expect(cardIn(page, PACKAGING, 'Gate blocked')).toBeVisible();
  await expect(cardIn(page, SCRIPTING, 'Gate blocked')).toHaveCount(0);
});

test('] moves the selected card forward and [ moves it back', async ({ page }) => {
  await signInAndOpen(page, CHANNEL_B.slug);

  // Channel B's Idea column is empty, so the first card `j` reaches is the one
  // in Packaging.
  await expect(cardsIn(page, IDEA)).toHaveCount(0);
  await page.keyboard.press('j');

  const selected = cardIn(page, PACKAGING, 'Keyboard mover');
  await expect(selected).toHaveAttribute('data-selected', 'true');
  // The selection is announced, so this works without looking at the screen.
  await expect(page.getByTestId('board-announcer')).toContainText(
    `Keyboard mover, in ${PACKAGING}`,
  );

  // Forward by CORE_KIND_ORDER — the same RPC and the same gate as the drag.
  await page.keyboard.press(']');
  await expect(cardIn(page, SCRIPTING, 'Keyboard mover')).toBeVisible();
  await expect(cardIn(page, PACKAGING, 'Keyboard mover')).toHaveCount(0);
  await expect(page.getByTestId('board-announcer')).toContainText(
    `Moved “Keyboard mover” to ${SCRIPTING}.`,
  );
  await expect(page.getByTestId('toast')).toHaveCount(0);

  // And back.
  await page.keyboard.press('[');
  await expect(cardIn(page, PACKAGING, 'Keyboard mover')).toBeVisible();
  await expect(cardIn(page, SCRIPTING, 'Keyboard mover')).toHaveCount(0);

  // Both writes reached the database.
  await page.reload();
  await waitForBoardReady(page);
  await expect(cardIn(page, PACKAGING, 'Keyboard mover')).toBeVisible();
});

test('every card carries move buttons, so drag is not the only way', async ({
  page,
}) => {
  await signInAndOpen(page, CHANNEL_B.slug);

  const card = cardIn(page, PACKAGING, 'Keyboard mover');

  // The affordance is a real button with a real name, not a div with a key
  // handler — this is what a screen-reader user gets.
  const forward = card.getByRole('button', {
    name: `Move “Keyboard mover” forward to ${SCRIPTING}`,
  });
  await expect(forward).toBeEnabled();
  await forward.click();

  await expect(cardIn(page, SCRIPTING, 'Keyboard mover')).toBeVisible();

  const back = cardIn(page, SCRIPTING, 'Keyboard mover').getByRole('button', {
    name: `Move “Keyboard mover” back to ${PACKAGING}`,
  });
  await back.click();
  await expect(cardIn(page, PACKAGING, 'Keyboard mover')).toBeVisible();
});

test('Enter opens the selected card', async ({ page }) => {
  await signInAndOpen(page, CHANNEL_B.slug);

  await page.keyboard.press('j');
  const card = cardIn(page, PACKAGING, 'Keyboard mover');
  await expect(card).toHaveAttribute('data-selected', 'true');

  const videoId = await card.getAttribute('data-video-id');
  expect(videoId).toBeTruthy();

  await page.keyboard.press('Enter');
  // The detail page itself is another agent's M1 work; what the board owes is
  // the navigation.
  await page.waitForURL(`**/videos/${videoId}`);
});

/* -------------------------------------------------------------------------- */
/* What happens when the move does not reach the database                      */
/* -------------------------------------------------------------------------- */

test('a move the server never answers snaps back, says so, and the card still moves afterwards', async ({
  page,
}) => {
  await signInAndOpen(page, CHANNEL_B.slug);

  const card = cardIn(page, PACKAGING, 'Keyboard mover');
  await expect(card).toBeVisible();

  // Every server-action POST to this board fails to connect. A `moveVideo`
  // call that rejects used to abort `requestMove` before the snap-back and
  // before `pending` was cleared: the card stayed drawn in a column the
  // database never accepted, marked "Moving…", with both buttons disabled for
  // the life of the page, and nothing was said.
  const boardUrl = `**/c/${CHANNEL_B.slug}/board`;
  await page.route(boardUrl, (route) =>
    route.request().method() === 'POST' ? route.abort('failed') : route.fallback(),
  );

  await page.keyboard.press('j');
  await expect(card).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press(']');

  // Said out loud, in the toast and in the live region.
  const toast = page.getByTestId('toast');
  await expect(toast).toContainText(/could not be reached/i);
  await expect(toast).toContainText('Keyboard mover');
  await expect(page.getByTestId('board-announcer')).toContainText(
    /could not be reached/i,
  );

  // Snapped back to where the database still has it, and no longer busy.
  const settled = cardIn(page, PACKAGING, 'Keyboard mover');
  await expect(settled).toBeVisible();
  await expect(cardIn(page, SCRIPTING, 'Keyboard mover')).toHaveCount(0);
  await expect(settled).not.toHaveAttribute('aria-busy', 'true');
  await expect(settled).not.toContainText('Moving…');
  await expect(
    settled.getByRole('button', {
      name: `Move “Keyboard mover” forward to ${SCRIPTING}`,
    }),
  ).toBeEnabled();

  // The database never moved it.
  const row = await db.query<{ kind: string }>(
    `select s.kind from public.videos v
       join public.stages s on s.id = v.stage_id
      where v.title = 'Keyboard mover'`,
  );
  expect(row.rows[0].kind).toBe('packaging');

  // With the network back, the same card moves — the failure left nothing
  // stuck behind it.
  await page.unroute(boardUrl);
  await page.keyboard.press(']');
  await expect(cardIn(page, SCRIPTING, 'Keyboard mover')).toBeVisible();
});

test('a drop on the column header is a drop on the column', async ({ page }) => {
  await signInAndOpen(page, CHANNEL_A.slug);

  const card = cardIn(page, IDEA, 'Idea 01');
  await expect(card).toBeVisible();

  // The header is the column's name, count and badges — 38px of a column the
  // user is quite reasonably aiming at. It used to swallow the drop silently:
  // no move, no toast, not even the drop-target highlight.
  const header = column(page, PACKAGING).locator('header');
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent('dragstart', { dataTransfer });
  await header.dispatchEvent('dragover', { dataTransfer });
  await header.dispatchEvent('drop', { dataTransfer });
  await dataTransfer.dispose();

  await expect(cardIn(page, PACKAGING, 'Idea 01')).toBeVisible();
  await expect(cardIn(page, IDEA, 'Idea 01')).toHaveCount(0);
});

test('a held ] is one move, not four', async ({ page }) => {
  await signInAndOpen(page, CHANNEL_A.slug);

  // Count the server-action POSTs this board makes.
  let posts = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().includes(`/c/${CHANNEL_A.slug}/board`)
    ) {
      posts += 1;
    }
  });

  // "Gate blocked" is the eleventh card in board order: ten ideas, then
  // Packaging's one. Every `]` on it is refused by the gate, so each attempt
  // that gets out is one POST and one toast.
  await page.keyboard.press('j');
  for (let n = 0; n < 10; n += 1) await page.keyboard.press('j');
  await expect(cardIn(page, PACKAGING, 'Gate blocked')).toHaveAttribute(
    'data-selected',
    'true',
  );

  // Real OS key auto-repeat, which is the case the closure-read guard missed:
  // the repeats arrive long before React has committed the previous
  // `setPending`.
  const cdp = await page.context().newCDPSession(page);
  for (let n = 0; n < 4; n += 1) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: ']',
      code: 'BracketRight',
      windowsVirtualKeyCode: 221,
      nativeVirtualKeyCode: 221,
      autoRepeat: n > 0,
    });
    await page.waitForTimeout(30);
  }
  await cdp.detach();

  await expect(page.getByTestId('toast')).toHaveCount(1);
  await page.waitForTimeout(500);
  expect(posts, 'a held key must not put four move_video calls on the wire').toBe(1);
});

test('focus survives a move, by keyboard and by the on-card button', async ({
  page,
}) => {
  await signInAndOpen(page, CHANNEL_B.slug);

  const describeFocus = () =>
    page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return { tag: 'none', card: null as string | null, move: null };
      return {
        tag: active.tagName,
        card:
          active.closest('[data-testid="board-card"]')?.getAttribute('data-video-id') ??
          null,
        move: active.getAttribute('data-move'),
      };
    });

  // Keyboard: `j` selects and focuses the card; `]` moves it. The card's DOM
  // node is re-created inside the other column, so without putting focus back
  // it lands on <body> and the next Tab restarts from the top of the page.
  await page.keyboard.press('j');
  const selected = cardIn(page, PACKAGING, 'Keyboard mover');
  const videoId = await selected.getAttribute('data-video-id');
  expect((await describeFocus()).card).toBe(videoId);

  await page.keyboard.press(']');
  await expect(cardIn(page, SCRIPTING, 'Keyboard mover')).toBeVisible();
  await expect.poll(async () => (await describeFocus()).card).toBe(videoId);

  // The button path: focus ends on the same button, on the card in its new
  // column, so a second click moves it again without re-finding anything.
  const back = cardIn(page, SCRIPTING, 'Keyboard mover').getByRole('button', {
    name: `Move “Keyboard mover” back to ${PACKAGING}`,
  });
  await back.click();
  await expect(cardIn(page, PACKAGING, 'Keyboard mover')).toBeVisible();
  await expect.poll(async () => await describeFocus()).toMatchObject({
    tag: 'BUTTON',
    card: videoId,
    move: 'back',
  });
});
