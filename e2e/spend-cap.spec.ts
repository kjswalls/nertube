import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import {
  CHANNEL_DEFAULTS,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
} from '../lib/defaults';
import { PG } from '../scripts/dev-stack/shared';
import {
  startAssistStub,
  STUB_COST_MICROS,
  STUB_MODEL,
  STUB_USAGE,
  type AssistStub,
} from './assist-stub';
import { untilTaken } from './hydration';

/**
 * M11: a hard monthly cap on real API calls.
 *
 * The rest of the suite runs the brainstorm on the fixtures, which cost
 * nothing, record nothing and are never refused — so none of it can show the
 * cap working. This spec drives the **real** provider: its context carries the
 * `nertube-test-assist=stub` cookie, which (only because Playwright starts the
 * app with `NERTUBE_TEST_ANTHROPIC_STUB`) makes the server use
 * `lib/assist/anthropic.ts` — the installed SDK, its real request, its real
 * usage parsing, the real price table and the real `record_assist_usage` write
 * — pointed at `e2e/assist-stub.ts` instead of Anthropic. The stub counts what
 * reaches it, which is how "refused before any request leaves" is proved
 * rather than asserted.
 *
 * Its own account, created and removed here, so the spend and the cap it sets
 * touch nobody else's month.
 */

const EMAIL = 'spend-cap-spec@nertube.test';
const PASSWORD = 'spend-cap-spec-password';
const CHANNEL = { name: 'Spend cap spec', slug: 'spend-cap-spec' };
const STUB_KEY = 'nertube-e2e-stub-key';

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
        CHANNEL_DEFAULTS.voice_guide,
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

interface UsageRow {
  video_id: string | null;
  kind: string;
  outcome: string;
  requested_model: string;
  model: string;
  price_assumed: boolean;
  input_tokens: number;
  output_tokens: number;
  cost_micros: string;
}

async function usageRows(): Promise<UsageRow[]> {
  const result = await db.query<UsageRow>(
    `select video_id, kind, outcome, requested_model, model, price_assumed,
            input_tokens, output_tokens, cost_micros
       from public.assist_usage where user_id = $1 order by created_at`,
    [userId],
  );
  return result.rows;
}

/** Signed in, with this context's assists answered by the stub. */
async function signIn(page: Page): Promise<void> {
  await page.context().addCookies([
    { name: 'nertube-test-assist', value: 'stub', url: test.info().project.use.baseURL! },
  ]);
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}

const panel = (page: Page) => page.getByTestId('brainstorm-panel');
const pill = (page: Page) =>
  page.locator('[data-testid="assist-pill"][data-assist="Generate 20"]');

/** Open the titles panel, which asks on opening (the same helper as brainstorm.spec). */
async function openPanel(page: Page, videoId: string): Promise<void> {
  await page.goto(`/videos/${videoId}`);
  await pressPill(page);
}

/** Press the pill on the page as it is — no navigation, so no redraw. */
async function pressPill(page: Page): Promise<void> {
  await untilTaken(
    async () => {
      if ((await panel(page).count()) === 0) await pill(page).click();
    },
    () => expect(panel(page)).toBeVisible({ timeout: 2_000 }),
  );
  await expect(page.getByTestId('brainstorm-pending')).toHaveCount(0, { timeout: 30_000 });
}

/* -------------------------------------------------------------------------- */

test('a real call records what it cost, and Settings shows the month with the $10 default', async ({
  page,
}) => {
  const videoId = await capture('Sharpening a chisel on a budget');
  await signIn(page);
  await openPanel(page, videoId);

  // The stub's twelve titles, drawn as the model's — not as fixtures.
  await expect(page.getByTestId('brainstorm-suggestion')).toHaveCount(12);
  await expect(page.getByTestId('brainstorm-fixtures')).toHaveCount(0);

  // Exactly one request left the server, built by the real provider: the
  // pinned model, the stub's key and never a real one.
  expect(stub.requests).toHaveLength(1);
  expect(stub.requests[0].url).toContain('/v1/messages');
  expect(stub.requests[0].body.model).toBe(STUB_MODEL);
  expect(stub.requests[0].headers['x-api-key']).toBe(STUB_KEY);

  // …and it was recorded, as this user, against this video, at its price.
  const rows = await usageRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    video_id: videoId,
    kind: 'titles',
    outcome: 'answered',
    requested_model: STUB_MODEL,
    model: STUB_MODEL,
    price_assumed: false,
    input_tokens: STUB_USAGE.input_tokens,
    output_tokens: STUB_USAGE.output_tokens,
  });
  expect(Number(rows[0].cost_micros)).toBe(STUB_COST_MICROS);

  // Settings: month to date in dollars and cents, one call, the default cap
  // named as the default, and what a typical call has cost.
  await page.goto('/settings/account');
  const section = page.getByTestId('settings-spending');
  await expect(section).toBeVisible();
  await expect(page.getByTestId('spending-spent')).toHaveText('$0.09');
  await expect(page.getByTestId('spending-calls')).toHaveText('1');
  await expect(page.getByTestId('spending-cap')).toHaveText('$10');
  await expect(section).toContainText('Cap (default)');
  await expect(section).toContainText('With no setting the cap is $10');
  await expect(page.getByTestId('spending-mean')).toContainText('A typical call has cost $0.09');
  await expect(page.getByTestId('spending-meter')).toHaveAttribute('aria-valuenow', '1');
  // Money is a measured number: the mono face.
  const family = await page
    .getByTestId('spending-spent')
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(family).toMatch(/JetBrains Mono/i);
  await section.screenshot({ path: 'e2e/screenshots/m11-spending-desktop.png' });
});

test('at the $10 default a call is refused before any request leaves, with the cap, the spend and the way on', async ({
  page,
}) => {
  const before = stub.requests.length;
  const rowsBefore = (await usageRows()).length;

  // The page is drawn under the cap ($0.09 so far), so the API leads…
  const videoId = await capture('A second video, asked about at the cap');
  await signIn(page);
  await page.goto(`/videos/${videoId}`);
  await expect(page.getByTestId('packaging-block')).toBeVisible();

  // …and the month reaches exactly $10.00 while it is open — at the cap,
  // which is refused. The action's own check is what holds the line here.
  await db.query(
    `insert into public.assist_usage (user_id, kind, outcome, requested_model, model, cost_micros)
     values ($1, 'titles', 'answered', 'claude-opus-5', 'claude-opus-5', $2)`,
    [userId, 10_000_000 - STUB_COST_MICROS],
  );
  await pressPill(page);

  const failure = page.getByTestId('brainstorm-failure');
  await expect(failure).toBeVisible();
  await expect(failure).toHaveAttribute('data-code', 'spend_cap');
  const message = page.getByTestId('brainstorm-failure-message');
  await expect(message).toContainText('$10.00');
  await expect(message).toContainText('the default cap of $10');
  await expect(message).toContainText('Open in Claude');
  await expect(message).toContainText('nothing was spent');
  await expect(page.getByTestId('brainstorm-fixtures')).toHaveCount(0);
  // Not a dead end: the refusal opens Open in Claude as the panel's action,
  // drawn under the reason.
  await expect(page.getByTestId('brainstorm-manual')).toHaveAttribute('data-mode', 'primary');
  await expect(page.getByTestId('brainstorm-open-in-claude')).toBeVisible();
  const order = await page.evaluate(() => {
    const refusal = document.querySelector('[data-testid="brainstorm-failure"]');
    const manual = document.querySelector('[data-testid="brainstorm-manual"]');
    return refusal && manual
      ? Boolean(refusal.compareDocumentPosition(manual) & Node.DOCUMENT_POSITION_FOLLOWING)
      : null;
  });
  expect(order).toBe(true);
  await page.getByTestId('brainstorm-panel').screenshot({ path: 'e2e/screenshots/m11-spend-cap-refusal.png' });

  // Nothing reached the API and nothing was recorded.
  expect(stub.requests.length).toBe(before);
  expect((await usageRows()).length).toBe(rowsBefore + 1);

  // Drawn again at the cap, the page leads with Open in Claude before anything
  // is pressed: the note says why, the pill asks nothing, and "Ask" is gone.
  await openPanel(page, videoId);
  const note = page.getByTestId('brainstorm-cap-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('the default cap of $10');
  await expect(page.getByTestId('brainstorm-cap-spent')).toHaveText('$10.00');
  await expect(page.getByTestId('brainstorm-manual')).toHaveAttribute('data-mode', 'primary');
  await expect(page.getByTestId('brainstorm-ask-again')).toHaveCount(0);
  await expect(page.getByTestId('brainstorm-failure')).toHaveCount(0);
  expect(stub.requests.length).toBe(before);

  // The note links to Settings, where the month says the cap is reached.
  const link = page.getByTestId('brainstorm-spend-cap-settings');
  await expect(link).toHaveAttribute('href', '/settings/account#spending');
  await link.click();
  await page.waitForURL('**/settings/account#spending');
  await expect(page.getByTestId('spending-spent')).toHaveText('$10.00');
  await expect(page.getByTestId('spending-at-cap')).toContainText('Cap reached');
  await expect(page.getByTestId('spending-meter')).toHaveAttribute('aria-valuenow', '100');
});

test('raising the cap in Settings lets the next call through, and it is counted', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/settings/account');
  const input = page.getByTestId('spending-cap-input');
  await expect(input).toHaveValue('10');

  await untilTaken(
    async () => {
      await input.fill('25');
    },
    () => expect(page.getByTestId('spending-cap-status')).toContainText('Not saved yet', { timeout: 2_000 }),
  );
  await page.getByTestId('spending-cap-save').click();
  await expect(page.getByTestId('spending-cap-status')).toHaveText(/Saved/);
  await expect(page.getByTestId('spending-cap')).toHaveText('$25');
  await expect(page.getByTestId('settings-spending')).not.toContainText('Cap (default)');

  const stored = await db.query<{ cap_dollars: number | null }>(
    'select cap_dollars from public.assist_caps where user_id = $1',
    [userId],
  );
  expect(stored.rows).toEqual([{ cap_dollars: 25 }]);

  // The refused video asks again on opening, and this time it goes.
  const before = stub.requests.length;
  const videoId = await capture('A third video, after the cap was raised');
  await openPanel(page, videoId);
  await expect(page.getByTestId('brainstorm-suggestion')).toHaveCount(12);
  expect(stub.requests.length).toBe(before + 1);

  await page.goto('/settings/account');
  await expect(page.getByTestId('spending-spent')).toHaveText('$10.09');
  await expect(page.getByTestId('spending-calls')).toHaveText('3');
  await expect(page.getByTestId('spending-at-cap')).toHaveCount(0);
});

test('an empty box is no cap, and a $0 cap refuses every call', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/account');
  const input = page.getByTestId('spending-cap-input');
  await expect(input).toHaveValue('25');

  await untilTaken(
    async () => {
      await input.fill('0');
    },
    () => expect(page.getByTestId('spending-cap-status')).toContainText('Not saved yet', { timeout: 2_000 }),
  );
  await page.getByTestId('spending-cap-save').click();
  await expect(page.getByTestId('spending-cap')).toHaveText('$0');

  const before = stub.requests.length;
  const videoId = await capture('A fourth video, under a zero cap');
  await openPanel(page, videoId);
  // A $0 cap is reached before anything is spent: the page leads with Open in
  // Claude and asks nothing.
  await expect(page.getByTestId('brainstorm-cap-note')).toContainText('your cap of $0');
  await expect(page.getByTestId('brainstorm-manual')).toHaveAttribute('data-mode', 'primary');
  expect(stub.requests.length).toBe(before);

  await page.goto('/settings/account');
  await page.getByTestId('spending-cap-input').fill('');
  await page.getByTestId('spending-cap-save').click();
  await expect(page.getByTestId('spending-cap')).toHaveText('No cap');
  const stored = await db.query<{ cap_dollars: number | null }>(
    'select cap_dollars from public.assist_caps where user_id = $1',
    [userId],
  );
  expect(stored.rows).toEqual([{ cap_dollars: null }]);

  // With no cap, the refused video asks again on opening, and it goes.
  await openPanel(page, videoId);
  await expect(page.getByTestId('brainstorm-suggestion')).toHaveCount(12);
  expect(stub.requests.length).toBe(before + 1);
});

test('the spending section is usable by thumb on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto('/settings/account');
  await expect(page.getByTestId('settings-spending')).toBeVisible();

  const input = page.getByTestId('spending-cap-input');
  const save = page.getByTestId('spending-cap-save');
  // 16px in the field, so iOS does not zoom on focus.
  expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  for (const control of [input, save]) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    // 44px under a thumb.
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  const scroll = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll.width).toBeLessThanOrEqual(scroll.client);
  await page.getByTestId('settings-spending').screenshot({ path: 'e2e/screenshots/m11-spending-phone.png' });
});
