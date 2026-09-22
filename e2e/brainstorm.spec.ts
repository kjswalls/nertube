import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import {
  CHANNEL_DEFAULTS,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
} from '../lib/defaults';
import { MAX_CANDIDATES } from '../lib/packaging';
import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';
import { untilTaken } from './hydration';

/**
 * M8 — the brainstorm panel on the packaging block.
 *
 * ## Why this suite can exist at all
 *
 * A model call is slow, non-deterministic, occasionally refuses and costs
 * money, so a suite that made one would be a suite that flakes, cannot assert
 * on a suggestion and charges for every run. `ASSIST_PROVIDER=fake`
 * (`playwright.config.ts`) puts the deterministic fixtures behind the same
 * interface instead: everything else here is the code that ships — the real
 * pill, the real panel, the real server action, the real `updateVideo` save
 * queue and the real `brainstorm_last` column, against the real PostgREST +
 * RLS stack.
 *
 * The fixtures take a scenario from a marker in the video's own notes
 * (`[[assist:refused]]`), which is why the failure walks below are ordinary
 * rows rather than a mocked transport.
 */

const CHANNEL = { name: 'M8 Brainstorm', slug: 'm8-brainstorm' };

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

interface Row {
  title_candidates: {
    id: string;
    text: string;
    note?: string;
    chosen?: boolean;
    source?: string;
  }[];
  hooks: { id: string; text: string; chosen?: boolean }[];
  brainstorm_last: {
    v: number;
    titles?: {
      at: string;
      /** Which implementation answered — asserted, not decorative. */
      provider: string;
      suggestions: { text: string }[];
      recommended: number | null;
    };
    hooks?: { at: string; suggestions: { text: string }[] };
  } | null;
}

async function readRow(videoId: string): Promise<Row> {
  const result = await db.query<Row>(
    'select title_candidates, hooks, brainstorm_last from public.videos where id = $1',
    [videoId],
  );
  return result.rows[0];
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
 * The click is retried until the page takes it, through `untilTaken` — see
 * `e2e/hydration.ts`. `/videos/[id]` renders on the server and its controls are
 * real HTML before any JavaScript runs, so a click inside the hydration window
 * is swallowed silently, and this route is one of the heaviest in the app. The
 * act is made idempotent by clicking only while the panel is absent: the pill
 * is a toggle, so a blind second click would close what the first one opened.
 */
async function openPanel(page: Page, videoId: string): Promise<void> {
  await page.goto(`/videos/${videoId}`);
  await untilTaken(
    async () => {
      if ((await panel(page).count()) === 0) await pill(page).click();
    },
    () => expect(panel(page)).toBeVisible({ timeout: 2_000 }),
  );
}

async function expectAnswered(page: Page): Promise<void> {
  await expect(page.getByTestId('brainstorm-pending')).toHaveCount(0);
  await expect(suggestions(page).first()).toBeVisible();
}

/* -------------------------------------------------------------------------- */
/* 1. The panel, its rationales and its pick                                   */
/* -------------------------------------------------------------------------- */

test('the pill opens a panel of proposals, each with a rationale and one marked as the pick', async ({
  page,
}) => {
  const videoId = await capture('Sharpening a chisel properly');
  await signIn(page);
  await openPanel(page, videoId);
  await expectAnswered(page);

  // BRIEF.md asks for 10–20 candidates, not three.
  const count = await suggestions(page).count();
  expect(count).toBeGreaterThanOrEqual(10);
  expect(count).toBeLessThanOrEqual(20);

  // The rationale is the point: every proposal carries one.
  for (const rationale of await page.getByTestId('suggestion-rationale').all()) {
    expect((await rationale.innerText()).trim().length).toBeGreaterThan(10);
  }

  // Exactly one is the model's own pick, and it says why.
  await expect(page.getByTestId('brainstorm-pick-badge')).toHaveCount(1);
  const picked = suggestions(page).filter({ has: page.getByTestId('brainstorm-pick-badge') });
  await expect(picked).toHaveCount(1);
  await expect(picked.getByTestId('suggestion-rationale')).toContainText(
    'Why it picked this one:',
  );

  // Proposals are not the user's writing yet, and say so.
  await expect(picked.getByText('Proposal')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* 2. Accepting: one, all, and as a hook                                       */
/* -------------------------------------------------------------------------- */

test('adding one lands in the candidate list, in the row, with its reason and an ai marker', async ({
  page,
}) => {
  const videoId = await capture('Sharpening a chisel properly');
  await signIn(page);
  await openPanel(page, videoId);
  await expectAnswered(page);

  const first = suggestions(page).first();
  const text = (await first.getByTestId('suggestion-text').innerText()).trim();
  const reason = (await first.getByTestId('suggestion-rationale').innerText()).trim();

  await first.getByTestId('suggestion-add').click();
  await expect(page.getByTestId('brainstorm-notice')).toContainText('Added 1 candidate');

  // In the field on the page…
  await expect(page.getByTestId('candidate-row')).toHaveCount(1);
  await expect(page.getByTestId('candidate-text').first()).toHaveValue(text);

  // …and in the column, through the packaging block's own save path.
  await expect(page.getByTestId('packaging-save-status')).toHaveText(/^Saved$/);
  const row = await readRow(videoId);
  expect(row.title_candidates).toHaveLength(1);
  expect(row.title_candidates[0].text).toBe(text);
  expect(row.title_candidates[0].source).toBe('ai');
  expect(row.title_candidates[0].note).toBeTruthy();
  expect(reason).toContain(row.title_candidates[0].note!.replace(/…$/, ''));

  // Offering the same one twice is not a longer list: the button says so.
  await expect(first.getByTestId('suggestion-add')).toBeDisabled();
  await expect(first.getByTestId('suggestion-add')).toHaveText('Already a candidate');
});

test('"Add all" lands every proposal in one save', async ({ page }) => {
  const videoId = await capture('Sharpening a chisel properly');
  await signIn(page);
  await openPanel(page, videoId);
  await expectAnswered(page);

  const offered = await suggestions(page).count();
  await page.getByTestId('brainstorm-add-all').click();
  await expect(page.getByTestId('brainstorm-notice')).toContainText(
    `Added ${offered} candidates`,
  );
  await expect(page.getByTestId('packaging-save-status')).toHaveText(/^Saved$/);

  const row = await readRow(videoId);
  expect(row.title_candidates).toHaveLength(offered);
  expect(row.title_candidates.every((candidate) => candidate.source === 'ai')).toBe(true);

  // Doing it twice adds nothing and says why rather than doubling the list.
  await page.getByTestId('brainstorm-add-all').click();
  await expect(page.getByTestId('brainstorm-notice')).toContainText(
    'already',
  );
  expect((await readRow(videoId)).title_candidates).toHaveLength(offered);
});

test('"Use as hook" lands in the hooks list and respects the three-hook ceiling', async ({
  page,
}) => {
  const videoId = await capture('Sharpening a chisel properly');
  await signIn(page);
  await openPanel(page, videoId);
  await expectAnswered(page);

  for (let index = 0; index < 3; index += 1) {
    await suggestions(page).nth(index).getByTestId('suggestion-hook').click();
    await expect(page.getByTestId('packaging-save-status')).toHaveText(/^Saved$/);
  }

  await expect(page.getByTestId('hook-row')).toHaveCount(3);
  expect((await readRow(videoId)).hooks).toHaveLength(3);

  // The ceiling is said before the person picks, not after.
  await expect(page.getByTestId('brainstorm-capacity')).toContainText(
    'which is the limit',
  );
  await expect(suggestions(page).nth(3).getByTestId('suggestion-hook')).toBeDisabled();
});

/* -------------------------------------------------------------------------- */
/* 3. `brainstorm_last`                                                        */
/* -------------------------------------------------------------------------- */

test('the answer is kept: closing and reopening shows it as from earlier, and costs no call', async ({
  page,
}) => {
  const videoId = await capture('Sharpening a chisel properly');
  await signIn(page);
  await openPanel(page, videoId);
  await expectAnswered(page);

  await expect(page.getByTestId('brainstorm-provenance')).toContainText('Fresh, just now');
  const stored = await readRow(videoId);
  expect(stored.brainstorm_last?.titles?.suggestions.length).toBeGreaterThan(0);
  const askedAt = stored.brainstorm_last!.titles!.at;

  // Closed and reopened in the same page: the answer survives the unmount.
  await page.getByTestId('brainstorm-close').click();
  await expect(panel(page)).toHaveCount(0);
  await pill(page).click();
  await expect(suggestions(page).first()).toBeVisible();
  await expect(page.getByTestId('brainstorm-provenance')).toContainText('From earlier');

  // Reloaded: the column is what it comes back from, and nothing was re-asked.
  await page.reload();
  await pill(page).click();
  await expect(suggestions(page).first()).toBeVisible();
  await expect(page.getByTestId('brainstorm-provenance')).toContainText('From earlier');
  expect((await readRow(videoId)).brainstorm_last!.titles!.at).toBe(askedAt);

  // Asking again is one click, and replaces it.
  await page.getByTestId('brainstorm-ask-again').click();
  await expect(page.getByTestId('brainstorm-provenance')).toContainText('Fresh, just now');
  expect((await readRow(videoId)).brainstorm_last!.titles!.at).not.toBe(askedAt);
});

/* -------------------------------------------------------------------------- */
/* 3b. A fixture never passes itself off as a model                            */
/* -------------------------------------------------------------------------- */

/**
 * The one failure in this feature that cannot be seen from the outside.
 *
 * Everything in this suite, and every browser walk that was ever done in the
 * container this was built in, runs against `lib/assist/fake.ts`: there is no
 * `ANTHROPIC_API_KEY` here and no route to `api.anthropic.com`. The fixtures
 * return plausible titles with plausible reasons — they read *exactly* like an
 * answer. A person shown these while believing a model wrote them would be
 * wrong about the only thing the panel is for, and nothing on the screen would
 * contradict them.
 *
 * So the panel says which answered, every time, and this is the assertion that
 * keeps it saying it. It is the one spec in here that would still be worth
 * running the day a real key exists: on that deployment `ASSIST_PROVIDER` is
 * unset, the line is absent, and this test would fail — which is the correct
 * failure, and says out loud that the suite is no longer testing the fixtures.
 */
test('an answer from the fixtures says so, and names the variable that caused it', async ({
  page,
}) => {
  const videoId = await capture('Sharpening a chisel properly');
  await signIn(page);
  await openPanel(page, videoId);
  await expectAnswered(page);

  const said = page.getByTestId('brainstorm-fixtures');
  await expect(said).toBeVisible();
  await expect(said).toContainText('not from Claude');
  await expect(said).toContainText('built-in fixtures');

  // The sentence deliberately does not spell `ANTHROPIC_API_KEY`: this is a
  // client component, and that string in `.next/static` would cost PLAN.md's
  // "grep the build output" review item its bright line. It points at the
  // README instead. See the doc comment on `AssistProvenance`.
  await expect(said).not.toContainText('ANTHROPIC_API_KEY');

  // And it is a property of the answer, not of the sitting: the stored entry
  // records who answered, so a reopened panel makes the same admission.
  expect((await readRow(videoId)).brainstorm_last!.titles!.provider).toBe('fake');
  await page.getByTestId('brainstorm-close').click();
  await pill(page).click();
  await expect(page.getByTestId('brainstorm-fixtures')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* 4. The voice guide changes the answer                                       */
/* -------------------------------------------------------------------------- */

test('changing the channel voice guide visibly changes the suggestions', async ({
  page,
}) => {
  const videoId = await capture('Sharpening a chisel properly');
  await signIn(page);
  await openPanel(page, videoId);
  await expectAnswered(page);

  await expect(page.getByTestId('brainstorm-provenance')).toContainText(
    'no voice guide',
  );
  const before = await page.getByTestId('suggestion-text').allInnerTexts();

  await setVoiceGuide(
    'Plain words, short sentences, no hype. Write like a tired carpenter explaining something at the end of the day.',
  );

  await page.getByTestId('brainstorm-ask-again').click();
  await expect(page.getByTestId('brainstorm-provenance')).toContainText(
    'voice guide',
  );
  await expectAnswered(page);
  const after = await page.getByTestId('suggestion-text').allInnerTexts();

  expect(after.join('\n')).not.toBe(before.join('\n'));
});

/* -------------------------------------------------------------------------- */
/* 5. Every failure is a sentence, and the page stays usable                   */
/* -------------------------------------------------------------------------- */

const FAILURES = [
  'refused',
  'timeout',
  'rate_limited',
  'upstream',
  'unreachable',
  'unauthorized',
  'rejected',
  'malformed',
  'wrong_shape',
  'empty',
  'not_configured',
] as const;

for (const scenario of FAILURES) {
  test(`a ${scenario} failure becomes a sentence, and the block keeps working`, async ({
    page,
  }) => {
    const videoId = await capture('Sharpening a chisel properly', `[[assist:${scenario}]]`);
    await signIn(page);
    await openPanel(page, videoId);

    const failure = page.getByTestId('brainstorm-failure');
    await expect(failure).toBeVisible();
    await expect(failure).toHaveAttribute('data-code', scenario);

    // A sentence, not a stack trace or a status code.
    const message = await page.getByTestId('brainstorm-failure-message').innerText();
    expect(message.trim().length).toBeGreaterThan(20);
    expect(message).not.toMatch(/\bError\b:|at Object\.|\b[45]\d\d\b/);
    await expect(failure).toContainText('Nothing was changed');

    // Retrying is one click away…
    await expect(page.getByTestId('brainstorm-retry')).toBeVisible();
    // …and nothing was written to the row.
    expect((await readRow(videoId)).brainstorm_last).toBeNull();

    // The rest of the page is untouched: the candidate list still works.
    await page.getByTestId('candidate-input').fill('A title I wrote myself');
    await page.getByTestId('candidate-add').click();
    await expect(page.getByTestId('packaging-save-status')).toHaveText(/^Saved$/);
    expect((await readRow(videoId)).title_candidates).toHaveLength(1);
  });
}

/* -------------------------------------------------------------------------- */
/* 6. In flight: the wait is visible, and cancellable                          */
/* -------------------------------------------------------------------------- */

test('a slow call shows the wait, keeps the page usable, and can be cancelled', async ({
  page,
}) => {
  const videoId = await capture('Sharpening a chisel properly');
  await signIn(page);

  /*
    The fixtures answer immediately, so the wait is created here: the server
    action's POST is held for a few seconds. What is being tested is this app's
    behaviour while something is in flight — which is the same whether the
    delay is the network or a model thinking.
  */
  let release: () => void = () => {};
  await page.route(
    (url) => url.pathname === `/videos/${videoId}`,
    async (route, request) => {
      if (request.method() !== 'POST') {
        await route.fallback();
        return;
      }
      await new Promise<void>((resolve) => {
        release = resolve;
        setTimeout(resolve, 8_000);
      });
      await route.continue();
    },
  );

  await page.goto(`/videos/${videoId}`);
  await pill(page).click();

  const pending = page.getByTestId('brainstorm-pending');
  await expect(pending).toBeVisible();
  await expect(page.getByTestId('brainstorm-elapsed')).toBeVisible();

  // The rest of the page still works while it waits.
  await page.getByTestId('candidate-input').fill('Written while it thinks');
  await expect(page.getByTestId('candidate-input')).toHaveValue('Written while it thinks');

  await page.getByTestId('brainstorm-cancel').click();
  await expect(pending).toHaveCount(0);
  await expect(page.getByTestId('brainstorm-notice')).toContainText('Stopped waiting');
  await expect(suggestions(page)).toHaveCount(0);

  // The answer that arrives afterwards is dropped rather than landing in a
  // panel the person has moved on from.
  release();
  await expect(suggestions(page)).toHaveCount(0);
  await expect(page.getByTestId('brainstorm-notice')).toContainText('Stopped waiting');
});

/* -------------------------------------------------------------------------- */
/* 7. A full list refuses before the person picks                              */
/* -------------------------------------------------------------------------- */

test('a candidate list at its ceiling says so, and the add buttons are already off', async ({
  page,
}) => {
  const videoId = await capture('Sharpening a chisel properly');
  const full = Array.from({ length: MAX_CANDIDATES }, (_value, index) => ({
    id: `seed-${index}`,
    text: `An existing candidate number ${index}`,
    chosen: false,
    source: 'manual',
  }));
  await asUser(async () => {
    await db.query('update public.videos set title_candidates = $2::jsonb where id = $1', [
      videoId,
      JSON.stringify(full),
    ]);
  });

  await signIn(page);
  await openPanel(page, videoId);
  await expectAnswered(page);

  await expect(page.getByTestId('brainstorm-capacity')).toContainText(
    `full at ${MAX_CANDIDATES}`,
  );
  await expect(page.getByTestId('brainstorm-add-all')).toBeDisabled();
  await expect(suggestions(page).first().getByTestId('suggestion-add')).toBeDisabled();

  // Nothing was added by looking at it.
  expect((await readRow(videoId)).title_candidates).toHaveLength(MAX_CANDIDATES);

  // And the other list still works: a hook can still be taken.
  await suggestions(page).first().getByTestId('suggestion-hook').click();
  await expect(page.getByTestId('packaging-save-status')).toHaveText(/^Saved$/);
  expect((await readRow(videoId)).hooks).toHaveLength(1);
});

/* -------------------------------------------------------------------------- */
/* 8. An over-eager answer is clamped, not discarded                           */
/* -------------------------------------------------------------------------- */

test('an answer past the ceiling is cut to fit and says what it cut', async ({ page }) => {
  const videoId = await capture('Sharpening a chisel properly', '[[assist:overflow]]');
  await signIn(page);
  await openPanel(page, videoId);
  await expectAnswered(page);

  // Clamped, not thrown away.
  const count = await suggestions(page).count();
  expect(count).toBeGreaterThanOrEqual(10);
  expect(count).toBeLessThanOrEqual(20);
  await expect(page.getByTestId('brainstorm-meta')).toContainText('overshot');
});

/* -------------------------------------------------------------------------- */
/* 9. The hooks half of the same panel                                         */
/* -------------------------------------------------------------------------- */

test('the hooks pill opens the same panel on its hooks, and they land in the hooks list', async ({
  page,
}) => {
  const videoId = await capture('Sharpening a chisel properly');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  await untilTaken(
    () =>
      page.locator('[data-testid="assist-pill"][data-assist="Draft a third"]').click(),
    () => expect(panel(page)).toHaveAttribute('data-kind', 'hooks', { timeout: 2_000 }),
  );
  await expectAnswered(page);

  // A hook proposal has a rationale too, and no "add as candidate".
  await expect(suggestions(page).first().getByTestId('suggestion-rationale')).toBeVisible();
  await expect(suggestions(page).first().getByTestId('suggestion-add')).toHaveCount(0);

  const text = (
    await suggestions(page).first().getByTestId('suggestion-text').innerText()
  ).trim();
  await suggestions(page).first().getByTestId('suggestion-hook').click();
  await expect(page.getByTestId('packaging-save-status')).toHaveText(/^Saved$/);

  const row = await readRow(videoId);
  expect(row.hooks).toHaveLength(1);
  expect(row.hooks[0].text).toBe(text);
  expect(row.brainstorm_last?.hooks?.suggestions.length).toBeGreaterThan(0);

  // Switching to the titles asks the other question, and switching back keeps
  // the hooks that were already answered rather than asking for them again.
  const hooksAskedAt = (await readRow(videoId)).brainstorm_last!.hooks!.at;
  await page.getByTestId('brainstorm-tab-titles').click();
  await expect(panel(page)).toHaveAttribute('data-kind', 'titles');
  await expectAnswered(page);
  await expect(page.getByTestId('suggestion-add').first()).toBeVisible();

  await page.getByTestId('brainstorm-tab-hooks').click();
  await expect(panel(page)).toHaveAttribute('data-kind', 'hooks');
  await expect(suggestions(page).first()).toBeVisible();
  await expect(page.getByTestId('suggestion-add')).toHaveCount(0);
  expect((await readRow(videoId)).brainstorm_last!.hooks!.at).toBe(hooksAskedAt);
});
