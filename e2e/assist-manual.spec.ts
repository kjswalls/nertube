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
import { untilTaken } from './hydration';
import { makePng } from './png';

/**
 * M11 — "Open in Claude": every assist, answered by the person's own claude.ai
 * conversation instead of an API key.
 *
 * ## What is real and what is stubbed
 *
 * Real: the page, the three panels, the server actions that build the prompt
 * and read the reply, `createPastedProvider` behind the one `AssistProvider`
 * seam, the clamp, `merge_brainstorm_entry`, the packaging save queue and
 * `swap_thumbnail`, against the real PostgREST + RLS stack. Every claim that
 * something was written is read back out of Postgres.
 *
 * Stubbed, in the page, before any script of the app runs: `window.open` and
 * `navigator.clipboard.writeText`. This suite must never reach claude.ai, and
 * it does not have to — what the app is responsible for is what it hands to
 * those two calls (a prompt; the URL of a new conversation), and the stubs
 * record exactly that. The reply a person would paste back is written here.
 *
 * ## The mode
 *
 * The server runs with `ASSIST_PROVIDER=fake`, so the M8 specs keep their
 * fixtures. This suite sets the `nertube-test-assist-mode=manual` cookie,
 * which `lib/assist/mode.ts` honours only because `playwright.config.ts`
 * starts the server with `NERTUBE_TEST_ASSIST_MODE=1`: the page is then the
 * one a deployment with no API key serves, where Open in Claude is primary.
 */

const CHANNEL = { name: 'M11 Manual', slug: 'm11-manual' };
const MODE_COOKIE = 'nertube-test-assist-mode';

/** Written into the channel, so the copied prompt can be checked for it. */
const VOICE_GUIDE =
  'Dry, specific and slightly tired. Short sentences. British spelling. Never "game changer".';
const PAST_TITLE = 'I edited on a 2015 MacBook for a year';

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
  if (found.rows.length === 0) throw new Error(`the dev stack has no user ${SEED_EMAIL}`);
  userId = found.rows[0].id;
});

test.afterAll(async () => {
  await cleanUp();
  await db?.end();
});

test.beforeEach(async ({ page }) => {
  await cleanUp();
  channelId = await createChannel();
  await stubClaude(page);
  await signIn(page);
});

/* -------------------------------------------------------------------------- */
/* The database                                                                */
/* -------------------------------------------------------------------------- */

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

async function asUser<T>(fn: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated', email: SEED_EMAIL }),
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

  const id = await asUser(async () => {
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
        VOICE_GUIDE,
        JSON.stringify(stages),
        JSON.stringify(SEED_BUCKETS.map((bucket) => ({ ...bucket, monthly_quota: null }))),
      ],
    );
    return result.rows[0].id;
  });

  // One published video, so the prompt has a past title to carry.
  const published = await db.query<{ id: string }>(
    "select id from public.stages where channel_id = $1 and kind = 'published'",
    [id],
  );
  const past = await asUser(async () => {
    const result = await db.query<{ id: string }>(
      'select id from capture_video($1::uuid, $2::text)',
      [id, PAST_TITLE],
    );
    return result.rows[0].id;
  });
  await db.query(
    `update public.videos set stage_id = $2, published_at = now() - interval '30 days' where id = $1`,
    [past, published.rows[0].id],
  );
  return id;
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
  title_candidates: { text: string; note?: string; source?: string }[] | null;
  hooks: { text: string }[] | null;
  thumbnail_concept: string | null;
  shipped_role: string | null;
  brainstorm_last: Record<string, { provider: string; model: string; suggestions: unknown[] }> | null;
}

async function rowOf(videoId: string): Promise<Row> {
  const result = await db.query<Row>(
    `select title_candidates, hooks, thumbnail_concept, shipped_role, brainstorm_last
       from public.videos where id = $1`,
    [videoId],
  );
  return result.rows[0];
}

/* -------------------------------------------------------------------------- */
/* claude.ai, stubbed in the page                                              */
/* -------------------------------------------------------------------------- */

interface ClaudeCalls {
  opened: string[];
  copied: string[];
}

/**
 * Replace the two browser calls Open in Claude makes. Nothing leaves the
 * machine; the stubs record what the app handed them. `__refuseClipboard` and
 * `__blockTabs` are flipped per test to walk the fallbacks.
 */
async function stubClaude(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls = { opened: [] as string[], copied: [] as string[] };
    const w = window as unknown as {
      __claude: typeof calls;
      __refuseClipboard?: boolean;
      __blockTabs?: boolean;
    };
    w.__claude = calls;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (w.__refuseClipboard) throw new DOMException('Write permission denied.', 'NotAllowedError');
          calls.copied.push(text);
        },
      },
    });
    window.open = ((url?: string | URL) => {
      calls.opened.push(String(url));
      if (w.__blockTabs) return null;
      return { opener: window, closed: false } as unknown as Window;
    }) as typeof window.open;
  });
}

async function claudeCalls(page: Page): Promise<ClaudeCalls> {
  return page.evaluate(() => (window as unknown as { __claude: ClaudeCalls }).__claude);
}

async function manualMode(page: Page): Promise<void> {
  await page.context().addCookies([
    { name: MODE_COOKIE, value: 'manual', domain: 'localhost', path: '/' },
  ]);
}

/* -------------------------------------------------------------------------- */
/* Driving the page                                                            */
/* -------------------------------------------------------------------------- */

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}

const pill = (page: Page, verb: string): Locator =>
  page.locator(`[data-testid="assist-pill"][data-assist="${verb}"]`);

async function openVideo(page: Page, videoId: string): Promise<void> {
  await page.goto(`/videos/${videoId}`);
  await expect(page.getByTestId('packaging-block')).toBeVisible();
}

/** Press a pill through the hydration window; see `e2e/hydration.ts`. */
async function openAssist(page: Page, verb: string, panelId: string): Promise<void> {
  const panel = page.getByTestId(panelId);
  await untilTaken(
    async () => {
      if ((await panel.count()) === 0) await pill(page, verb).click();
    },
    () => expect(panel).toBeVisible({ timeout: 2_000 }),
  );
}

async function upload(
  page: Page,
  role: Role,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  const slot = page.locator(`[data-testid="variant-slot"][data-role="${role}"]`);
  await slot.getByTestId('variant-file').setInputFiles(file);
  await expect(slot.getByTestId('variant-status')).toHaveText(/saved$/);
}

async function savedCleanly(page: Page): Promise<void> {
  await expect(page.getByTestId('packaging-save-status')).toHaveText(/^Saved$/);
}

/** What a person pastes back: chatter around the shape the prompt asks for. */
const TITLES_REPLY = `Sure — here are five, in your voice.

1. The laptop is not the bottleneck || Names the myth the video breaks.
2. **Ten years, one MacBook, no regrets** || A number and a verdict, under 55 characters.
3. Already on the list || Repeats a candidate the video already has.
4. Proxy files, and other things I should have done || Curiosity about the "other things".
5. What a slow machine taught me about editing || Sells the lesson rather than the gear.
PICK: 2 || It is the only one that makes a claim a viewer can argue with.

Want a version that leans harder on the number?`;

/* -------------------------------------------------------------------------- */
/* 1. Titles — open, paste, read, accept, reopen                               */
/* -------------------------------------------------------------------------- */

test('titles: Open in Claude copies the prompt, and a pasted reply becomes the same proposals', async ({
  page,
}) => {
  await manualMode(page);
  const videoId = await capture('Editing on a ten year old laptop');
  // A candidate the reply will repeat, so de-duplication has something to do.
  await db.query(
    `update public.videos set title_candidates = $2::jsonb where id = $1`,
    [videoId, JSON.stringify([{ id: 'c-1', text: 'Already on the list', source: 'manual' }])],
  );
  await openVideo(page, videoId);

  await openAssist(page, 'Generate 20', 'brainstorm-panel');
  const panel = page.getByTestId('brainstorm-panel');

  // No key: Open in Claude is the panel's action, and nothing was asked of an
  // API — no waiting row, no "Ask", nothing in the column.
  const manual = panel.getByTestId('brainstorm-manual');
  await expect(manual).toHaveAttribute('data-mode', 'primary');
  await expect(panel.getByTestId('brainstorm-ask-again')).toHaveCount(0);
  await expect(panel.getByTestId('brainstorm-pending')).toHaveCount(0);
  expect((await rowOf(videoId)).brainstorm_last).toBeNull();

  await panel.getByTestId('brainstorm-open-in-claude').click();
  await expect(panel.getByTestId('brainstorm-manual-next')).toContainText(
    'The prompt is copied and claude.ai is open in a new tab',
  );

  // What the app handed the browser: a new conversation, and a prompt built
  // on the server from the channel's voice guide, its published titles and
  // what this video already has.
  const calls = await claudeCalls(page);
  expect(calls.opened).toEqual(['https://claude.ai/new']);
  expect(calls.copied).toHaveLength(1);
  const prompt = calls.copied[0];
  expect(prompt).toContain(VOICE_GUIDE);
  expect(prompt).toContain(PAST_TITLE);
  expect(prompt).toContain('Editing on a ten year old laptop');
  expect(prompt).toContain('Already on the list');
  expect(prompt).toContain('I will copy your answer into an app that reads it line by line');

  // Paste, read.
  await panel.getByTestId('brainstorm-paste').fill(TITLES_REPLY);
  await panel.getByTestId('brainstorm-read').click();

  const proposals = panel.getByTestId('brainstorm-suggestion');
  await expect(proposals).toHaveCount(4);
  await expect(proposals.nth(1).getByTestId('suggestion-text')).toHaveText(
    'Ten years, one MacBook, no regrets',
  );
  await expect(proposals.nth(1)).toHaveAttribute('data-recommended', 'true');
  await expect(panel.getByTestId('brainstorm-pick-reason')).toContainText('argue with');
  await expect(panel.getByTestId('brainstorm-provenance')).toContainText(
    'Read from your claude.ai reply just now',
  );
  // The duplicate was dropped by the same clamp an API answer goes through,
  // and the panel says so. No fixtures notice: nobody pretended.
  await expect(panel.getByTestId('brainstorm-meta')).toContainText(
    'repeated something already on this video',
  );
  await expect(panel.getByTestId('brainstorm-fixtures')).toHaveCount(0);
  // Read, the steps fold to one row so the proposals lead; the box comes back
  // empty when asked for.
  await expect(panel.getByTestId('brainstorm-manual')).toHaveAttribute('data-step', 'read');
  await expect(panel.getByTestId('brainstorm-paste')).toHaveCount(0);
  await panel.getByTestId('brainstorm-paste-another').click();
  await expect(panel.getByTestId('brainstorm-paste')).toHaveValue('');

  // Accept, through the packaging block's one save queue.
  await proposals.nth(0).getByTestId('suggestion-add').click();
  await savedCleanly(page);
  const row = await rowOf(videoId);
  expect(row.title_candidates?.map((c) => c.text)).toEqual([
    'Already on the list',
    'The laptop is not the bottleneck',
  ]);
  expect(row.title_candidates?.[1]).toMatchObject({
    source: 'ai',
    note: 'Names the myth the video breaks.',
  });

  // Stored the way an API answer is, and saying where it came from.
  expect(row.brainstorm_last?.titles).toMatchObject({ provider: 'manual', model: 'claude.ai' });
  expect(row.brainstorm_last?.titles.suggestions).toHaveLength(4);

  // Reopen: free, and "from earlier".
  await panel.getByTestId('brainstorm-close').click();
  await expect(pill(page, 'Generate 20')).toContainText('saved');
  await openAssist(page, 'Generate 20', 'brainstorm-panel');
  await expect(page.getByTestId('brainstorm-provenance')).toContainText(
    'pasted from claude.ai',
  );

  // And after a reload, out of `brainstorm_last`.
  await openVideo(page, videoId);
  await openAssist(page, 'Generate 20', 'brainstorm-panel');
  await expect(page.getByTestId('brainstorm-suggestion')).toHaveCount(4);
  await expect(page.getByTestId('brainstorm-provenance')).toContainText(
    'From earlier — pasted from claude.ai',
  );
  expect((await claudeCalls(page)).copied).toHaveLength(0);
});

/* -------------------------------------------------------------------------- */
/* 2. Hooks                                                                    */
/* -------------------------------------------------------------------------- */

test('hooks: the prompt asks for the ones missing, and a pasted hook lands in the hooks', async ({
  page,
}) => {
  await manualMode(page);
  const videoId = await capture('I read 52 books in a year');
  await openVideo(page, videoId);

  await untilTaken(
    async () => {
      if ((await page.getByTestId('brainstorm-panel').count()) === 0) {
        await pill(page, 'Draft a third').click();
      }
    },
    () => expect(page.getByTestId('brainstorm-panel')).toBeVisible({ timeout: 2_000 }),
  );
  const panel = page.getByTestId('brainstorm-panel');
  await expect(panel).toHaveAttribute('data-kind', 'hooks');

  await panel.getByTestId('brainstorm-open-in-claude').click();
  await expect(panel.getByTestId('brainstorm-manual-next')).toBeVisible();
  const prompt = (await claudeCalls(page)).copied[0];
  expect(prompt).toContain('Write 3 hooks');
  expect(prompt).toContain('welcome back');

  await panel
    .getByTestId('brainstorm-paste')
    .fill(
      '```\n1. Fifty-two books. I finished eleven of them properly. || Admits the catch in the first line.\n2. Here is what a book a week actually cost me. || A cost, not a boast.\nPICK: 1 || The confession earns the rest of the video.\n```',
    );
  await panel.getByTestId('brainstorm-read').click();

  const proposals = panel.getByTestId('brainstorm-suggestion');
  await expect(proposals).toHaveCount(2);
  await proposals.nth(0).getByTestId('suggestion-hook').click();
  await savedCleanly(page);
  expect((await rowOf(videoId)).hooks?.map((h) => h.text)).toEqual([
    'Fifty-two books. I finished eleven of them properly.',
  ]);
  expect((await rowOf(videoId)).brainstorm_last?.hooks.provider).toBe('manual');

  // Reopen after a reload: the hooks answer is kept under its own key.
  await openVideo(page, videoId);
  await untilTaken(
    async () => {
      if ((await page.getByTestId('brainstorm-panel').count()) === 0) {
        await pill(page, 'Draft a third').click();
      }
    },
    () => expect(page.getByTestId('brainstorm-panel')).toBeVisible({ timeout: 2_000 }),
  );
  await expect(page.getByTestId('brainstorm-suggestion')).toHaveCount(2);
  await expect(page.getByTestId('brainstorm-provenance')).toContainText('pasted from claude.ai');
});

/* -------------------------------------------------------------------------- */
/* 3. Concepts                                                                 */
/* -------------------------------------------------------------------------- */

test('concepts: a pasted concept replaces the concept box, and the answer is kept', async ({
  page,
}) => {
  await manualMode(page);
  const videoId = await capture('Filming in a tiny room');
  await openVideo(page, videoId);

  await openAssist(page, 'Suggest concepts', 'concept-assist-panel');
  const panel = page.getByTestId('concept-assist-panel');
  await expect(panel.getByTestId('concept-assist-manual')).toHaveAttribute('data-mode', 'primary');
  await expect(panel.getByTestId('concept-assist-ask-again')).toHaveCount(0);

  await panel.getByTestId('concept-assist-open-in-claude').click();
  await expect(panel.getByTestId('concept-assist-manual-next')).toBeVisible();
  expect((await claudeCalls(page)).copied[0]).toContain('thumbnail *concepts*');

  // A numbered list that ignored the separator: dashes, reasons underneath.
  await panel.getByTestId('concept-assist-paste').fill(`1. Me wedged between a wardrobe and a tripod — shows the room's size in one look.
2. **Overhead shot of the whole room, tape marks on the floor**
   Why: the tape reads as a plan at tile size.
Recommended: 2 — it is the only one that explains itself.`);
  await panel.getByTestId('concept-assist-read').click();

  const proposals = panel.getByTestId('concept-assist-suggestion');
  await expect(proposals).toHaveCount(2);
  await expect(proposals.nth(1)).toHaveAttribute('data-recommended', 'true');
  await expect(proposals.nth(1).getByTestId('suggestion-rationale')).toHaveText(
    'the tape reads as a plan at tile size.',
  );

  await proposals.nth(1).getByTestId('suggestion-use').click();
  await savedCleanly(page);
  expect((await rowOf(videoId)).thumbnail_concept).toBe(
    'Overhead shot of the whole room, tape marks on the floor',
  );

  await page.getByTestId('concept-assist-close').click();
  await openAssist(page, 'Suggest concepts', 'concept-assist-panel');
  await expect(page.getByTestId('concept-assist-provenance')).toContainText('pasted from claude.ai');
  await expect(page.getByTestId('concept-assist-suggestion')).toHaveCount(2);
  expect((await rowOf(videoId)).brainstorm_last?.concepts.provider).toBe('manual');
});

/* -------------------------------------------------------------------------- */
/* 4. The critique — images attached by hand, verdicts read back               */
/* -------------------------------------------------------------------------- */

test('critique: links the images to attach, reads the verdicts, ships one, keeps nothing', async ({
  page,
}) => {
  await manualMode(page);
  const videoId = await capture('Six months of cold showers');
  await openVideo(page, videoId);
  await page.goto(`/videos/${videoId}?section=thumbnails`);
  await upload(page, 'wild_card', WILD);
  await upload(page, 'moderate', MODERATE);

  await openAssist(page, 'Critique at tile size', 'critique-panel');
  const panel = page.getByTestId('critique-panel');
  await expect(panel.getByTestId('critique-manual')).toHaveAttribute('data-mode', 'primary');

  await panel.getByTestId('critique-open-in-claude').click();
  await expect(panel.getByTestId('critique-manual-next')).toContainText('attach the images below');

  // The two uploaded files, linked in order, to attach by hand.
  const images = panel.getByTestId('critique-manual-image');
  await expect(images).toHaveCount(2);
  await expect(images.nth(0)).toHaveAttribute('data-role', 'wild_card');
  await expect(images.nth(1)).toHaveAttribute('data-role', 'moderate');
  expect(await images.nth(0).getAttribute('href')).toMatch(/^https?:\/\//);

  const prompt = (await claudeCalls(page)).copied[0];
  expect(prompt).toContain('I have attached 2 thumbnail images');
  expect(prompt).toContain('1. WILD CARD\n2. MODERATE');
  expect(prompt).not.toContain('SAFE ||');

  await panel.getByTestId('critique-paste').fill(`Here is my read.

| Image | Reads | Adds | Note |
|---|---|---|---|
| Wild card | no | yes | The face disappears at this size. |
| Moderate | yes | yes | Reads first time; ship this. |
| Safe | yes | no | (there was no third image) |

SHIP: moderate`);
  await panel.getByTestId('critique-read').click();

  const verdicts = panel.getByTestId('critique-verdict');
  await expect(verdicts).toHaveCount(2);
  const moderate = panel.locator('[data-testid="critique-verdict"][data-role="moderate"]');
  await expect(moderate).toHaveAttribute('data-recommended', 'true');
  await expect(panel.getByTestId('critique-provenance')).toContainText(
    'Read from your claude.ai reply just now',
  );

  // Accepting is shipping, through `swap_thumbnail` — nothing is live yet.
  await moderate.getByTestId('critique-ship').click();
  await expect(moderate.getByTestId('critique-ship')).toHaveText('Already live');
  expect((await rowOf(videoId)).shipped_role).toBe('moderate');

  // Reopen: a verdict is about the images as they were, so — exactly as for
  // an API answer — it is not kept, and the panel starts again.
  await panel.getByTestId('critique-close').click();
  await openAssist(page, 'Critique at tile size', 'critique-panel');
  await expect(page.getByTestId('critique-verdict')).toHaveCount(0);
  await expect(page.getByTestId('critique-provenance')).toHaveText('Nothing asked for yet.');
  expect((await rowOf(videoId)).brainstorm_last).toBeNull();
});

/* -------------------------------------------------------------------------- */
/* 5. The fallbacks                                                            */
/* -------------------------------------------------------------------------- */

test('a refused clipboard shows the prompt selected, and a blocked tab gets a link', async ({
  page,
}) => {
  await manualMode(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __refuseClipboard: boolean; __blockTabs: boolean };
    w.__refuseClipboard = true;
    w.__blockTabs = true;
  });
  const videoId = await capture('The desk tour nobody asked for');
  await openVideo(page, videoId);

  await openAssist(page, 'Generate 20', 'brainstorm-panel');
  const panel = page.getByTestId('brainstorm-panel');
  await panel.getByTestId('brainstorm-open-in-claude').click();

  await expect(panel.getByTestId('brainstorm-manual-next')).toContainText(
    'would not let the page copy',
  );
  const box = panel.getByTestId('brainstorm-manual-fallback');
  await expect(box).toBeVisible();
  const value = await box.inputValue();
  expect(value).toContain(VOICE_GUIDE);
  expect(value).toContain('The desk tour nobody asked for');
  // Selected and focused, so the next gesture is the copy.
  expect(
    await box.evaluate((element: HTMLTextAreaElement) => ({
      focused: document.activeElement === element,
      all: element.selectionStart === 0 && element.selectionEnd === element.value.length,
    })),
  ).toEqual({ focused: true, all: true });

  // The tab was blocked: a plain link says so and goes there.
  const link = panel.getByTestId('brainstorm-manual-link');
  await expect(link).toHaveAttribute('href', 'https://claude.ai/new');
  await expect(link).toHaveAttribute('target', '_blank');
  expect((await claudeCalls(page)).copied).toHaveLength(0);
});

test('a reply that cannot be read says what it expected, keeps the text, and writes nothing', async ({
  page,
}) => {
  await manualMode(page);
  const videoId = await capture('Six months without a phone');
  await openVideo(page, videoId);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await openAssist(page, 'Generate 20', 'brainstorm-panel');
  const panel = page.getByTestId('brainstorm-panel');

  const garbage = "I'm not able to see the video you're describing.\nCould you share more details?";
  await panel.getByTestId('brainstorm-paste').fill(garbage);
  await panel.getByTestId('brainstorm-read').click();

  const failure = panel.getByTestId('brainstorm-paste-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('1. The title || why it works');
  await expect(failure).toContainText('still in the box');
  await expect(panel.getByTestId('brainstorm-paste')).toHaveValue(garbage);
  await expect(panel.getByTestId('brainstorm-count')).toHaveCount(0);
  // No API retry is offered for a paste: reading the same text again is the
  // same answer.
  await expect(panel.getByTestId('brainstorm-retry')).toHaveCount(0);
  expect((await rowOf(videoId)).brainstorm_last).toBeNull();

  // Fixed, it reads.
  await panel.getByTestId('brainstorm-paste').fill('1. Six months, no phone || The number is the hook.');
  await panel.getByTestId('brainstorm-read').click();
  await expect(panel.getByTestId('brainstorm-suggestion')).toHaveCount(1);
  await expect(failure).toHaveCount(0);
  expect(errors).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* 6. With a key: the API stays primary, Open in Claude is always there        */
/* -------------------------------------------------------------------------- */

test('with the API primary, Open in Claude is a quiet disclosure and still works', async ({
  page,
}) => {
  // No cookie: the server's own mode, which with `ASSIST_PROVIDER=fake` is
  // the API path — the fixtures answer the pill exactly as before M11.
  const videoId = await capture('Filming in the rain');
  await openVideo(page, videoId);

  await openAssist(page, 'Generate 20', 'brainstorm-panel');
  const panel = page.getByTestId('brainstorm-panel');
  await expect(panel.getByTestId('brainstorm-suggestion').first()).toBeVisible();
  await expect(panel.getByTestId('brainstorm-fixtures')).toBeVisible();

  const manual = panel.getByTestId('brainstorm-manual');
  await expect(manual).toHaveAttribute('data-mode', 'secondary');
  await expect(panel.getByTestId('brainstorm-open-in-claude')).toHaveCount(0);

  // Opening the steps copies nothing — a reply may already be on the clipboard.
  await panel.getByTestId('brainstorm-manual-toggle').click();
  expect((await claudeCalls(page)).copied).toHaveLength(0);
  await panel.getByTestId('brainstorm-open-in-claude').click();
  await expect(panel.getByTestId('brainstorm-manual-next')).toBeVisible();

  await panel.getByTestId('brainstorm-paste').fill('1. Rain on the lens || Sells the problem.\nPICK: 1');
  await panel.getByTestId('brainstorm-read').click();
  await expect(panel.getByTestId('brainstorm-suggestion')).toHaveCount(1);
  await expect(panel.getByTestId('brainstorm-fixtures')).toHaveCount(0);
  expect((await rowOf(videoId)).brainstorm_last?.titles.provider).toBe('manual');
});

/* -------------------------------------------------------------------------- */
/* 7. The phone                                                                */
/* -------------------------------------------------------------------------- */

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('copy, open, come back, paste, read, accept — under a thumb', async ({ page }) => {
    await manualMode(page);
    const videoId = await capture('Editing on the train');
    await openVideo(page, videoId);

    await untilTaken(
      async () => {
        if ((await page.getByTestId('brainstorm-panel').count()) === 0) {
          await pill(page, 'Generate 20').tap();
        }
      },
      () => expect(page.getByTestId('brainstorm-panel')).toBeVisible({ timeout: 2_000 }),
    );
    const panel = page.getByTestId('brainstorm-panel');

    // 44px targets and a 16px paste box, measured.
    const open = panel.getByTestId('brainstorm-open-in-claude');
    const read = panel.getByTestId('brainstorm-read');
    const paste = panel.getByTestId('brainstorm-paste');
    for (const control of [open, read, paste]) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 390).toBe(true);
    }
    expect(await paste.evaluate((element) => getComputedStyle(element).fontSize)).toBe('16px');

    await open.tap();
    await expect(panel.getByTestId('brainstorm-manual-next')).toBeVisible();
    expect((await claudeCalls(page)).opened).toEqual(['https://claude.ai/new']);

    // Away in claude.ai, and back: the page is hidden and shown again.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await paste.tap();
    await paste.fill('1. Editing on the 7:42 || A time makes it real.\n2. My desk is a train seat || Reframes the setup.\nPICK: 1 || Specific beats clever.');
    await read.tap();

    const proposals = panel.getByTestId('brainstorm-suggestion');
    await expect(proposals).toHaveCount(2);
    const add = proposals.nth(0).getByTestId('suggestion-add');
    expect((await add.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await add.tap();
    await savedCleanly(page);
    expect((await rowOf(videoId)).title_candidates?.map((c) => c.text)).toEqual([
      'Editing on the 7:42',
    ]);

    // Nothing on the page scrolls sideways with the panel open.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});
