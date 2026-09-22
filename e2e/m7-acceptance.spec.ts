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
 * M7 — the settings area as one screen, and PLAN.md's runnable walked through
 * it: *toggle Repurposed off, rename Packaging, board follows*.
 *
 * Three slices built four settings pages; the integration pass made them one
 * area. Each slice's own spec proves its editor (`settings-stages`,
 * `settings-checklists`, `settings-channel`); this one proves the joins:
 *
 * 1. **One area.** The sidebar's Settings row is a real link a keyboard can
 *    reach; the four screens share one strip that keeps the channel, and one
 *    channel switch that keeps the screen; every bare settings address lands
 *    on the first channel.
 * 2. **The runnable.** Repurposed switched off and Packaging renamed on the
 *    settings screen; the board draws the renamed column and not the lane;
 *    and the gate still fires by *kind* — a titleless video's move out of the
 *    renamed stage is refused with the gate's own sentence, from the stage
 *    select on the video page, which lists the new label and not the lane.
 * 3. **The placeholder closed.** The matrix's "no pillars yet" panel, which
 *    said "arrives in M7" until now, is a link to the bucket editor; a pillar
 *    named there is a row on the matrix on the way back.
 */

const CHANNEL = { name: 'M7 Area', slug: 'm7-area' };
const OTHER = { name: 'M7 Area Other', slug: 'm7-area-other' };

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

/** Run `fn` as the signed-in user, the way a PostgREST request runs it. */
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

/** A fresh channel from the seed, through `create_channel` like the app. */
async function resetChannel(channel: { name: string; slug: string }): Promise<string> {
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug = $1)`,
    [channel.slug],
  );
  await db.query('delete from public.channels where slug = $1', [channel.slug]);

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
        channel.name,
        channel.slug,
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
async function capture(channelId: string, title: string): Promise<string> {
  return asUser(async () => {
    const result = await db.query<{ id: string }>(
      'select id from capture_video($1::uuid, $2::text)',
      [channelId, title],
    );
    return result.rows[0].id;
  });
}

interface StageRow {
  id: string;
  name: string;
  kind: string | null;
  position: number;
  is_enabled: boolean;
}

async function stagesOf(channelId: string): Promise<StageRow[]> {
  const result = await db.query<StageRow>(
    'select id, name, kind, position, is_enabled from public.stages where channel_id = $1 order by position',
    [channelId],
  );
  return result.rows;
}

/** The first channel by the rule the sidebar and every bare address use. */
async function firstChannelSlug(): Promise<string> {
  const result = await db.query<{ slug: string }>(
    'select slug from public.channels where user_id = $1 order by created_at asc limit 1',
    [userId],
  );
  return result.rows[0].slug;
}

/* -------------------------------------------------------------------------- */
/* Browser helpers                                                             */
/* -------------------------------------------------------------------------- */

async function signIn(page: Page): Promise<void> {
  await page.setViewportSize({ width: 2880, height: 1100 });
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}

/** The app's own hydration signal: the sidebar's `c` binding is live. */
async function hydrated(page: Page): Promise<void> {
  await expect(
    page.locator('button[aria-keyshortcuts="c"][data-shortcut-ready="true"]'),
  ).toBeVisible();
}

const sidebar = (page: Page): Locator => page.getByRole('navigation', { name: 'Main' });
const settingsNav = (page: Page): Locator => page.getByTestId('settings-nav');
const navLink = (page: Page, section: string): Locator =>
  page.locator(`[data-testid="settings-nav-link"][data-section="${section}"]`);
const channelName = (page: Page): Locator => page.getByTestId('settings-channel-name');

const stageRow = (page: Page, kind: string): Locator =>
  page.locator(`[data-testid="stage-row"][data-kind="${kind}"]`);

const column = (page: Page, name: string): Locator =>
  page.getByRole('region', { name, exact: true });

/** The board's column headings, left to right. */
async function columnNames(page: Page): Promise<string[]> {
  return page
    .getByTestId('board-column')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-stage-name') ?? ''));
}

/* -------------------------------------------------------------------------- */
/* Setup                                                                       */
/* -------------------------------------------------------------------------- */

let channelId: string;

test.beforeEach(async ({ page }) => {
  channelId = await resetChannel(CHANNEL);
  await resetChannel(OTHER);
  await signIn(page);
});

/* -------------------------------------------------------------------------- */
/* 1. One area                                                                 */
/* -------------------------------------------------------------------------- */

test('the sidebar reaches Settings by keyboard, and the four screens are one area that keeps the channel and the section', async ({
  page,
}) => {
  const first = await firstChannelSlug();

  // The row is a link — the last of the sidebar's placeholders is gone — and
  // it opens the Board row's channel, like Ideas does.
  await expect(sidebar(page).getByTestId('sidebar-unbuilt')).toHaveCount(0);
  const settingsLink = sidebar(page).getByRole('link', { name: 'Settings', exact: true });
  await expect(settingsLink).toHaveAttribute('href', `/settings/stages/${first}`);
  await settingsLink.focus();
  await expect(settingsLink).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForURL(`**/settings/stages/${first}`);
  await expect(settingsLink).toHaveAttribute('aria-current', 'page');

  // Every bare settings address lands on the first channel, by the same rule.
  for (const section of ['', '/stages', '/checklists', '/buckets', '/channel']) {
    await page.goto(`/settings${section}`);
    await page.waitForURL(`**/settings/${section === '' ? 'stages' : section.slice(1)}/${first}`);
  }

  // From this channel's stages, the strip reaches the other three screens
  // without losing the channel, and marks where you are.
  await page.goto(`/settings/stages/${CHANNEL.slug}`);
  await hydrated(page);
  await expect(settingsNav(page).getByRole('link')).toHaveCount(4);
  await expect(navLink(page, 'stages')).toHaveAttribute('aria-current', 'page');
  await expect(channelName(page)).toHaveText(CHANNEL.name);

  for (const [section, root] of [
    ['checklists', 'settings-checklists'],
    ['buckets', 'settings-buckets'],
    ['channel', 'settings-channel'],
    ['stages', 'settings-stages'],
  ] as const) {
    await navLink(page, section).click();
    await page.waitForURL(`**/settings/${section}/${CHANNEL.slug}`);
    await expect(page.getByTestId(root)).toHaveAttribute('data-channel', CHANNEL.slug);
    await expect(navLink(page, section)).toHaveAttribute('aria-current', 'page');
    await expect(settingsNav(page).locator('[aria-current="page"]')).toHaveCount(1);
    await expect(channelName(page)).toHaveText(CHANNEL.name);
    // The sidebar agrees about both: the section and the channel.
    await expect(
      sidebar(page).getByRole('link', { name: 'Settings', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(
      sidebar(page).getByRole('link', { name: CHANNEL.name, exact: true }),
    ).toHaveAttribute('aria-current', 'true');
  }

  // The channel switch keeps the section: from this channel's checklists to
  // the other channel's checklists, never to its stages.
  await navLink(page, 'checklists').click();
  await page.waitForURL(`**/settings/checklists/${CHANNEL.slug}`);
  const toOther = page
    .getByTestId('settings-channel-switch')
    .getByRole('link', { name: OTHER.name, exact: true });
  await expect(toOther).toHaveAttribute('href', `/settings/checklists/${OTHER.slug}`);
  await toOther.click();
  await page.waitForURL(`**/settings/checklists/${OTHER.slug}`);
  await expect(page.getByTestId('settings-checklists')).toHaveAttribute('data-channel', OTHER.slug);
  await expect(navLink(page, 'checklists')).toHaveAttribute('aria-current', 'page');
  await expect(channelName(page)).toHaveText(OTHER.name);
  await expect(
    sidebar(page).getByRole('link', { name: OTHER.name, exact: true }),
  ).toHaveAttribute('aria-current', 'true');
});

/* -------------------------------------------------------------------------- */
/* 2. PLAN.md's runnable                                                       */
/* -------------------------------------------------------------------------- */

test('toggle Repurposed off and rename Packaging on the settings screen: the board follows, the gate does not change', async ({
  page,
}) => {
  const videoId = await capture(channelId, 'Still an idea');

  await page.goto(`/settings/stages/${CHANNEL.slug}`);
  await hydrated(page);

  // Repurposed off. It holds nothing, so the switch is accepted.
  const repurposed = stageRow(page, 'repurposed');
  await expect(repurposed.getByTestId('stage-count')).toHaveAttribute('data-count', '0');
  await repurposed.getByTestId('stage-enabled').click();
  await expect(repurposed).toHaveAttribute('data-enabled', 'false');
  await expect
    .poll(async () => (await stagesOf(channelId)).find((s) => s.kind === 'repurposed')?.is_enabled)
    .toBe(false);

  // Packaging renamed. Enter commits, the row says saved, Postgres holds it.
  const packaging = stageRow(page, 'packaging');
  await packaging.getByTestId('stage-name').fill('Packaging & hook');
  await packaging.getByTestId('stage-name').press('Enter');
  await expect(packaging.getByTestId('stage-name-status')).toHaveAttribute('data-state', 'saved');
  const after = await stagesOf(channelId);
  expect(after.find((s) => s.kind === 'packaging')?.name).toBe('Packaging & hook');
  // Every kind is still where the seed put it: a rename and a switch changed
  // two columns of two rows and nothing else.
  expect(after.map((s) => [s.kind, s.position])).toEqual(
    SEED_STAGES.map((s) => [s.kind, s.position]),
  );

  // The board follows: the renamed column is there, the lane is not.
  await page.goto(`/c/${CHANNEL.slug}/board`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
  expect(await columnNames(page)).toEqual(
    SEED_STAGES.filter((s) => s.kind !== 'repurposed').map((s) =>
      s.kind === 'packaging' ? 'Packaging & hook' : s.name,
    ),
  );
  await expect(column(page, 'Packaging & hook')).toBeVisible();
  await expect(column(page, 'Repurposed')).toHaveCount(0);

  // And the behaviour does not: on the video page the stage select offers the
  // new label and not the lane, moving into the renamed stage is allowed, and
  // moving *out* of it with no concept and no hook is refused by the gate —
  // which names the missing field by the gate's wording and the stage by the
  // channel's *new* label, because `move_video` compares kinds and the
  // sentence is about the column the video is still in (M7's review).
  // The stage select lives in the Schedule section, the way m2-review opens it.
  await page.goto(`/videos/${videoId}?section=schedule`);
  await hydrated(page);
  const select = page.getByTestId('stage-select');
  await expect(select).toBeVisible();
  const options = await select.locator('option').allTextContents();
  expect(options).toContain('Packaging & hook');
  expect(options).not.toContain('Packaging (TTH)');
  expect(options).not.toContain('Repurposed');

  const packagingId = after.find((s) => s.kind === 'packaging')!.id;
  const scriptingId = after.find((s) => s.kind === 'scripting')!.id;
  await select.selectOption(packagingId);
  await expect(page.getByTestId('stage-select-status')).toContainText('Moved to Packaging & hook');
  await select.selectOption(scriptingId);
  const status = page.getByTestId('stage-select-status');
  await expect(status).toContainText('Could not move to Scripting.');
  await expect(status).toContainText('Packaging & hook still needs');
  await expect(select).toHaveValue(packagingId);
  const stored = await db.query<{ stage_id: string }>(
    'select stage_id from public.videos where id = $1',
    [videoId],
  );
  expect(stored.rows[0].stage_id).toBe(packagingId);

  // The lane switch on the video page and the settings row are one switch:
  // switching Repurposed back on here is what the settings row now shows.
  await page.goto(`/settings/stages/${CHANNEL.slug}`);
  await hydrated(page);
  await stageRow(page, 'repurposed').getByTestId('stage-enabled').click();
  await expect(stageRow(page, 'repurposed')).toHaveAttribute('data-enabled', 'true');
  await expect
    .poll(async () => (await stagesOf(channelId)).find((s) => s.kind === 'repurposed')?.is_enabled)
    .toBe(true);
  await page.goto(`/c/${CHANNEL.slug}/board`);
  await expect(column(page, 'Repurposed')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* 3. The placeholder, closed                                                  */
/* -------------------------------------------------------------------------- */

test('the matrix with no pillars links to the bucket editor, and a pillar named there is a row on the way back', async ({
  page,
}) => {
  await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix`);
  await hydrated(page);

  const panel = page.getByTestId('matrix-needs-buckets');
  await expect(panel).toHaveAttribute('data-verticals', '0');
  await expect(page.getByTestId('matrix-grid')).toHaveCount(0);

  // The control that said "M7" until M7 is the link it stood in for.
  const add = page.getByTestId('add-buckets');
  await expect(add).toHaveAttribute('href', `/settings/buckets/${CHANNEL.slug}`);
  await expect(add).not.toHaveAttribute('aria-disabled', /.*/);
  await expect(panel).not.toContainText('M7');
  await add.click();
  await page.waitForURL(`**/settings/buckets/${CHANNEL.slug}`);
  await hydrated(page);
  await expect(navLink(page, 'buckets')).toHaveAttribute('aria-current', 'page');
  await expect(channelName(page)).toHaveText(CHANNEL.name);

  // Name a pillar there.
  const form = page.getByTestId('add-bucket-vertical');
  await form.getByTestId('add-bucket-name').fill('money');
  await form.getByTestId('add-bucket-submit').click();
  await expect(
    page.locator('[data-testid="bucket-row"][data-bucket-name="money"]'),
  ).toBeVisible();

  // Back on the matrix it is a row, crossed with all eight seeded formats.
  await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix`);
  await expect(page.getByTestId('matrix-grid')).toBeVisible();
  await expect(page.locator('[data-testid="matrix-row"][data-bucket="money"]')).toBeVisible();
  await expect(page.getByTestId('matrix-cell')).toHaveCount(SEED_BUCKETS.length);
});
