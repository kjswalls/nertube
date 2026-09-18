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
 * M2 — the packaging block.
 *
 * BRIEF.md principle 1 says packaging is decided before scripting and filming,
 * that it is about a fifth of the effort for most of the result, and that the
 * tool has to make skipping it structurally awkward. This file drives that
 * claim through the real application against the real PostgREST + RLS stack:
 * nothing is stubbed, every save goes through the `updateVideo` server action,
 * and every browser assertion that matters is paired with a read of the row it
 * is supposed to have written.
 *
 * ## The assertion that is the point of the whole file
 *
 * "The indicator says ready" is worth very little on its own — what matters is
 * that it says ready *exactly when `move_video` would agree*. So the gate walk
 * below does not stop at the green line: it calls `move_video` over SQL, as the
 * signed-in user, and checks that the function allows the move the indicator
 * promised, then clears a field and checks that the same function refuses with
 * the same field the indicator now names. One predicate in `lib/packaging.ts`,
 * one gate block in plpgsql, and this is what holds them together.
 */

const CHANNEL = { name: 'M2 Packaging', slug: 'm2-packaging' };

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
  // Rebuilt per test so a failed run cannot leave a half-packaged video behind
  // for the next one — these specs are about the exact contents of two jsonb
  // columns, so a stale row is not a cosmetic problem.
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug = $1)`,
    [CHANNEL.slug],
  );
  await db.query('delete from public.channels where slug = $1', [CHANNEL.slug]);
  channelId = await createChannel(CHANNEL.name, CHANNEL.slug);
});

/**
 * Run `fn` as the signed-in user, the way a PostgREST request runs it: RLS on,
 * the column grants applied, `auth.uid()` answering. A fixture built with
 * superuser INSERTs could produce rows the app itself can never reach, and
 * would then prove nothing about the gate.
 */
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

interface PackagingRow {
  title: string;
  thumbnail_concept: string | null;
  title_candidates: { id: string; text: string; note?: string; chosen?: boolean; source?: string }[];
  hooks: { id: string; text: string; chosen?: boolean }[];
  packaging_skipped_at: string | null;
  packaging_skip_reason: string | null;
}

async function readRow(videoId: string): Promise<PackagingRow> {
  const result = await db.query<PackagingRow>(
    `select title, thumbnail_concept, title_candidates, hooks,
            packaging_skipped_at, packaging_skip_reason
       from public.videos where id = $1`,
    [videoId],
  );
  return result.rows[0];
}

/**
 * `move_video` as the client calls it. Returns the error message when the
 * function refuses, so the gate refusal can be compared with what the page
 * predicted.
 */
async function tryMove(videoId: string, kind: string): Promise<string | null> {
  try {
    await asUser(async () => {
      await db.query(
        `select move_video($1::uuid,
                           (select id from public.stages
                             where channel_id = $2::uuid and kind = $3::text))`,
        [videoId, channelId, kind],
      );
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Browser helpers                                                             */
/* -------------------------------------------------------------------------- */

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

const saveStatus = (page: Page): Locator => page.getByTestId('packaging-save-status');
const gate = (page: Page): Locator => page.getByTestId('gate-indicator');

/** Every assertion about the database is made after the page says it saved. */
async function expectSaved(page: Page): Promise<void> {
  await expect(saveStatus(page)).toHaveText(/^Saved$/);
}

/* -------------------------------------------------------------------------- */
/* 1. The gate                                                                 */
/* -------------------------------------------------------------------------- */

test('filling the three gate fields turns the indicator to ready, and move_video agrees', async ({
  page,
}) => {
  const videoId = await capture('Gate walk');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  const title = page.getByTestId('working-title');
  const concept = page.getByTestId('thumbnail-concept');

  // `capture_video` sets the title, so the first thing missing is the written
  // concept — and the wording is the one the board's refusal uses, because the
  // sketch upload on this very page is the thing it is not.
  await expect(gate(page)).toHaveAttribute('data-gate', 'thumbnail_concept');
  await expect(gate(page)).toContainText('the sketch is not it');

  // Clear the title: the indicator has to fall back to the first field in
  // `move_video`'s elsif chain, not list everything that is missing.
  await title.fill('');
  await title.press('Enter');
  await expectSaved(page);
  await expect(gate(page)).toHaveAttribute('data-gate', 'title');
  await expect(gate(page)).toHaveText(/needs a working title/);

  await title.fill('How I edit ten videos a week');
  await title.press('Enter');
  await expectSaved(page);
  await expect(gate(page)).toHaveAttribute('data-gate', 'thumbnail_concept');

  await concept.fill('Face left, shocked, three props on the desk, big yellow 3');
  await concept.blur();
  await expectSaved(page);
  // Two hooks written, none chosen yet: the count is what the gate reads, and
  // "wrote some hooks" is not "picked one".
  await expect(gate(page)).toHaveAttribute('data-gate', 'hook');
  await expect(gate(page)).toContainText('none is chosen yet');

  const hookInput = page.getByTestId('hook-input');
  await hookInput.fill('Most people give up in week three.');
  await hookInput.press('Enter');
  await expectSaved(page);
  await expect(gate(page)).toHaveAttribute('data-gate', 'hook');

  await page.getByTestId('hook-row').first().getByTestId('hook-choose').click();
  await expectSaved(page);

  await expect(gate(page)).toHaveAttribute('data-gate', 'ready');
  await expect(gate(page)).toContainText('Packaging: ready');
  // Nothing is outstanding, so the block is not claiming a readiness the row
  // does not have.
  await expect(page.getByTestId('gate-unsaved')).toHaveCount(0);

  // The row really holds all three.
  const row = await readRow(videoId);
  expect(row.title).toBe('How I edit ten videos a week');
  expect(row.thumbnail_concept).toBe(
    'Face left, shocked, three props on the desk, big yellow 3',
  );
  expect(row.hooks.filter((hook) => hook.chosen)).toHaveLength(1);

  // ---- The agreement, in both directions.
  expect(await tryMove(videoId, 'packaging')).toBeNull();
  expect(await tryMove(videoId, 'scripting')).toBeNull();

  /*
    Those two moves are *out-of-band writes*: `move_video` over SQL, not through
    this page, and it stamps `updated_at` like every other write. Since the M2
    review, a save from an editor that was rendered against an older version of
    the row is refused rather than allowed to overwrite it (finding 7), and this
    SQL is exactly the "something else changed it" the precondition is about. So
    the page is reloaded, which is what the refusal tells a person to do.
  */
  await page.reload();
  const conceptAfterMove = page.getByTestId('thumbnail-concept');

  // Cleared afterwards: PLAN.md's "clear the title afterwards and see
  // 'Complete packaging'". The indicator goes back, and so does the function.
  await conceptAfterMove.fill('');
  await conceptAfterMove.blur();
  await expectSaved(page);
  await expect(gate(page)).toHaveAttribute('data-gate', 'thumbnail_concept');

  expect(await readRow(videoId)).toMatchObject({ thumbnail_concept: null });
  expect(await tryMove(videoId, 'filming')).toMatch(/gate:thumbnail_concept/);
});

/* -------------------------------------------------------------------------- */
/* 2. Candidates                                                               */
/* -------------------------------------------------------------------------- */

test('candidates add on Enter without losing focus, and choosing one sets the working title', async ({
  page,
}) => {
  const videoId = await capture('Candidate walk');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  const input = page.getByTestId('candidate-input');
  const rows = page.getByTestId('candidate-row');

  // BRIEF.md: "Generated 10-20 title candidates, not 3". The habit is only
  // likely if the next one costs one keystroke, so this types four in a row
  // without ever touching the input again.
  const drafted = [
    'I edited ten videos in a week',
    'The editing system that saved my channel',
    'Ten videos, one week, no burnout',
    'How I edit ten videos a week',
  ];
  await input.click();
  for (const text of drafted) {
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    // The whole argument for this design: focus never leaves.
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
  }
  await expectSaved(page);

  await expect(rows).toHaveCount(4);
  await expect(page.getByTestId('candidate-count-number')).toHaveText('4');
  await expect(page.getByTestId('candidate-count')).toContainText('10–20, not 3');

  // A note on one of them, saved on blur.
  const note = rows.nth(1).getByTestId('candidate-note');
  await note.fill('curiosity gap, no number');
  await note.press('Enter');
  await expectSaved(page);

  // ---- Choosing copies the text into the working title.
  await rows.nth(3).getByTestId('candidate-choose').click();
  await expectSaved(page);
  await expect(page.getByTestId('working-title')).toHaveValue('How I edit ten videos a week');

  let row = await readRow(videoId);
  expect(row.title).toBe('How I edit ten videos a week');
  expect(row.title_candidates).toHaveLength(4);
  expect(row.title_candidates.filter((candidate) => candidate.chosen)).toHaveLength(1);
  expect(row.title_candidates[3].chosen).toBe(true);
  expect(row.title_candidates[1].note).toBe('curiosity gap, no number');
  expect(row.title_candidates.every((candidate) => candidate.source === 'manual')).toBe(true);
  // Ids are stable and unique, which is what makes an edit addressable.
  expect(new Set(row.title_candidates.map((candidate) => candidate.id)).size).toBe(4);

  // ---- Choosing a second one is a *move*, not an addition: exactly one stays
  // ticked, which is what zod would insist on anyway.
  await rows.nth(0).getByTestId('candidate-choose').click();
  await expectSaved(page);
  await expect(page.getByTestId('working-title')).toHaveValue('I edited ten videos in a week');
  await expect(rows.nth(3)).toHaveAttribute('data-chosen', 'false');

  row = await readRow(videoId);
  expect(row.title_candidates.filter((candidate) => candidate.chosen)).toHaveLength(1);
  expect(row.title).toBe('I edited ten videos in a week');

  // ---- Removing one leaves the rest alone.
  await rows.nth(2).getByTestId('candidate-remove').click();
  await expectSaved(page);
  await expect(rows).toHaveCount(3);
  row = await readRow(videoId);
  expect(row.title_candidates.map((candidate) => candidate.text)).toEqual([
    'I edited ten videos in a week',
    'The editing system that saved my channel',
    'How I edit ten videos a week',
  ]);
});

/* -------------------------------------------------------------------------- */
/* 3. The fourth hook                                                          */
/* -------------------------------------------------------------------------- */

test('a fourth hook is refused with a reason, and the database would refuse it too', async ({
  page,
}) => {
  const videoId = await capture('Hook limit');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  const input = page.getByTestId('hook-input');
  const rows = page.getByTestId('hook-row');

  for (const text of [
    'Most people give up in week three.',
    'I deleted forty videos before this one.',
    'This took four hours. It used to take four days.',
  ]) {
    await input.fill(text);
    await input.press('Enter');
  }
  await expectSaved(page);
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId('hook-count-number')).toHaveText('3');

  // The fourth. The control is not disabled — it refuses out loud, because a
  // dead button is a refusal with no reason attached.
  await input.fill('One more, for luck.');
  await input.press('Enter');

  const notice = page.getByTestId('hook-notice');
  await expect(notice).toHaveText(/Three hooks is the limit/);
  await expect(notice).toContainText('the database refuses a fourth');
  await expect(rows).toHaveCount(3);
  // What was typed is still there — the refusal did not eat it.
  await expect(input).toHaveValue('One more, for luck.');

  const row = await readRow(videoId);
  expect(row.hooks).toHaveLength(3);

  // The notice is not bluffing. The same fourth hook, written straight at the
  // column as the signed-in user, is refused by the CHECK in 0001_init.sql.
  const refusal = await asUser(async () => {
    try {
      await db.query(
        `update public.videos set hooks = hooks || $2::jsonb where id = $1`,
        [videoId, JSON.stringify([{ id: 'h4', text: 'One more, for luck.', chosen: false }])],
      );
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(refusal).toMatch(/videos_hooks_is_array_max_3|check constraint/i);
  expect((await readRow(videoId)).hooks).toHaveLength(3);

  // Removing one makes room again, and the notice was the only thing in the way.
  await rows.nth(0).getByTestId('hook-remove').click();
  await expectSaved(page);
  await input.fill('One more, for luck.');
  await input.press('Enter');
  await expectSaved(page);
  await expect(rows).toHaveCount(3);
  expect((await readRow(videoId)).hooks.map((hook) => hook.text)).toContain('One more, for luck.');
});

/* -------------------------------------------------------------------------- */
/* 4. The character count                                                      */
/* -------------------------------------------------------------------------- */

test('the title character count warns past 55 without blocking the save', async ({ page }) => {
  const videoId = await capture('Counting');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  const title = page.getByTestId('working-title');
  const count = page.getByTestId('title-count');

  const exactly55 = 'a'.repeat(55);
  await title.fill(exactly55);
  await expect(count).toHaveAttribute('data-over', 'false');
  await expect(count).toHaveText('55/55 characters');

  // One more character, and the guidance shows up. Live, before any save.
  await title.fill(`${exactly55}b`);
  await expect(count).toHaveAttribute('data-over', 'true');
  await expect(count).toContainText('56/55');
  await expect(count).toContainText(/past 55/);

  // And it is guidance, not a rule: the long title saves, and the gate is happy
  // with it. BRIEF.md's 55 is where YouTube truncates, not where titles stop
  // being allowed.
  await title.press('Enter');
  await expectSaved(page);
  expect((await readRow(videoId)).title).toBe(`${exactly55}b`);
  await expect(count).toHaveAttribute('data-over', 'true');

  await title.fill('Short again');
  await expect(count).toHaveAttribute('data-over', 'false');
});

/* -------------------------------------------------------------------------- */
/* 5. Skipping                                                                 */
/* -------------------------------------------------------------------------- */

test('skipping needs a typed reason, an empty one is refused, and un-skipping puts the gate back', async ({
  page,
}) => {
  const videoId = await capture('Skip me');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  // It is not a button sitting next to the fields: it is a disclosure that has
  // to be opened first. That is the "structurally awkward" of BRIEF.md
  // principle 1, and it is the whole reason the control looks like this.
  await expect(page.getByTestId('packaging-skip-form')).toHaveCount(0);
  await page.getByTestId('packaging-skip-open').click();
  const form = page.getByTestId('packaging-skip-form');
  await expect(form).toBeVisible();
  await expect(form).toContainText('badge on the card');

  // ---- An empty reason is refused, out loud, and nothing is written.
  await page.getByTestId('packaging-skip-confirm').click();
  await expect(page.getByTestId('skip-notice')).toHaveText(/A reason is required/);
  await expect(page.getByTestId('packaging-skipped')).toHaveCount(0);
  expect(await readRow(videoId)).toMatchObject({
    packaging_skipped_at: null,
    packaging_skip_reason: null,
  });

  // ---- So is one made of spaces. `packaging_skip_reason <> ''` is a CHECK, and
  // "   " would have satisfied it while meaning nothing.
  const reason = page.getByTestId('skip-reason-input');
  await reason.fill('     ');
  await page.getByTestId('packaging-skip-confirm').click();
  await expect(page.getByTestId('skip-notice')).toHaveText(/A reason is required/);
  expect(await readRow(videoId)).toMatchObject({ packaging_skipped_at: null });

  // ---- A real one goes through.
  await reason.fill('Sponsor deadline — packaging was decided in the brief');
  await page.getByTestId('packaging-skip-confirm').click();
  await expectSaved(page);

  const skipped = page.getByTestId('packaging-skipped');
  await expect(skipped).toBeVisible();
  await expect(page.getByTestId('skip-reason')).toHaveText(
    'Sponsor deadline — packaging was decided in the brief',
  );
  await expect(gate(page)).toHaveAttribute('data-gate', 'skipped');
  await expect(gate(page)).toContainText('Packaging: skipped');

  const row = await readRow(videoId);
  expect(row.packaging_skipped_at).not.toBeNull();
  expect(row.packaging_skip_reason).toBe(
    'Sponsor deadline — packaging was decided in the brief',
  );
  // The concept is still missing and the video still moves: that is what
  // skipping means, and it is why it costs a sentence.
  expect(row.thumbnail_concept).toBeNull();
  expect(await tryMove(videoId, 'scripting')).toBeNull();

  // ---- It survives a reload, because it is a column and not a flag in a tab.
  await page.reload();
  await expect(page.getByTestId('skip-reason')).toHaveText(
    'Sponsor deadline — packaging was decided in the brief',
  );

  // ---- Un-skipping is one click: going back to doing the work properly should
  // never be the harder direction.
  await page.getByTestId('packaging-unskip').click();
  await expectSaved(page);
  await expect(page.getByTestId('packaging-skipped')).toHaveCount(0);
  await expect(gate(page)).toHaveAttribute('data-gate', 'thumbnail_concept');

  expect(await readRow(videoId)).toMatchObject({
    packaging_skipped_at: null,
    packaging_skip_reason: null,
  });
  expect(await tryMove(videoId, 'filming')).toMatch(/gate:thumbnail_concept/);
});
