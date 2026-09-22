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
 * M8 — the assist controls that are *not* the title brainstorm: the concepts
 * beside the written thumbnail concept, the third hook, and the critique of
 * the three uploaded variants.
 *
 * ## Why this suite can exist at all
 *
 * `ASSIST_PROVIDER=fake` (`playwright.config.ts`) puts `lib/assist/fake.ts`
 * behind the provider interface, so every run is deterministic, offline and
 * free. Everything else is the code that ships: the real pills, the real
 * panels, the real server actions, the real `updateVideo` save queue, the real
 * `swap_thumbnail` security-definer function and the real `brainstorm_last`
 * column, against the real PostgREST + RLS stack.
 *
 * The fixtures take a scenario from a marker in the video's own text
 * (`[[assist:refused]]`), which is why the failure walks below are ordinary
 * rows rather than a mocked transport.
 *
 * ## What it is trying to prove
 *
 * One thing per affordance, and the same thing each time: it **generates**, it
 * **presents** the answer as a proposal rather than as your writing, and
 * **accepting lands in the right field** — checked in Postgres, because a
 * paragraph appearing on screen is not evidence that a column changed.
 */

const CHANNEL = { name: 'M8 Fields', slug: 'm8-fields' };

/** Differently sized, so "which image is this" is answerable from the bytes. */
const WILD = { name: 'wild.png', mimeType: 'image/png', buffer: makePng(4, 2, [220, 40, 40]) };
const MODERATE = {
  name: 'moderate.png',
  mimeType: 'image/png',
  buffer: makePng(6, 3, [40, 160, 90]),
};

type Role = 'wild_card' | 'moderate' | 'safe';

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
    throw new Error(`the dev stack has no user ${SEED_EMAIL}`);
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
           where c.slug = $1)`,
    [CHANNEL.slug],
  );
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug = $1)`,
    [CHANNEL.slug],
  );
  await db.query('delete from public.channels where slug = $1', [CHANNEL.slug]);
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

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}

/* -------------------------------------------------------------------------- */
/* Reading the row back                                                        */
/* -------------------------------------------------------------------------- */

async function conceptOf(videoId: string): Promise<string | null> {
  const result = await db.query<{ thumbnail_concept: string | null }>(
    'select thumbnail_concept from public.videos where id = $1',
    [videoId],
  );
  return result.rows[0].thumbnail_concept;
}

async function hooksOf(videoId: string): Promise<{ text: string; chosen: boolean }[]> {
  const result = await db.query<{ hooks: { text: string; chosen: boolean }[] | null }>(
    'select hooks from public.videos where id = $1',
    [videoId],
  );
  return result.rows[0].hooks ?? [];
}

async function brainstormKinds(videoId: string): Promise<string[]> {
  const result = await db.query<{ keys: string[] | null }>(
    `select case when brainstorm_last is null then null
                 else array(select jsonb_object_keys(brainstorm_last)) end as keys
       from public.videos where id = $1`,
    [videoId],
  );
  return (result.rows[0].keys ?? []).filter((key) => key !== 'v').sort();
}

async function shippedRoleOf(videoId: string): Promise<string | null> {
  const result = await db.query<{ shipped_role: string | null }>(
    'select shipped_role from public.videos where id = $1',
    [videoId],
  );
  return result.rows[0].shipped_role;
}

async function swapLog(
  videoId: string,
): Promise<{ from_role: string | null; to_role: string; reason: string }[]> {
  const result = await db.query<{
    from_role: string | null;
    to_role: string;
    reason: string;
  }>(
    `select from_role, to_role, reason from public.thumbnail_swaps
      where video_id = $1 order by swapped_at asc, id asc`,
    [videoId],
  );
  return result.rows;
}

/* -------------------------------------------------------------------------- */
/* Driving the page                                                            */
/* -------------------------------------------------------------------------- */

const pill = (page: Page, verb: string): Locator =>
  page.locator(`[data-testid="assist-pill"][data-assist="${verb}"]`);

const slot = (page: Page, role: Role): Locator =>
  page.locator(`[data-testid="variant-slot"][data-role="${role}"]`);

const concept = (page: Page): Locator => page.getByTestId('thumbnail-concept');

async function openPackaging(page: Page, videoId: string): Promise<void> {
  await page.goto(`/videos/${videoId}`);
  await expect(page.getByTestId('packaging-block')).toBeVisible();
}

async function upload(
  page: Page,
  role: Role,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await slot(page, role).getByTestId('variant-file').setInputFiles(file);
  await expect(slot(page, role).getByTestId('variant-status')).toHaveText(/saved$/);
}

/** Everything the row must say before a packaging edit counts as landed. */
async function savedCleanly(page: Page): Promise<void> {
  await expect(page.getByTestId('packaging-save-status')).toHaveText(/^Saved$/);
}

/* -------------------------------------------------------------------------- */
/* 1. Thumbnail concepts — a proposal that replaces a field, and can be undone */
/* -------------------------------------------------------------------------- */

test('suggest concepts: generates, presents as proposals, and writes the concept box', async ({
  page,
}) => {
  const videoId = await capture('Filming in a tiny room');
  await openPackaging(page, videoId);

  // Nothing yet, and the box is empty.
  await expect(concept(page)).toHaveValue('');
  await pill(page, 'Suggest concepts').click();

  const panel = page.getByTestId('concept-assist-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('concept-assist-provenance')).toContainText(
    'Fresh, just now',
  );

  // Four proposals, each drawn as the tool talking, each with its reason.
  const proposals = page.getByTestId('concept-assist-suggestion');
  await expect(proposals).toHaveCount(4);
  await expect(proposals.first().getByText('Proposal')).toBeVisible();
  await expect(proposals.first().getByTestId('suggestion-rationale')).not.toBeEmpty();

  // Exactly one is marked as the model's own pick.
  await expect(panel.getByTestId('assist-pick-badge')).toHaveCount(1);

  // The concept is a *description of a shot*, and the panel says so where the
  // two ideas are most likely to be confused. BRIEF.md principle 2.
  await expect(panel).toContainText('description of a shot');
  await expect(panel).toContainText('not a picture');

  const proposed = (await proposals.first().getByTestId('suggestion-text').innerText()).trim();

  await proposals.first().getByTestId('suggestion-use').click();

  // It landed in the field — as the person's own text, in the box they type in.
  await expect(concept(page)).toHaveValue(proposed);
  await savedCleanly(page);
  expect(await conceptOf(videoId)).toBe(proposed);

  // And it stopped being a proposal that can be taken twice.
  await expect(proposals.first().getByTestId('suggestion-use')).toBeDisabled();
  await expect(proposals.first().getByTestId('suggestion-use')).toHaveText(
    'Already the concept',
  );

  // The answer is kept in the video's own row, under its own key, beside
  // whatever the title panel has asked for.
  expect(await brainstormKinds(videoId)).toEqual(['concepts']);
});

test('suggest concepts: replacing what you wrote is one press, and so is putting it back', async ({
  page,
}) => {
  const videoId = await capture('The desk tour nobody asked for');
  await openPackaging(page, videoId);

  const mine = 'Me, unimpressed, holding the broken tripod. No text.';
  await concept(page).fill(mine);
  await savedCleanly(page);

  await pill(page, 'Suggest concepts').click();
  const proposals = page.getByTestId('concept-assist-suggestion');
  await expect(proposals.first()).toBeVisible();

  // The button says what it will do to the sentence already in the box.
  const take = proposals.first().getByTestId('suggestion-use');
  await expect(take).toHaveText('Replace the concept');

  const proposed = (await proposals.first().getByTestId('suggestion-text').innerText()).trim();
  await take.click();

  await expect(concept(page)).toHaveValue(proposed);
  await savedCleanly(page);
  expect(await conceptOf(videoId)).toBe(proposed);

  // The undo is in the notice, next to the click that caused it.
  const notice = page.getByTestId('concept-assist-notice');
  await expect(notice).toContainText('Replaced the concept');
  await page.getByTestId('concept-assist-undo').click();

  await expect(concept(page)).toHaveValue(mine);
  await savedCleanly(page);
  expect(await conceptOf(videoId)).toBe(mine);
});

test('suggest concepts: reopening is free and says the answer is from earlier', async ({
  page,
}) => {
  const videoId = await capture('Six months of cold showers');
  await openPackaging(page, videoId);

  await pill(page, 'Suggest concepts').click();
  await expect(page.getByTestId('concept-assist-suggestion').first()).toBeVisible();
  await page.getByTestId('concept-assist-close').click();
  await expect(page.getByTestId('concept-assist-panel')).toHaveCount(0);

  // The pill says there is something kept, and opening it again shows it
  // without asking the model a second time.
  await expect(pill(page, 'Suggest concepts')).toContainText('saved');
  await pill(page, 'Suggest concepts').click();
  await expect(page.getByTestId('concept-assist-provenance')).toContainText('From earlier');

  // A full reload reads it back out of `brainstorm_last` rather than re-asking.
  await openPackaging(page, videoId);
  await pill(page, 'Suggest concepts').click();
  await expect(page.getByTestId('concept-assist-provenance')).toContainText('From earlier');
  await expect(page.getByTestId('concept-assist-suggestion')).toHaveCount(4);
});

/* -------------------------------------------------------------------------- */
/* 2. The third hook — drafted against the title and concept already chosen    */
/* -------------------------------------------------------------------------- */

test('draft a third: a hook proposal lands in the hooks list', async ({ page }) => {
  const videoId = await capture('I read 52 books in a year');
  await openPackaging(page, videoId);

  // The packaging it belongs to: a chosen title and a written concept. The
  // prompt carries both, which is the whole reason this pill is on this block.
  await concept(page).fill('Stack of books to the ceiling, me peering around it.');
  await savedCleanly(page);

  await pill(page, 'Draft a third').click();
  const panel = page.getByTestId('brainstorm-panel');
  await expect(panel).toHaveAttribute('data-kind', 'hooks');

  const first = page.getByTestId('brainstorm-suggestion').first();
  await expect(first).toBeVisible();
  const proposed = (await first.getByTestId('suggestion-text').innerText()).trim();

  await first.getByTestId('suggestion-hook').click();
  await savedCleanly(page);

  await expect(page.getByTestId('hook-text').first()).toContainText(proposed);
  const hooks = await hooksOf(videoId);
  expect(hooks.map((hook) => hook.text)).toContain(proposed);
});

/* -------------------------------------------------------------------------- */
/* 3. The critique — three files judged, and the one it would ship             */
/* -------------------------------------------------------------------------- */

test('critique: nothing to judge says so rather than being a button that does nothing', async ({
  page,
}) => {
  const videoId = await capture('Nothing uploaded yet');
  await page.goto(`/videos/${videoId}?section=thumbnails`);

  await expect(pill(page, 'Critique at tile size')).toBeDisabled();
  await expect(page.getByTestId('critique-nothing')).toBeVisible();
});

test('critique: judges the uploaded variants, and accepting ships one', async ({ page }) => {
  const videoId = await capture('The cheapest camera that is still good');
  await db.query('update public.videos set thumbnail_concept = $2 where id = $1', [
    videoId,
    'Two cameras on the desk, one crossed out.',
  ]);

  await page.goto(`/videos/${videoId}?section=thumbnails`);
  await upload(page, 'wild_card', WILD);
  await upload(page, 'moderate', MODERATE);

  await expect(pill(page, 'Critique at tile size')).toBeEnabled();
  await expect(pill(page, 'Critique at tile size')).toContainText('2/3');
  await pill(page, 'Critique at tile size').click();

  const panel = page.getByTestId('critique-panel');
  await expect(panel).toBeVisible();

  // One verdict per image that was sent, and no verdict about the empty slot.
  const verdicts = page.getByTestId('critique-verdict');
  await expect(verdicts).toHaveCount(2);
  await expect(page.locator('[data-testid="critique-verdict"][data-role="safe"]')).toHaveCount(
    0,
  );

  // Each verdict answers the two questions the packaging checklist asks, in
  // words rather than as a tick.
  const wild = page.locator('[data-testid="critique-verdict"][data-role="wild_card"]');
  await expect(wild.getByTestId('critique-reads')).toBeVisible();
  await expect(wild.getByTestId('critique-complements')).toBeVisible();
  await expect(wild.getByTestId('critique-note')).not.toBeEmpty();

  // It is a judgement about images, not an image: nothing here is offered as
  // a file, and the panel says the verdict is not kept.
  await expect(panel).toContainText('Not kept');

  // Accepting means shipping the one it would ship. Nothing is live yet, so
  // this is the first ship: one click, logged as chosen at launch.
  await wild.getByTestId('critique-ship').click();

  await expect(slot(page, 'wild_card')).toHaveAttribute('data-live', 'true');
  expect(await shippedRoleOf(videoId)).toBe('wild_card');
  const firstLog = await swapLog(videoId);
  expect(firstLog).toHaveLength(1);
  expect(firstLog[0]).toMatchObject({ from_role: null, to_role: 'wild_card' });
  expect(firstLog[0].reason).toBe('Chosen at launch.');

  // The panel stays open — shipping is not closing — and the slot that just
  // went live says so inside it.
  await expect(wild.getByTestId('critique-ship')).toHaveText('Already live');

  // The second acceptance is a *swap*, so it goes through the dialog that
  // demands a reason — with the critique's own sentence in the box, editable,
  // because the log records what the person confirmed.
  const moderate = page.locator('[data-testid="critique-verdict"][data-role="moderate"]');
  await expect(moderate).toBeVisible();
  const moderateNote = (await moderate.getByTestId('critique-note').innerText()).trim();
  await moderate.getByTestId('critique-ship').click();

  const reason = page.getByTestId('swap-reason-input');
  await expect(reason).toHaveValue(moderateNote);
  await expect(page.getByTestId('swap-reason-proposed')).toBeVisible();

  const edited = `${moderateNote.slice(0, 60)} — and I agree.`;
  await reason.fill(edited);
  await page.getByTestId('swap-confirm').click();

  await expect(slot(page, 'moderate')).toHaveAttribute('data-live', 'true');
  expect(await shippedRoleOf(videoId)).toBe('moderate');
  const log = await swapLog(videoId);
  expect(log).toHaveLength(2);
  expect(log[1]).toMatchObject({ from_role: 'wild_card', to_role: 'moderate' });
  expect(log[1].reason).toBe(edited);

  // A critique is about the bytes that were in the bucket when it ran, so it
  // is deliberately not stored — unlike the three text assists.
  expect(await brainstormKinds(videoId)).toEqual([]);

  // Anything already live cannot be "shipped" again from here.
  await expect(moderate.getByTestId('critique-ship')).toBeDisabled();
  await expect(moderate.getByTestId('critique-ship')).toHaveText('Already live');
});

/* -------------------------------------------------------------------------- */
/* 4. Failure, on every one of them, in the same words                         */
/* -------------------------------------------------------------------------- */

test('a refusal is a sentence with “Try anyway”, and changes nothing', async ({ page }) => {
  const videoId = await capture('A topic Claude will not touch [[assist:refused]]');
  await openPackaging(page, videoId);

  await pill(page, 'Suggest concepts').click();
  const failure = page.getByTestId('concept-assist-failure');
  await expect(failure).toHaveAttribute('data-code', 'refused');
  await expect(failure).toContainText('declined');
  await expect(failure).toContainText('Nothing was changed');
  // Not retryable, and the button says so rather than promising a retry that
  // cannot work — but it is still there, because the notes may have changed.
  await expect(page.getByTestId('concept-assist-retry')).toHaveText('Try anyway');

  await expect(page.getByTestId('concept-assist-suggestion')).toHaveCount(0);
  expect(await conceptOf(videoId)).toBeNull();
  expect(await brainstormKinds(videoId)).toEqual([]);
});

test('a rate limit says how long, and the critique fails the same way as the rest', async ({
  page,
}) => {
  const videoId = await capture('Too many asks [[assist:rate_limited]]');
  await page.goto(`/videos/${videoId}?section=thumbnails`);
  await upload(page, 'safe', MODERATE);

  await pill(page, 'Critique at tile size').click();
  const failure = page.getByTestId('critique-failure');
  await expect(failure).toHaveAttribute('data-code', 'rate_limited');
  await expect(failure).toContainText('wait a moment');
  await expect(failure).toContainText('asked for 12 seconds');
  await expect(page.getByTestId('critique-retry')).toHaveText('Try again');

  // Nothing was shipped, and no log row was written.
  expect(await shippedRoleOf(videoId)).toBeNull();
  expect(await swapLog(videoId)).toHaveLength(0);
});

test('an unusable answer is clamped, and the panel says what it dropped', async ({
  page,
}) => {
  const videoId = await capture('A blank and a monster [[assist:unusable]]');
  await openPackaging(page, videoId);

  await pill(page, 'Suggest concepts').click();

  /*
    The fixture sends a blank suggestion and one far longer than the column
    takes, in front of the four real ones. Neither could be written into
    `thumbnail_concept`, so both are dropped — and the count is said out loud
    rather than being left to look like a model that answered short, which is
    PLAN.md's clamp note in practice.
  */
  await expect(page.getByTestId('concept-assist-suggestion')).toHaveCount(4);
  await expect(page.getByTestId('concept-assist-meta')).toContainText('overshot');
  await expect(page.getByTestId('concept-assist-meta')).toContainText(
    'could not be stored',
  );
});

/* -------------------------------------------------------------------------- */
/* 5. Waiting, and walking away from it                                        */
/* -------------------------------------------------------------------------- */

test('while it thinks the page still works, and cancelling stops the waiting honestly', async ({
  page,
}) => {
  const videoId = await capture('Slow answer');
  await openPackaging(page, videoId);

  /*
    The fixtures answer immediately, so the wait is created here: the server
    action's POST is held in a route until this test lets it go. What is under
    test is this app's behaviour while something is in flight, which is the
    same whether the wait is a network or a model.
  */
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => url.pathname === `/videos/${videoId}`,
    async (route, request) => {
      if (request.method() !== 'POST') return route.fallback();
      await held;
      return route.fallback();
    },
  );

  await pill(page, 'Suggest concepts').click();

  const pending = page.getByTestId('concept-assist-pending');
  await expect(pending).toBeVisible();
  await expect(page.getByTestId('concept-assist-elapsed')).toBeVisible();

  // The rest of the block is not blocked: this is a panel, not a modal.
  await concept(page).fill('Typed while it was thinking.');
  await expect(concept(page)).toHaveValue('Typed while it was thinking.');

  await page.getByTestId('concept-assist-cancel').click();
  await expect(pending).toHaveCount(0);
  await expect(page.getByTestId('concept-assist-notice')).toContainText('Stopped waiting');

  // The answer that arrives after a cancel is not dropped into the panel.
  release();
  await expect(page.getByTestId('concept-assist-suggestion')).toHaveCount(0);

  // And what was typed meanwhile is what the column holds.
  await savedCleanly(page);
  expect(await conceptOf(videoId)).toBe('Typed while it was thinking.');
});

test('closing the panel keeps the answer in the row and touches no field', async ({
  page,
}) => {
  const videoId = await capture('Closed too early');
  await openPackaging(page, videoId);

  await pill(page, 'Suggest concepts').click();
  await expect(page.getByTestId('concept-assist-suggestion').first()).toBeVisible();
  await page.getByTestId('concept-assist-close').click();

  // The column kept it, so the next open is free — which is exactly what
  // `videos.brainstorm_last` is for.
  expect(await brainstormKinds(videoId)).toEqual(['concepts']);
  await expect(concept(page)).toHaveValue('');
  expect(await conceptOf(videoId)).toBeNull();
});

/* -------------------------------------------------------------------------- */
/* 6. One keyboard path, learned once                                          */
/* -------------------------------------------------------------------------- */

test('every panel takes focus when it opens and closes on Escape', async ({ page }) => {
  const videoId = await capture('Keyboard only');
  await openPackaging(page, videoId);

  await pill(page, 'Suggest concepts').click();
  await expect(page.getByTestId('concept-assist-panel')).toBeVisible();
  await expect(page.locator('#concept-assist-heading')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('concept-assist-panel')).toHaveCount(0);

  // The same gesture, on the panel another slice built, from the same chrome.
  await pill(page, 'Draft a third').click();
  await expect(page.getByTestId('brainstorm-panel')).toBeVisible();
  await expect(page.locator('#brainstorm-heading')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('brainstorm-panel')).toHaveCount(0);

  // And on the critique, three sections along.
  await page.goto(`/videos/${videoId}?section=thumbnails`);
  await upload(page, 'safe', WILD);
  await pill(page, 'Critique at tile size').click();
  await expect(page.getByTestId('critique-panel')).toBeVisible();
  await expect(page.locator('#critique-heading')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('critique-panel')).toHaveCount(0);
});
