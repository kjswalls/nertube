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
import { untilTaken } from './hydration';

/**
 * M8 — PLAN.md's acceptance for the brainstorm, walked in a browser.
 *
 * PLAN.md gives this milestone two runnables and three review items:
 *
 * > *Runnable:* 10–20 titles with rationale and a highlighted pick; changing
 * > the voice guide visibly changes output.
 * > *Review:* key never reaches the client bundle (`server-only`, grep the
 * > build output); a 21-title answer is clamped, not discarded; a refusal
 * > surfaces as a message, not a crash.
 *
 * Three slices built this concurrently and each wrote its own suite:
 * `brainstorm.spec.ts` proves the panel, `assist-fields.spec.ts` proves the
 * other three controls, and `lib/assist/*.test.ts` proves the module against a
 * stubbed transport. This file is the milestone's own walk — the five things
 * PLAN.md actually asks a person to see — and it is deliberately short enough
 * to read as the answer to "did M8 land".
 *
 * ## What this suite cannot prove, stated once
 *
 * **No live model call has ever been made from this container.** There is no
 * `ANTHROPIC_API_KEY` here and no egress to `api.anthropic.com`, so every walk
 * below runs against `lib/assist/fake.ts` behind the same `AssistProvider`
 * interface the real implementation sits behind. Everything else on screen is
 * the code that ships: the real pill, the real panel, the real server action,
 * the real save queue, the real `brainstorm_last` column, against real
 * PostgREST with RLS on. What is proved is the app; what is not proved is
 * Anthropic's half of the conversation. `docs/MILESTONES.md` says precisely
 * which is which.
 */

const CHANNEL = { name: 'M8 Acceptance', slug: 'm8-acceptance' };

/** PLAN.md: "10–20 titles". Both ends asserted, not just the lower one. */
const MIN_TITLES = 10;
const MAX_TITLES = 20;

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
    throw new Error(`the dev stack has no user ${SEED_EMAIL}`);
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
  channelId = await createChannel();
});

/** Run as the signed-in user: RLS on, column grants applied, `auth.uid()` live. */
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
        JSON.stringify(
          SEED_BUCKETS.map((bucket) => ({ ...bucket, monthly_quota: null })),
        ),
      ],
    );
    return result.rows[0].id;
  });
}

/** A video, through the only path a client has to one. */
async function capture(title: string, notes?: string): Promise<string> {
  const id = await asUser(async () => {
    const result = await db.query<{ id: string }>(
      'select id from capture_video($1::uuid, $2::text)',
      [channelId, title],
    );
    return result.rows[0].id;
  });
  if (notes !== undefined) {
    await asUser(async () => {
      await db.query('update public.videos set notes = $2 where id = $1', [id, notes]);
    });
  }
  return id;
}

async function setVoiceGuide(guide: string | null): Promise<void> {
  await asUser(async () => {
    await db.query('update public.channels set voice_guide = $2 where id = $1', [
      channelId,
      guide,
    ]);
  });
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}

const panel = (page: Page) => page.getByTestId('brainstorm-panel');
const suggestions = (page: Page) => page.getByTestId('brainstorm-suggestion');
const pill = (page: Page) =>
  page.locator('[data-testid="assist-pill"][data-assist="Generate 20"]');

/**
 * Open the panel.
 *
 * Retried through `untilTaken` (`e2e/hydration.ts`): `/videos/[id]` renders as
 * real HTML before any JavaScript runs, and a click inside the hydration window
 * is swallowed. The act is idempotent because it only clicks while the panel is
 * absent — the pill is a toggle, so a blind second click would close it again.
 */
async function openPanel(page: Page, videoId: string): Promise<void> {
  await page.goto(`/videos/${videoId}`);
  await untilTaken(
    async () => {
      if ((await panel(page).count()) === 0) await pill(page).click();
    },
    () => expect(panel(page)).toBeVisible({ timeout: 2_000 }),
  );
  await expect(page.getByTestId('brainstorm-pending')).toHaveCount(0);
  await expect(suggestions(page).first()).toBeVisible();
}

/* -------------------------------------------------------------------------- */
/* Runnable 1 — 10–20 titles, each with a rationale, one highlighted pick      */
/* -------------------------------------------------------------------------- */

test('the runnable: ten to twenty titles, a rationale on every one, exactly one highlighted pick', async ({
  page,
}) => {
  const videoId = await capture(
    'Sharpening a chisel properly',
    'The bevel angle matters less than people think. Flattening the back is the part everyone skips.',
  );
  await signIn(page);
  await openPanel(page, videoId);

  // 10–20, both ends. BRIEF.md's packaging checklist asks for ten to twenty
  // candidates, not three, because the point is to see the shape of the space.
  const count = await suggestions(page).count();
  expect(count).toBeGreaterThanOrEqual(MIN_TITLES);
  expect(count).toBeLessThanOrEqual(MAX_TITLES);
  await expect(page.getByTestId('brainstorm-count')).toHaveText(String(count));

  // A reason on every single one, never behind a disclosure. A flat list of
  // twenty titles is a slot machine; the reasons are what make it a craft tool.
  const rationales = page.getByTestId('suggestion-rationale');
  await expect(rationales).toHaveCount(count);
  for (const text of await rationales.allInnerTexts()) {
    expect(text.trim().length).toBeGreaterThan(10);
  }

  // Exactly one pick, highlighted, with its reason spelled out as its own
  // sentence rather than left for the reader to infer from the styling.
  const picked = page.locator('[data-testid="brainstorm-suggestion"][data-recommended="true"]');
  await expect(picked).toHaveCount(1);
  await expect(picked.getByTestId('brainstorm-pick-badge')).toBeVisible();
  // Its own sentence, and a comparative one: `recommended_reason` is a field
  // of the answer rather than the picked item's rationale wearing a label.
  await expect(picked.getByTestId('brainstorm-pick-reason')).toContainText(
    'Why it picked this one',
  );

  // And it is drawn as a proposal, not as the person's writing: the dashed
  // frame and the chip are the boundary the design brief is built around.
  await expect(suggestions(page).first()).toContainText('Proposal');

  await panel(page).screenshot({
    path: 'e2e/screenshots/m8-titles-with-rationales.png',
  });

  // Accepting turns one into an ordinary candidate row — the same save queue
  // the packaging block has always used, marked as the model's.
  const chosen = (await picked.getByTestId('suggestion-text').innerText()).trim();
  await picked.getByTestId('suggestion-add').click();
  // The candidate list is an editor, so the accepted text is an input's value:
  // from this moment it is an ordinary field the person can retype.
  await expect(page.getByTestId('candidate-row')).toHaveCount(1);
  await expect(page.getByTestId('candidate-text').first()).toHaveValue(chosen);
  await expect(page.getByTestId('packaging-save-status')).toHaveText(/^Saved$/);

  await expect
    .poll(async () => {
      const row = await db.query<{ title_candidates: { text: string; source?: string }[] }>(
        'select title_candidates from public.videos where id = $1',
        [videoId],
      );
      return row.rows[0].title_candidates;
    })
    .toEqual([expect.objectContaining({ text: chosen, source: 'ai' })]);
});

/* -------------------------------------------------------------------------- */
/* Runnable 2 — the voice guide visibly changes the output                    */
/* -------------------------------------------------------------------------- */

test('the runnable: changing the channel voice guide visibly changes what comes back', async ({
  page,
}) => {
  const videoId = await capture(
    'Sharpening a chisel properly',
    'The bevel angle matters less than people think.',
  );
  await setVoiceGuide(null);
  await signIn(page);
  await openPanel(page, videoId);

  // With no guide the panel says so, and says what to do about it, rather than
  // quietly producing generic-YouTuber voice — BRIEF.md's explicit refusal.
  await expect(page.getByTestId('brainstorm-provenance')).toContainText('no voice guide');
  const before = await page.getByTestId('suggestion-text').allInnerTexts();

  await setVoiceGuide(
    'Plain words, short sentences, no hype. Write like a tired carpenter explaining something at the end of the day.',
  );
  await page.getByTestId('brainstorm-ask-again').click();
  await expect(page.getByTestId('brainstorm-pending')).toHaveCount(0);
  await expect(page.getByTestId('brainstorm-provenance')).toContainText(
    'voice guide',
  );
  const after = await page.getByTestId('suggestion-text').allInnerTexts();

  // Visibly different, and not by one word: the guide is part of what the
  // prompt is built from, so a different guide is a different answer.
  expect(after).not.toEqual(before);
  expect(after.filter((title) => before.includes(title)).length).toBeLessThan(
    after.length,
  );

  await panel(page).screenshot({
    path: 'e2e/screenshots/m8-voice-guide-applied.png',
  });
});

/* -------------------------------------------------------------------------- */
/* Review 1 — the key never reaches the browser                                */
/* -------------------------------------------------------------------------- */

/**
 * The build-output grep is the real proof of this and it lives in
 * `docs/MILESTONES.md`, because a key that has already shipped in a bundle
 * cannot be un-shipped. This is the runtime half of the same claim: with the
 * feature actually being used, the browser neither receives the key's name nor
 * talks to the vendor. The call is a POST to this origin and nothing else.
 */
test('the review: the browser never sees the key, and never talks to the vendor', async ({
  page,
}) => {
  const videoId = await capture('Sharpening a chisel properly');
  await signIn(page);

  const offsite: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
      offsite.push(url);
    }
  });

  await openPanel(page, videoId);
  await page.getByTestId('brainstorm-ask-again').click();
  await expect(page.getByTestId('brainstorm-pending')).toHaveCount(0);
  await expect(suggestions(page).first()).toBeVisible();

  // Nothing left this origin. In particular nothing went to api.anthropic.com:
  // the model call is made by the server action, on the server.
  expect(offsite).toEqual([]);

  // And no script the page loaded carries the key's name, the vendor's host or
  // the header it would travel in. This walks what the browser actually
  // fetched, which is a stronger statement than grepping one directory.
  const scripts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('script[src]')).map(
      (element) => (element as HTMLScriptElement).src,
    ),
  );
  expect(scripts.length).toBeGreaterThan(0);
  for (const src of scripts) {
    const body = await (await page.request.get(src)).text();
    expect(body).not.toContain('ANTHROPIC_API_KEY');
    expect(body).not.toContain('api.anthropic.com');
    expect(body).not.toContain('x-api-key');
  }

  // The served HTML is not a hiding place either.
  const html = await page.content();
  expect(html).not.toContain('ANTHROPIC_API_KEY');
  expect(html).not.toContain('api.anthropic.com');
});

/* -------------------------------------------------------------------------- */
/* Review 2 — a 21-title answer is clamped, not discarded                      */
/* -------------------------------------------------------------------------- */

test('the review: an over-eager answer is cut to fit and says what it cut', async ({
  page,
}) => {
  // The fixtures read a scenario out of the video's own text, so this is an
  // ordinary row rather than a mocked transport: the answer really does arrive
  // one item past what was asked for, and the clamp really is the app's.
  const videoId = await capture(
    'Sharpening a chisel properly',
    'Notes with a marker in them. [[assist:overflow]]',
  );
  await signIn(page);
  await openPanel(page, videoId);

  // Discarded would be an empty panel and a shrug. Clamped is twenty usable
  // proposals and a sentence about the one that did not fit.
  await expect(suggestions(page)).toHaveCount(MAX_TITLES);
  await expect(page.getByTestId('brainstorm-meta')).toContainText('overshot');
  await expect(page.getByTestId('brainstorm-meta')).toContainText('past the');

  // Still a working panel: the twenty that arrived are all acceptable.
  await expect(suggestions(page).first().getByTestId('suggestion-add')).toBeEnabled();

  await panel(page).screenshot({ path: 'e2e/screenshots/m8-clamped.png' });
});

/* -------------------------------------------------------------------------- */
/* Review 3 — a refusal is a message, not a crash                              */
/* -------------------------------------------------------------------------- */

test('the review: a refusal is a sentence, the page survives it, and the block keeps saving', async ({
  page,
}) => {
  const videoId = await capture(
    'Sharpening a chisel properly',
    'Notes the model will not answer about. [[assist:refused]]',
  );

  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(String(error)));

  await signIn(page);
  await page.goto(`/videos/${videoId}`);
  await untilTaken(
    async () => {
      if ((await panel(page).count()) === 0) await pill(page).click();
    },
    () => expect(panel(page)).toBeVisible({ timeout: 2_000 }),
  );

  // A sentence a person can act on, in the panel, where they were looking.
  const failure = page.getByTestId('brainstorm-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('declined');
  await expect(failure).toContainText('Nothing was changed');

  // Not a crash: no unhandled error, and the page is still the page.
  expect(crashes).toEqual([]);
  await expect(page.getByTestId('working-title')).toBeVisible();

  await panel(page).screenshot({ path: 'e2e/screenshots/m8-refusal.png' });

  // And the rest of the block still works — a failed brainstorm must not take
  // the packaging fields down with it. This is an ordinary edit through the
  // ordinary save queue, landing in Postgres.
  await page.getByTestId('working-title').fill('Flatten the back first');
  await page.getByTestId('working-title').blur();
  await expect
    .poll(async () => {
      const row = await db.query<{ title: string }>(
        'select title from public.videos where id = $1',
        [videoId],
      );
      return row.rows[0].title;
    })
    .toBe('Flatten the back first');

  // Nothing was written to the column either: a refusal leaves no answer
  // behind to be mistaken for one tomorrow.
  const stored = await db.query<{ brainstorm_last: unknown }>(
    'select brainstorm_last from public.videos where id = $1',
    [videoId],
  );
  expect(stored.rows[0].brainstorm_last).toBeNull();
});
