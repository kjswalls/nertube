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
import { untilTaken } from './hydration';

/**
 * M2 — the adversarial review, walked.
 *
 * Every test in this file exists because a reviewer reproduced something in a
 * real browser that the rest of the suite could not see, and all but one of
 * those blind spots had the same shape: `e2e/packaging.spec.ts` and
 * `e2e/flow-fields.spec.ts` only ever edit with an **idle wire**. A save that
 * is still in flight, a second tab, a value that cannot be written, a control
 * that unmounts under the person who pressed it — none of those are reachable
 * from a suite that waits for "Saved" after every gesture.
 *
 * So the pattern here is: hold the server action's POST open with `page.route`
 * (latency simulation, not a stub — the same action, the same PostgREST, the
 * same RLS, just later), do the thing, let it go, and then read the row.
 */

const CHANNEL = { name: 'M2 Review', slug: 'm2-review' };

/** How long a held save sits on the wire. Long enough to type into the gap. */
const HOLD_MS = 2_000;

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

/** Run `fn` the way a PostgREST request runs it: RLS on, `auth.uid()` answering. */
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

interface Row {
  title: string;
  thumbnail_concept: string | null;
  title_candidates: { id: string; text: string; chosen?: boolean }[];
  hooks: { id: string; text: string; chosen?: boolean }[];
  packaging_skipped_at: string | null;
  packaging_skip_reason: string | null;
  target_publish_date: string | Date | null;
  youtube_url: string | null;
  published_at: string | null;
}

async function readRow(videoId: string): Promise<Row> {
  const result = await db.query<Row>(
    `select title, thumbnail_concept, title_candidates, hooks,
            packaging_skipped_at, packaging_skip_reason,
            target_publish_date, youtube_url, published_at
       from public.videos where id = $1`,
    [videoId],
  );
  return result.rows[0];
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

const saveStatus = (page: Page): Locator =>
  page.getByTestId('packaging-save-status');
const gate = (page: Page): Locator => page.getByTestId('gate-indicator');

async function expectSaved(page: Page): Promise<void> {
  await expect(saveStatus(page)).toHaveText(/^Saved$/, { timeout: 15_000 });
}

/**
 * Hold every server action on this page open for `HOLD_MS`.
 *
 * Not a stub: the request is forwarded, the action runs, PostgREST writes, and
 * only the *answer* is late. That is exactly the window an ordinary phone
 * connection opens on every save, and it is the window all three of the
 * "nothing was saved and the line says Saved" findings live in.
 */
async function holdSaves(page: Page, videoId: string): Promise<void> {
  await page.route(`**/videos/${videoId}`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    return route.fallback();
  });
}

const releaseSaves = (page: Page, videoId: string): Promise<void> =>
  page.unroute(`**/videos/${videoId}`);

/** What has the keyboard right now, as `TAG#id[data-testid]`. */
async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return 'NONE';
    return `${el.tagName}#${el.id || '-'}[${el.dataset.testid ?? '-'}]`;
  });
}

/* -------------------------------------------------------------------------- */
/* 1. Undoing an edit while its save is in flight (findings 1 and 9)           */
/* -------------------------------------------------------------------------- */

test('a value typed and then taken back while the save is on the wire does not land', async ({
  page,
}) => {
  const videoId = await capture('Revert probe');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  const title = page.getByTestId('working-title');
  await holdSaves(page, videoId);

  // Out it goes…
  await title.fill('Typed by mistake');
  await title.press('Enter');
  await expect(saveStatus(page)).toHaveText('Saving…');

  // …and back it comes, while the first write is still in the air. Diffed
  // against what the server last *confirmed* this is "no change", so nothing
  // used to be queued: the mistake landed and the line said "Saved".
  await title.fill('Revert probe');
  await title.press('Enter');

  await releaseSaves(page, videoId);
  await expectSaved(page);

  expect(await title.inputValue()).toBe('Revert probe');
  expect((await readRow(videoId)).title).toBe('Revert probe');

  // The board is the third party that used to disagree with the other two.
  await page.goto(`/c/${CHANNEL.slug}/board`);
  await expect(page.getByTestId('board')).toContainText('Revert probe');
  await expect(page.getByTestId('board')).not.toContainText('Typed by mistake');
});

test('a candidate added and removed while the save is on the wire leaves no candidate', async ({
  page,
}) => {
  const videoId = await capture('Ghost candidate probe');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  await holdSaves(page, videoId);

  await page.getByTestId('candidate-input').fill('Ghost candidate');
  await page.getByTestId('candidate-input').press('Enter');
  await expect(saveStatus(page)).toHaveText('Saving…');

  await page.getByTestId('candidate-remove').first().click();

  await releaseSaves(page, videoId);
  await expectSaved(page);

  await expect(page.getByTestId('candidate-row')).toHaveCount(0);
  expect((await readRow(videoId)).title_candidates).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* 2. A skip never discards what has not been saved (finding 5)                */
/* -------------------------------------------------------------------------- */

test('skipping carries the unsaved edits with it instead of wiping them', async ({
  page,
}) => {
  const videoId = await capture('Dropped wire skip');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  // The wifi drops, and a concept is typed into it.
  await page.route(`**/videos/${videoId}`, (route) =>
    route.request().method() === 'POST' ? route.abort('failed') : route.fallback(),
  );

  const concept = page.getByTestId('thumbnail-concept');
  await concept.fill('A concept typed while the wifi was down');
  await concept.blur();
  await expect(saveStatus(page)).toContainText(/could not reach the server/i);
  expect((await readRow(videoId)).thumbnail_concept).toBeNull();

  // The wifi comes back, and the user skips packaging — a write about two
  // completely different columns. It used to answer with a row that knows
  // nothing about the concept, overwrite the editor with it, and report
  // "Saved": the typed text vanished from the screen and from the only warning
  // about it.
  await page.unroute(`**/videos/${videoId}`);

  await page.getByTestId('packaging-skip-open').click();
  await page
    .getByTestId('skip-reason-input')
    .fill('Client supplied the packaging in the brief');
  await page.getByTestId('packaging-skip-confirm').click();
  await expectSaved(page);

  await expect(page.getByTestId('packaging-skipped')).toBeVisible();
  await expect(page.getByTestId('thumbnail-concept')).toHaveValue(
    'A concept typed while the wifi was down',
  );

  const row = await readRow(videoId);
  expect(row.thumbnail_concept).toBe('A concept typed while the wifi was down');
  expect(row.packaging_skipped_at).not.toBeNull();
});

/* -------------------------------------------------------------------------- */
/* 3. One bad element does not wedge the block (findings 6 and 8)              */
/* -------------------------------------------------------------------------- */

test('a blanked candidate is reported on its own row and nothing else stops saving', async ({
  page,
}) => {
  const videoId = await capture('Poison list');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  await page.getByTestId('candidate-input').fill('A first candidate');
  await page.getByTestId('candidate-input').press('Enter');
  await expectSaved(page);

  // Select-all, delete, Tab — one gesture. The whole patch used to be refused
  // by the list schema, which made the title, the concept and the hooks
  // permanently unsavable with a message about a field nobody was editing.
  const text = page.getByTestId('candidate-text').first();
  await text.fill('');
  await text.blur();

  const issue = page.getByTestId('candidate-issue');
  await expect(issue).toBeVisible();
  await expect(issue).toContainText('needs some text');
  // On the row, not in the shared line.
  await expect(page.getByTestId('candidate-row').first()).toContainText(
    'needs some text',
  );

  // Everything else still saves.
  await page.getByTestId('thumbnail-concept').fill('Face left, big yellow 3');
  await page.getByTestId('thumbnail-concept').blur();
  await expectSaved(page);
  expect((await readRow(videoId)).thumbnail_concept).toBe('Face left, big yellow 3');

  await page.getByTestId('working-title').fill('A brand new working title');
  await page.getByTestId('working-title').press('Enter');
  await expectSaved(page);
  expect((await readRow(videoId)).title).toBe('A brand new working title');

  // The bad element is still refused — the rule has not been relaxed…
  expect((await readRow(videoId)).title_candidates[0].text).toBe('A first candidate');

  // …and the moment the row is repaired it saves, with no other gesture.
  await text.fill('A repaired candidate');
  await text.blur();
  await expectSaved(page);
  await expect(page.getByTestId('candidate-issue')).toHaveCount(0);
  expect((await readRow(videoId)).title_candidates[0].text).toBe(
    'A repaired candidate',
  );
});

/* -------------------------------------------------------------------------- */
/* 4. Two tabs on one video (finding 7)                                        */
/* -------------------------------------------------------------------------- */

test('a second tab is refused rather than allowed to clobber the first one', async ({
  page,
  context,
}) => {
  const videoId = await capture('Two tabs');
  await signIn(page);

  await page.goto(`/videos/${videoId}`);
  const second = await context.newPage();
  await second.goto(`/videos/${videoId}`);

  // Tab one writes.
  await page.getByTestId('hook-input').fill('Hook written in tab one');
  await page.getByTestId('hook-input').press('Enter');
  await expectSaved(page);
  expect((await readRow(videoId)).hooks.map((h) => h.text)).toEqual([
    'Hook written in tab one',
  ]);

  // Tab two was rendered before that write, so its copy of the row is stale and
  // its patch carries the whole `hooks` array. Unconditional, it silently
  // deleted tab one's hook and said "Saved".
  await second.getByTestId('hook-input').fill('Hook written in tab two');
  await second.getByTestId('hook-input').press('Enter');

  const secondStatus = second.getByTestId('packaging-save-status');
  await expect(secondStatus).toContainText('changed somewhere else', {
    timeout: 15_000,
  });
  // A retry would only re-send the patch the row has moved past.
  await expect(second.getByTestId('packaging-save-status-reload')).toBeVisible();
  await expect(second.getByTestId('packaging-save-status-retry')).toHaveCount(0);

  // Tab one's hook is still the row's hook, and tab two still has what it typed.
  expect((await readRow(videoId)).hooks.map((h) => h.text)).toEqual([
    'Hook written in tab one',
  ]);
  await expect(second.getByTestId('hook-text')).toHaveValue('Hook written in tab two');

  await second.close();
});

test('the page keeps saving after its own move and its own upload', async ({
  page,
}) => {
  // The precondition is only safe because everything on this page that writes
  // the row hands its new version back. A move from the stage select is the
  // one most likely to be forgotten, and a token that missed it would turn
  // every save afterwards into a conflict that never happened.
  const videoId = await capture('Same page writes');
  await signIn(page);
  // The notes, the stage select and the working title are now in two different
  // sections, so this walk crosses between them — which also makes it the
  // proof that the version token survives a section switch.
  await page.goto(`/videos/${videoId}?section=schedule`);

  await page.getByTestId('notes').fill('Before the move');
  await page.getByTestId('notes').blur();
  await expect(page.getByTestId('notes-status')).toHaveText('Saved');

  const packaging = await db.query<{ id: string; name: string }>(
    `select id, name from public.stages where channel_id = $1 and kind = 'packaging'`,
    [channelId],
  );
  await page.getByTestId('stage-select').selectOption(packaging.rows[0].id);
  await expect(page.getByTestId('stage-select-status')).toContainText('Moved to');

  await page.getByTestId('notes').fill('After the move');
  await page.getByTestId('notes').blur();
  await expect(page.getByTestId('notes-status')).toHaveText('Saved');

  await page.getByTestId('section-tab-packaging').click();
  await page.getByTestId('working-title').fill('Still writable');
  await page.getByTestId('working-title').press('Enter');
  await expectSaved(page);

  const row = await readRow(videoId);
  expect(row.title).toBe('Still writable');
  expect((await db.query('select notes from public.videos where id = $1', [videoId]))
    .rows[0]).toMatchObject({ notes: 'After the move' });
});

/* -------------------------------------------------------------------------- */
/* 5. The target date, actually saved (finding 16)                             */
/* -------------------------------------------------------------------------- */

test('picking a target date saves it without waiting for a blur', async ({ page }) => {
  const videoId = await capture('Date on change');
  await signIn(page);
  await page.goto(`/videos/${videoId}?section=schedule`);

  const field = page.getByTestId('target-date');

  /*
    No blur. The native overlay keeps focus after a date is picked, so this is
    what the whole interaction looks like — and the value sat unsaved, with the
    status line saying nothing, until something else happened to move focus.

    The first fill waits for the app's own hydration signal (the sidebar's
    `c` binding going live) because a fill that lands inside the video page's
    hydration window is worse than swallowed: the input takes the value, React
    adopts it as the field's value when it hydrates, and every later fill of
    the *same* date fires no `onChange` — so the `untilTaken` retry below,
    which re-fills the same date, could never recover from the one race it was
    written for. M7's three slices each watched it lose under load for exactly
    that reason. `e2e/hydration.ts` describes the window; the retry stays for
    the rarer case where the date picker's own handler is the one not yet
    attached, and the assertion stays about the outcome.
  */
  await expect(
    page.locator('button[aria-keyshortcuts="c"][data-shortcut-ready="true"]'),
  ).toBeVisible();
  await untilTaken(
    async () => {
      await field.focus();
      await field.fill('2026-12-01');
    },
    () =>
      expect(page.getByTestId('target-date-status')).toHaveText('Saved', {
        timeout: 2_000,
      }),
  );
  expect(await focused(page)).toContain('target-date');
  // `pg` hands a `date` column back as a Date; the column is what matters.
  const stored = (await readRow(videoId)).target_publish_date;
  expect(new Date(stored!).toISOString().slice(0, 10)).toBe('2026-12-01');
});

/* -------------------------------------------------------------------------- */
/* 6. Publishing from this page (finding 17)                                   */
/* -------------------------------------------------------------------------- */

test('moving to Published from the stage select stops the URL block calling it not live', async ({
  page,
}) => {
  const videoId = await capture('Published from here');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  // Satisfy the gate so `move_video` will allow the move.
  await page.getByTestId('thumbnail-concept').fill('A hand holding the thing');
  await page.getByTestId('thumbnail-concept').blur();
  await expectSaved(page);
  await page.getByTestId('hook-input').fill('This cost me a weekend.');
  await page.getByTestId('hook-input').press('Enter');
  await expectSaved(page);
  await page.getByTestId('hook-choose').first().click();
  await expectSaved(page);
  await expect(gate(page)).toHaveAttribute('data-gate', 'ready');

  await page.getByTestId('section-tab-schedule').click();
  await page.getByTestId('youtube-url').fill('https://www.youtube.com/watch?v=abc');
  await page.getByTestId('youtube-url').blur();
  await expect(page.getByTestId('youtube-url-status')).toHaveText('Saved');
  await expect(page.getByTestId('youtube-not-live')).toBeVisible();

  const published = await db.query<{ id: string }>(
    `select id from public.stages where channel_id = $1 and kind = 'published'`,
    [channelId],
  );
  await page.getByTestId('stage-select').selectOption(published.rows[0].id);
  await expect(page.getByTestId('stage-select-status')).toContainText('Moved to');

  expect((await readRow(videoId)).published_at).not.toBeNull();

  // Without a reload. The client copy of `published_at` used to be seeded once
  // from the props and never re-read, so the page went on saying "not live"
  // about a video the user had just published from the select above it.
  await expect(page.getByTestId('youtube-live')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('youtube-not-live')).toHaveCount(0);
  await expect(
    page.getByTestId('youtube-live').getByRole('link', { name: 'Watch on YouTube' }),
  ).toHaveAttribute('href', 'https://www.youtube.com/watch?v=abc');
});

/* -------------------------------------------------------------------------- */
/* 7. The skip disclosure (findings 4, 10, 11, 12)                             */
/* -------------------------------------------------------------------------- */

test('a one-character skip reason is refused, and re-skipping after an un-skip costs the same three acts', async ({
  page,
}) => {
  const videoId = await capture('Skip cost');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  const open = page.getByTestId('packaging-skip-open');
  await expect(open).toHaveAttribute('aria-expanded', 'false');

  // Opened with a retry, for the same reason the test below this one does it:
  // a click that lands before the route has hydrated is swallowed, and this is
  // the first click of the test. See `e2e/hydration.ts`.
  await untilTaken(
    () => open.click(),
    () => expect(open).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 }),
  );
  // The disclosure button stays mounted and says what it controls, and the
  // caret is in the one thing that has to be typed.
  const controls = await open.getAttribute('aria-controls');
  expect(controls).toBeTruthy();
  await expect(page.locator(`[id="${controls}"]`)).toBeVisible();
  expect(await focused(page)).toContain('skip-reason-input');

  // ---- One keystroke is not a reason.
  await page.getByTestId('skip-reason-input').fill('x');
  await page.getByTestId('packaging-skip-confirm').click();
  await expect(page.getByTestId('skip-notice')).toContainText('not a reason yet');
  expect((await readRow(videoId)).packaging_skipped_at).toBeNull();

  // ---- A real one goes through.
  const reason = 'Sponsor deadline — decided in the brief';
  await page.getByTestId('skip-reason-input').fill(reason);
  await page.getByTestId('packaging-skip-confirm').click();
  await expectSaved(page);
  await expect(page.getByTestId('packaging-skipped')).toBeVisible();
  expect((await readRow(videoId)).packaging_skip_reason).toBe(reason);
  // Focus followed the control that replaced the one that vanished.
  expect(await focused(page)).toContain('packaging-unskip');

  // ---- Un-skip. This used to land on the *open* form with the withdrawn
  // reason still in the box and the collapsed link gone from the page, so
  // re-skipping cost one click and no typing.
  await page.getByTestId('packaging-unskip').click();
  await expectSaved(page);

  await expect(page.getByTestId('packaging-skip-form')).toHaveCount(0);
  await expect(page.getByTestId('packaging-skip-open')).toBeVisible();
  await expect(page.getByTestId('packaging-skip-open')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  expect(await focused(page)).toContain('packaging-skip-open');

  await page.getByTestId('packaging-skip-open').click();
  await expect(page.getByTestId('skip-reason-input')).toHaveValue('');
});

test('the skip button is not silently dead while an unrelated save is in flight', async ({
  page,
}) => {
  const videoId = await capture('Skip while saving');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  // Opened with a retry, which is about this page rather than about this test:
  // a click that lands before the route has hydrated is swallowed. See
  // `e2e/hydration.ts` for what that window is and why the page keeps it.
  await untilTaken(
    () => page.getByTestId('packaging-skip-open').click(),
    () =>
      expect(page.getByTestId('skip-reason-input')).toBeVisible({ timeout: 1_000 }),
  );

  await page
    .getByTestId('skip-reason-input')
    .fill('No time before the sponsor deadline');

  await holdSaves(page, videoId);
  await page.getByTestId('working-title').fill('A title being saved slowly');
  await page.getByTestId('working-title').press('Enter');
  await expect(saveStatus(page)).toHaveText('Saving…');

  // Pressed while a *title* save is on the wire. It used to be disabled off the
  // block's shared queue, with nothing on the screen saying why.
  await expect(page.getByTestId('packaging-skip-confirm')).toBeEnabled();
  await page.getByTestId('packaging-skip-confirm').click();

  await releaseSaves(page, videoId);
  await expectSaved(page);

  const row = await readRow(videoId);
  expect(row.packaging_skip_reason).toBe('No time before the sponsor deadline');
  expect(row.title).toBe('A title being saved slowly');
});

/* -------------------------------------------------------------------------- */
/* 8. Focus and names in the lists (findings 11 and 13)                        */
/* -------------------------------------------------------------------------- */

test('removing a row keeps the keyboard in the list, and every Choose has its own name', async ({
  page,
}) => {
  const videoId = await capture('Focus walk');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  for (const text of ['Candidate one', 'Candidate two']) {
    await page.getByTestId('candidate-input').fill(text);
    await page.getByTestId('candidate-input').press('Enter');
    await expectSaved(page);
  }

  // Two buttons, two names. They were both called "Choose".
  await expect(
    page.getByRole('button', { name: 'Choose candidate 1' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Choose candidate 2' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Remove candidate 1' }).click();
  await expectSaved(page);
  // Focus went to `<body>` before this: no row, no list, nowhere.
  expect(await focused(page)).toContain('candidate-text');

  await page.getByRole('button', { name: 'Remove candidate 1' }).click();
  await expectSaved(page);
  // The list is empty now, so the useful place is the box that refills it.
  expect(await focused(page)).toContain('candidate-input');

  await page.getByTestId('hook-input').fill('A hook to remove');
  await page.getByTestId('hook-input').press('Enter');
  await expectSaved(page);
  await expect(page.getByRole('button', { name: 'Choose hook 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove hook 1' }).click();
  await expectSaved(page);
  expect(await focused(page)).toContain('hook-input');
});

/* -------------------------------------------------------------------------- */
/* 9. A chosen candidate is the working title (finding 2)                      */
/* -------------------------------------------------------------------------- */

test('a candidate stops being "Chosen" when the working title becomes something else', async ({
  page,
}) => {
  const videoId = await capture('Stale tick');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  await page.getByTestId('candidate-input').fill('The video that ate my October');
  await page.getByTestId('candidate-input').press('Enter');
  await expectSaved(page);

  await page.getByTestId('candidate-choose').first().click();
  await expectSaved(page);
  await expect(page.getByTestId('working-title')).toHaveValue(
    'The video that ate my October',
  );
  await expect(page.getByTestId('candidate-row').first()).toHaveAttribute(
    'data-chosen',
    'true',
  );

  await page.getByTestId('working-title').fill('Something completely different');
  await page.getByTestId('working-title').press('Enter');
  await expectSaved(page);

  // The tick used to stay green over a title the gate no longer reads.
  await expect(page.getByTestId('candidate-row').first()).toHaveAttribute(
    'data-chosen',
    'false',
  );
  await expect(
    page.getByRole('button', { name: 'Choose candidate 1' }),
  ).toBeVisible();

  const row = await readRow(videoId);
  expect(row.title).toBe('Something completely different');
  expect(row.title_candidates[0].chosen).toBe(false);
});

/* -------------------------------------------------------------------------- */
/* 10. The hook counter reads as a target (finding 3)                          */
/* -------------------------------------------------------------------------- */

test('the hook counter asks for three, the way the candidate counter asks for ten', async ({
  page,
}) => {
  const videoId = await capture('Hook target');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  const count = page.getByTestId('hook-count');
  await expect(count).toContainText('write three, then choose the strongest');

  // The gate's other two fields, so "ready" below is about the hook rule alone.
  await page.getByTestId('thumbnail-concept').fill('Two hands, one broken part');
  await page.getByTestId('thumbnail-concept').blur();
  await expectSaved(page);

  await page.getByTestId('hook-input').fill('One hook and done.');
  await page.getByTestId('hook-input').press('Enter');
  await expectSaved(page);
  await page.getByTestId('hook-choose').first().click();
  await expectSaved(page);

  // The gate is green — it is the rule PLAN.md gives — and the counter still
  // says what the brief asks for, which is the only thing on the screen that
  // used to notice one variant is not three.
  await expect(gate(page)).toHaveAttribute('data-gate', 'ready');
  await expect(count).toContainText('1/3 written · one chosen');
  await expect(count).toContainText('write three, then choose the strongest');

  for (const text of ['A second opening.', 'A third opening.']) {
    await page.getByTestId('hook-input').fill(text);
    await page.getByTestId('hook-input').press('Enter');
    await expectSaved(page);
  }
  await expect(count).not.toContainText('write three, then choose the strongest');
});
