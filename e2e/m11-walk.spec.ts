import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import {
  CHANNEL_DEFAULTS,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
} from '../lib/defaults';
import { PG } from '../scripts/dev-stack/shared';
import { startAssistStub, type AssistStub } from './assist-stub';
import { untilTaken } from './hydration';
import { makePng } from './png';

/**
 * M11 integration: the brainstorm walked in the three configurations the
 * milestone has, on a laptop and on a phone (390×844, touch).
 *
 * 1. **No key** — Open in Claude is every panel's action. Every assist is
 *    done once by hand: copy the prompt, paste a reply shaped the way a
 *    claude.ai answer tends to come back (chatter, bold, a stray heading),
 *    read it, accept one.
 * 2. **A key, under the cap** — the real provider against the local stub
 *    (`e2e/assist-stub.ts`): the pill asks the API, and Open in Claude is a
 *    quiet disclosure on the same panel that still works.
 * 3. **A key, at the cap** — the page leads with Open in Claude on all four
 *    assists, says why above it, asks the stub nothing, and the manual path
 *    still accepts.
 *
 * `window.open` and the clipboard are stubbed in the page: nothing here
 * reaches claude.ai. Screenshots go to the gitignored `e2e/screenshots/`,
 * where the integration pass looked at them.
 *
 * Its own account, created and removed here, so the usage rows it writes and
 * the cap it reaches touch nobody else's month.
 */

const EMAIL = 'm11-walk-spec@nertube.test';
const PASSWORD = 'm11-walk-spec-password';
const CHANNEL = { name: 'M11 Walk', slug: 'm11-walk' };
const VOICE_GUIDE = 'Plain, a bit wry, never breathless. Short sentences.';

let db: pg.Client;
let stub: AssistStub;
let userId: string;
let channelId: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  stub = await startAssistStub();
  db = new pg.Client({
    host: PG.host,
    port: PG.port,
    user: PG.user,
    password: PG.password === '' ? undefined : PG.password,
    database: PG.database,
  });
  await db.connect();
  await removeUser();
  const created = await db.query<{ id: string }>(
    `insert into auth.users (email, encrypted_password, email_confirmed_at, aud, role)
     values (lower($1), crypt($2, gen_salt('bf')), now(), 'authenticated', 'authenticated')
     returning id`,
    [EMAIL, PASSWORD],
  );
  userId = created.rows[0].id;
  channelId = await createChannel();
});

test.afterAll(async () => {
  await removeUser().catch(() => {});
  await db?.end();
  await stub?.close();
});

async function removeUser(): Promise<void> {
  // The uploaded variants first: their paths start with the owner's id.
  await db.query(
    `delete from storage.objects
      where bucket_id = 'thumbnails'
        and split_part(name, '/', 1) in (select id::text from auth.users where lower(email) = lower($1))`,
    [EMAIL],
  );
  await db.query('delete from auth.users where lower(email) = lower($1)', [EMAIL]);
}

async function asUser<T>(fn: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated', email: EMAIL }),
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
        VOICE_GUIDE,
        JSON.stringify(stages),
        JSON.stringify(SEED_BUCKETS.map((bucket) => ({ ...bucket, monthly_quota: null }))),
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
  title_candidates: { text: string }[] | null;
  hooks: { text: string }[] | null;
  thumbnail_concept: string | null;
  shipped_role: string | null;
}

async function rowOf(videoId: string): Promise<Row> {
  const result = await db.query<Row>(
    'select title_candidates, hooks, thumbnail_concept, shipped_role from public.videos where id = $1',
    [videoId],
  );
  return result.rows[0];
}

/** The month at exactly the $10 default cap, or empty. */
async function setMonth(micros: number): Promise<void> {
  await db.query('delete from public.assist_usage where user_id = $1', [userId]);
  if (micros > 0) {
    await db.query(
      `insert into public.assist_usage (user_id, kind, outcome, requested_model, model, cost_micros)
       values ($1, 'titles', 'answered', 'claude-opus-5', 'claude-opus-5', $2)`,
      [userId, micros],
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The browser                                                                 */
/* -------------------------------------------------------------------------- */

type Config = 'manual' | 'stub';

async function prepare(page: Page, config: Config): Promise<void> {
  const url = test.info().project.use.baseURL!;
  await page
    .context()
    .addCookies([
      config === 'manual'
        ? { name: 'nertube-test-assist-mode', value: 'manual', url }
        : { name: 'nertube-test-assist', value: 'stub', url },
    ]);
  await page.addInitScript(() => {
    const calls = { opened: [] as string[], copied: [] as string[] };
    (window as unknown as { __claude: typeof calls }).__claude = calls;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void calls.copied.push(text) },
    });
    window.open = ((target?: string | URL) => {
      calls.opened.push(String(target));
      return { opener: window, closed: false } as unknown as Window;
    }) as typeof window.open;
  });
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}

async function copied(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __claude: { copied: string[] } }).__claude.copied);
}

const pill = (page: Page, verb: string): Locator =>
  page.locator(`[data-testid="assist-pill"][data-assist="${verb}"]`);

async function press(page: Page, target: Locator, touch: boolean): Promise<void> {
  if (touch) await target.tap();
  else await target.click();
}

async function openAssist(page: Page, verb: string, panelId: string, touch: boolean): Promise<Locator> {
  const panel = page.getByTestId(panelId);
  await untilTaken(
    async () => {
      if ((await panel.count()) === 0) await press(page, pill(page, verb), touch);
    },
    () => expect(panel).toBeVisible({ timeout: 2_000 }),
  );
  return panel;
}

async function saved(page: Page): Promise<void> {
  await expect(page.getByTestId('packaging-save-status')).toHaveText(/^Saved$/);
}

/** 44px under a thumb, inside the screen. */
async function thumbSized(control: Locator): Promise<void> {
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
}

async function noSidewaysScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
}

/**
 * Copy, paste, read — the manual path on one panel. Returns the prompt that
 * was copied so the caller can check what it was built from.
 */
async function byHand(
  page: Page,
  panel: Locator,
  prefix: string,
  reply: string,
  touch: boolean,
  beforeRead?: () => Promise<void>,
): Promise<string> {
  const before = (await copied(page)).length;
  const open = panel.getByTestId(`${prefix}-open-in-claude`);
  const paste = panel.getByTestId(`${prefix}-paste`);
  const read = panel.getByTestId(`${prefix}-read`);
  if (touch) {
    await thumbSized(open);
    await thumbSized(paste);
    expect(await paste.evaluate((element) => getComputedStyle(element).fontSize)).toBe('16px');
  }
  await press(page, open, touch);
  await expect(panel.getByTestId(`${prefix}-manual-next`)).toContainText('The prompt is copied');
  const prompts = await copied(page);
  expect(prompts).toHaveLength(before + 1);
  if (beforeRead) await beforeRead();
  await paste.fill(reply);
  if (touch) await thumbSized(read);
  await press(page, read, touch);
  await expect(panel.getByTestId(`${prefix}-paste-failure`)).toHaveCount(0);
  return prompts[prompts.length - 1];
}

/* -------------------------------------------------------------------------- */
/* Replies, as claude.ai tends to write them                                   */
/* -------------------------------------------------------------------------- */

const TITLES_REPLY = `Here are twelve, written to the voice guide:

1. **I filmed a whole video on a £90 phone** || A price and a claim — the viewer wants to know if it held up.
2. The £90 phone test || Short and searchable; the premise is the whole title.
3. What a cheap phone can't do (and what it can) || Promises a verdict both ways, which reads as honest.
4. My camera is in a drawer now || A small confession that makes people click to find out why.
5. Budget filmmaking, one month in || Frames it as a diary, which suits the channel.
6. Nobody noticed it was a phone || Social proof as the hook.
PICK: 1 || It is the only one that makes a claim the viewer can check, where the others describe.

Want me to lean harder on the price, or try some without it?`;

const HOOKS_REPLY = `### Hooks

1. This whole video was shot on a phone that cost less than the tripod. || Opens on the contrast, so the premise lands in one line.
2. I put my camera in a drawer for a month. Here's what I missed. || A dare, then a question — the viewer stays for the answer.
3. Ninety pounds. That's the entire camera budget for this video. || The number first, before anyone can scroll.
PICK: 3 || It gets the price in before the first cut, and the others take a sentence to arrive.`;

const CONCEPTS_REPLY = `Sure — four shots, each filmable at home:

1. The phone taped to a broom handle, me holding it up like a boom mic || Absurd enough to stop a thumb, and it shows the budget.
2. Split frame: my big camera on the left, the £90 phone on the right, same shot || The comparison reads at tile size without a word.
3. Close-up of a price sticker on the phone's screen || The number is the whole joke.
4. Me behind a pile of camera gear, holding up just the phone || Scale does the talking.
PICK: 2 || It is the only one where the tile alone tells the story.`;

const CRITIQUE_REPLY = `Looking at both at 360 pixels:

WILD CARD || reads: no || adds: yes || The phone vanishes at this size — crop tighter or make it bigger in frame.
MODERATE || reads: yes || adds: yes || Clear at a glance, and the split says something the title does not.
SHIP: moderate

Happy to look again after a recrop.`;

const RED = { name: 'wild.png', mimeType: 'image/png', buffer: makePng(8, 4, [200, 50, 50]) };
const GREEN = { name: 'moderate.png', mimeType: 'image/png', buffer: makePng(8, 4, [40, 150, 90]) };

async function upload(
  page: Page,
  role: 'wild_card' | 'moderate',
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  const slot = page.locator(`[data-testid="variant-slot"][data-role="${role}"]`);
  await slot.getByTestId('variant-file').setInputFiles(file);
  await expect(slot.getByTestId('variant-status')).toHaveText(/saved$/);
}

/* -------------------------------------------------------------------------- */
/* The walks                                                                   */
/* -------------------------------------------------------------------------- */

for (const device of ['laptop', 'phone'] as const) {
  test.describe(`on a ${device}`, () => {
    const touch = device === 'phone';
    if (touch) test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    else test.use({ viewport: { width: 1280, height: 900 } });
    const shot = (name: string) => `e2e/screenshots/m11-walk-${device}-${name}.png`;

    test('no key: every assist done by hand — copy, paste, read, accept', async ({ page }) => {
      await setMonth(0);
      // Every response carrying the manual prompt's own words, and what asked
      // for it: the prompt must reach the browser only as the answer to a
      // press of Open in Claude, never with the page.
      const carried: { method: string; url: string }[] = [];
      page.on('response', async (response) => {
        const body = await response.text().catch(() => '');
        if (body.includes('I will copy your answer into an app')) {
          carried.push({ method: response.request().method(), url: response.url() });
        }
      });
      await prepare(page, 'manual');
      const videoId = await capture(`Filming on a cheap phone (${device})`);
      await page.goto(`/videos/${videoId}`);
      await expect(page.getByTestId('packaging-block')).toBeVisible();

      // Titles.
      let panel = await openAssist(page, 'Generate 20', 'brainstorm-panel', touch);
      await expect(panel.getByTestId('brainstorm-manual')).toHaveAttribute('data-mode', 'primary');
      await expect(panel.getByTestId('brainstorm-ask-again')).toHaveCount(0);
      await panel.screenshot({ path: shot('manual-titles-open') });
      // The page and the open panel hold no prompt: nothing has been pressed.
      expect(await page.content()).not.toContain('I will copy your answer into an app');
      expect(carried).toEqual([]);
      const prompt = await byHand(page, panel, 'brainstorm', TITLES_REPLY, touch);
      // One press, one response, and it is the server action's (a POST).
      await expect.poll(() => carried.length).toBe(1);
      expect(carried[0].method).toBe('POST');
      expect(prompt).toContain(VOICE_GUIDE);
      await expect(panel.getByTestId('brainstorm-suggestion')).toHaveCount(6);
      await expect(
        panel.locator('[data-testid="brainstorm-suggestion"][data-recommended="true"]'),
      ).toContainText('£90 phone');
      // Read, the steps fold to one row so the proposals lead.
      await expect(panel.getByTestId('brainstorm-manual')).toHaveAttribute('data-step', 'read');
      if (touch) await thumbSized(panel.getByTestId('brainstorm-paste-another'));
      await panel.screenshot({ path: shot('manual-titles-read') });
      await press(page, panel.getByTestId('brainstorm-suggestion').nth(1).getByTestId('suggestion-add'), touch);
      await saved(page);
      expect((await rowOf(videoId)).title_candidates?.map((c) => c.text)).toEqual(['The £90 phone test']);
      await press(page, panel.getByTestId('brainstorm-close'), touch);

      // Hooks.
      panel = await openAssist(page, 'Draft a third', 'brainstorm-panel', touch);
      await expect(panel).toHaveAttribute('data-kind', 'hooks');
      await byHand(page, panel, 'brainstorm', HOOKS_REPLY, touch);
      await expect(panel.getByTestId('brainstorm-suggestion')).toHaveCount(3);
      await press(page, panel.getByTestId('brainstorm-suggestion').nth(2).getByTestId('suggestion-hook'), touch);
      await saved(page);
      expect((await rowOf(videoId)).hooks?.map((h) => h.text)).toEqual([
        "Ninety pounds. That's the entire camera budget for this video.",
      ]);
      await press(page, panel.getByTestId('brainstorm-close'), touch);

      // Concepts.
      panel = await openAssist(page, 'Suggest concepts', 'concept-assist-panel', touch);
      await expect(panel.getByTestId('concept-assist-manual')).toHaveAttribute('data-mode', 'primary');
      await byHand(page, panel, 'concept-assist', CONCEPTS_REPLY, touch);
      await expect(panel.getByTestId('concept-assist-suggestion')).toHaveCount(4);
      await panel.screenshot({ path: shot('manual-concepts-read') });
      await press(page, panel.getByTestId('concept-assist-suggestion').nth(1).getByTestId('suggestion-use'), touch);
      await saved(page);
      expect((await rowOf(videoId)).thumbnail_concept).toContain('Split frame');
      await press(page, page.getByTestId('concept-assist-close'), touch);
      await noSidewaysScroll(page);

      // The critique: two variants, attached by hand.
      await page.goto(`/videos/${videoId}?section=thumbnails`);
      await upload(page, 'wild_card', RED);
      await upload(page, 'moderate', GREEN);
      panel = await openAssist(page, 'Critique at tile size', 'critique-panel', touch);
      await expect(panel.getByTestId('critique-manual')).toHaveAttribute('data-mode', 'primary');
      // The two files to attach by hand are linked, in order, before the paste.
      await byHand(page, panel, 'critique', CRITIQUE_REPLY, touch, async () => {
        await expect(panel.getByTestId('critique-manual-image')).toHaveCount(2);
        if (touch) await thumbSized(panel.getByTestId('critique-manual-image').first());
      });
      await expect(panel.getByTestId('critique-verdict')).toHaveCount(2);
      await panel.screenshot({ path: shot('manual-critique-read') });
      const moderate = panel.locator('[data-testid="critique-verdict"][data-role="moderate"]');
      await expect(moderate).toHaveAttribute('data-recommended', 'true');
      if (touch) await thumbSized(moderate.getByTestId('critique-ship'));
      await press(page, moderate.getByTestId('critique-ship'), touch);
      await expect(moderate.getByTestId('critique-ship')).toHaveText('Already live');
      expect((await rowOf(videoId)).shipped_role).toBe('moderate');
      await noSidewaysScroll(page);

      // Nothing asked of any API: the stub saw nothing and no usage was written.
      const usage = await db.query('select 1 from public.assist_usage where user_id = $1', [userId]);
      expect(usage.rows).toHaveLength(0);
    });

    test('a key, under the cap: the API answers the pill, Open in Claude stays one tap away', async ({
      page,
    }) => {
      await setMonth(0);
      await prepare(page, 'stub');
      const before = stub.requests.length;
      const videoId = await capture(`Asked through the API (${device})`);
      await page.goto(`/videos/${videoId}`);
      await expect(page.getByTestId('packaging-block')).toBeVisible();

      const panel = await openAssist(page, 'Generate 20', 'brainstorm-panel', touch);
      await expect(panel.getByTestId('brainstorm-pending')).toHaveCount(0, { timeout: 30_000 });
      await expect(panel.getByTestId('brainstorm-suggestion')).toHaveCount(12);
      expect(stub.requests.length).toBe(before + 1);
      await expect(panel.getByTestId('brainstorm-ask-again')).toBeVisible();
      await expect(panel.getByTestId('brainstorm-manual')).toHaveAttribute('data-mode', 'secondary');
      await expect(panel.getByTestId('brainstorm-cap-note')).toHaveCount(0);
      await panel.screenshot({ path: shot('api-under-cap') });

      // The disclosure copies nothing; the steps then work as in the keyless mode.
      const toggle = panel.getByTestId('brainstorm-manual-toggle');
      if (touch) await thumbSized(toggle);
      await press(page, toggle, touch);
      expect(await copied(page)).toHaveLength(0);
      await byHand(page, panel, 'brainstorm', TITLES_REPLY, touch);
      await expect(panel.getByTestId('brainstorm-suggestion')).toHaveCount(6);
      await expect(panel.getByTestId('brainstorm-provenance')).toContainText('claude.ai');
      await press(page, panel.getByTestId('brainstorm-suggestion').nth(0).getByTestId('suggestion-add'), touch);
      await saved(page);
      expect((await rowOf(videoId)).title_candidates?.map((c) => c.text)).toEqual([
        'I filmed a whole video on a £90 phone',
      ]);
      // The paste was not an API call.
      expect(stub.requests.length).toBe(before + 1);
      await noSidewaysScroll(page);
    });

    test('a key, at the cap: every panel leads with Open in Claude and says why', async ({ page }) => {
      await setMonth(10_000_000);
      await prepare(page, 'stub');
      const before = stub.requests.length;
      const videoId = await capture(`Asked at the cap (${device})`);
      await page.goto(`/videos/${videoId}?section=thumbnails`);
      await upload(page, 'moderate', GREEN);
      await page.goto(`/videos/${videoId}`);
      await expect(page.getByTestId('packaging-block')).toBeVisible();

      // Titles, concepts: the note, then Open in Claude as the action.
      let panel = await openAssist(page, 'Generate 20', 'brainstorm-panel', touch);
      await expect(panel.getByTestId('brainstorm-cap-note')).toContainText('the default cap of $10');
      await expect(panel.getByTestId('brainstorm-cap-spent')).toHaveText('$10.00');
      await expect(panel.getByTestId('brainstorm-manual')).toHaveAttribute('data-mode', 'primary');
      await expect(panel.getByTestId('brainstorm-ask-again')).toHaveCount(0);
      if (touch) await thumbSized(panel.getByTestId('brainstorm-spend-cap-settings'));
      await panel.screenshot({ path: shot('at-cap-titles') });
      await press(page, panel.getByTestId('brainstorm-close'), touch);

      panel = await openAssist(page, 'Draft a third', 'brainstorm-panel', touch);
      await expect(panel.getByTestId('brainstorm-cap-note')).toBeVisible();
      await press(page, panel.getByTestId('brainstorm-close'), touch);

      panel = await openAssist(page, 'Suggest concepts', 'concept-assist-panel', touch);
      await expect(panel.getByTestId('concept-assist-cap-note')).toBeVisible();
      await expect(panel.getByTestId('concept-assist-manual')).toHaveAttribute('data-mode', 'primary');
      // …and the manual path works at the cap: copy, paste, read, accept.
      await byHand(page, panel, 'concept-assist', CONCEPTS_REPLY, touch);
      await press(page, panel.getByTestId('concept-assist-suggestion').nth(3).getByTestId('suggestion-use'), touch);
      await saved(page);
      expect((await rowOf(videoId)).thumbnail_concept).toContain('pile of camera gear');
      await press(page, page.getByTestId('concept-assist-close'), touch);

      await page.goto(`/videos/${videoId}?section=thumbnails`);
      panel = await openAssist(page, 'Critique at tile size', 'critique-panel', touch);
      await expect(panel.getByTestId('critique-cap-note')).toBeVisible();
      await expect(panel.getByTestId('critique-manual')).toHaveAttribute('data-mode', 'primary');
      await panel.screenshot({ path: shot('at-cap-critique') });

      // Four panels opened at the cap, and not one request left the server.
      expect(stub.requests.length).toBe(before);
      await noSidewaysScroll(page);
    });
  });
}
