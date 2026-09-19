import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import { SEED_STAGES } from '../lib/defaults';
import { apiKey } from '../scripts/dev-stack/jwt';
import {
  API_KEY_EXP,
  API_KEY_IAT,
  GATEWAY_URL,
  PG,
  SEED_EMAIL,
  SEED_PASSWORD,
} from '../scripts/dev-stack/shared';

/**
 * M7 — the stages editor, `/settings/stages/[slug]`.
 *
 * Five claims, each of which is a way this screen could quietly break the
 * board it configures:
 *
 * 1. **A rename is a label.** Packaging becomes "Packaging & hook" on the
 *    board and in Postgres — and the TTH gate still fires on the way *out* of
 *    it, because `move_video` compares `kind`, not `name`. The other channel's
 *    Packaging is untouched.
 * 2. **Switching off an occupied stage is refused**, with the count and a
 *    link to the videos, and the switch springs back. Archive the video and
 *    the same switch is accepted.
 * 3. **Switching off an empty stage removes its column**; switching it back
 *    on restores it.
 * 4. **A core stage never crosses another core stage.** On a fresh channel no
 *    arrow is offered at all; and a reorder posted straight at PostgREST with
 *    a real session — `reorder_stages` with Filming and Editing swapped, and
 *    a PATCH of `position` or `is_enabled` — is refused by the database.
 * 5. **An added stage is a column with no behaviour.** It appears, it moves
 *    between core stages, a video can be dragged into it, and removing it is
 *    refused while the video is there.
 *
 * The fixture is SQL because the settings screen is what is under test;
 * everything the screen is *for* is done by clicking. The stage rows are reset
 * to the seed before each test in one statement, the way the app itself would
 * have to write them.
 */

const CHANNEL = { name: 'M7 Stages', slug: 'm7-stages' };
const OTHER = { name: 'M7 Stages Other', slug: 'm7-stages-other' };

const ANON_KEY = apiKey('anon', API_KEY_IAT, API_KEY_EXP);

let db: pg.Client;

test.beforeAll(async () => {
  db = new pg.Client({
    host: PG.host,
    port: PG.port,
    user: PG.user,
    password: PG.password === '' ? undefined : PG.password,
    database: PG.database,
  });
  await db.connect();
});

test.afterAll(async () => {
  await db?.end();
});

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

interface ChannelRow {
  id: string;
  user_id: string;
}

async function channelRow(slug: string): Promise<ChannelRow | null> {
  const result = await db.query<ChannelRow>(
    'select id, user_id from public.channels where slug = $1',
    [slug],
  );
  return result.rows[0] ?? null;
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

async function stageByKind(channelId: string, kind: string): Promise<StageRow> {
  const stage = (await stagesOf(channelId)).find((row) => row.kind === kind);
  if (!stage) throw new Error(`no ${kind} stage on that channel`);
  return stage;
}

/**
 * Back to the seed: no videos, no added stages, the nine core stages at their
 * seeded names and positions, all on. The positions go in ONE statement, since
 * the unique on (channel_id, position) is checked at commit and this runs as
 * the owner, outside the grant.
 */
async function resetStages(channel: ChannelRow): Promise<void> {
  await db.query('delete from public.videos where channel_id = $1', [channel.id]);
  await db.query('delete from public.stages where channel_id = $1 and kind is null', [
    channel.id,
  ]);
  await db.query(
    `update public.stages s
        set name = t.name, position = t.position, is_enabled = true
       from (select * from unnest($2::text[], $3::text[], $4::int[]) as u(kind, name, position)) t
      where s.channel_id = $1 and s.kind = t.kind`,
    [
      channel.id,
      SEED_STAGES.map((stage) => stage.kind),
      SEED_STAGES.map((stage) => stage.name),
      SEED_STAGES.map((stage) => stage.position),
    ],
  );
}

/** One video, straight into a stage — a titleless idea unless told otherwise. */
async function seedVideo(
  channel: ChannelRow,
  kind: string,
  title: string,
): Promise<string> {
  const stage = await stageByKind(channel.id, kind);
  const result = await db.query<{ id: string }>(
    `insert into public.videos (user_id, channel_id, stage_id, title)
     values ($1, $2, $3, $4) returning id`,
    [channel.user_id, channel.id, stage.id, title],
  );
  return result.rows[0].id;
}

async function videoStageId(videoId: string): Promise<string> {
  const result = await db.query<{ stage_id: string }>(
    'select stage_id from public.videos where id = $1',
    [videoId],
  );
  return result.rows[0].stage_id;
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

async function createChannel(
  page: Page,
  channel: { name: string; slug: string },
): Promise<void> {
  await page.goto('/c/new');
  await page.getByLabel('Channel name').fill(channel.name);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.waitForURL(`**/c/${channel.slug}/board`);
}

/** The app's own hydration signal: the sidebar's `c` binding is live. */
async function hydrated(page: Page): Promise<void> {
  await expect(
    page.locator('button[aria-keyshortcuts="c"][data-shortcut-ready="true"]'),
  ).toBeVisible();
}

async function openSettings(page: Page, slug: string): Promise<void> {
  await page.goto(`/settings/stages/${slug}`);
  await expect(page.getByTestId('settings-stages')).toHaveAttribute('data-channel', slug);
  await hydrated(page);
}

const rowByKind = (page: Page, kind: string): Locator =>
  page.locator(`[data-testid="stage-row"][data-kind="${kind}"]`);

const rowByName = (page: Page, name: string): Locator =>
  page.locator(`[data-testid="stage-row"][data-stage-name="${name}"]`);

async function openBoard(page: Page, slug: string): Promise<void> {
  await page.goto(`/c/${slug}/board`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
}

const column = (page: Page, name: string): Locator =>
  page.getByRole('region', { name, exact: true });

const cardIn = (page: Page, name: string, title: string): Locator =>
  column(page, name).getByTestId('board-card').filter({ hasText: title });

/** The board's column headings, left to right. */
async function columnNames(page: Page): Promise<string[]> {
  return page
    .getByTestId('board-column')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-stage-name') ?? ''));
}

/** A native HTML5 drag, the way `e2e/board.m1.spec.ts` drives one. */
async function dragCardTo(page: Page, card: Locator, targetColumn: string): Promise<void> {
  const dropzone = column(page, targetColumn).getByTestId('column-dropzone');
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent('dragstart', { dataTransfer });
  await dropzone.dispatchEvent('dragover', { dataTransfer });
  await dropzone.dispatchEvent('drop', { dataTransfer });
  await dataTransfer.dispose();
}

/* -------------------------------------------------------------------------- */
/* Setup                                                                       */
/* -------------------------------------------------------------------------- */

let channel: ChannelRow;
let other: ChannelRow;

test.beforeEach(async ({ page }) => {
  await signIn(page);

  if ((await channelRow(CHANNEL.slug)) === null) await createChannel(page, CHANNEL);
  if ((await channelRow(OTHER.slug)) === null) await createChannel(page, OTHER);

  const mine = await channelRow(CHANNEL.slug);
  const theirs = await channelRow(OTHER.slug);
  if (!mine || !theirs) throw new Error('the fixture channels are missing');
  channel = mine;
  other = theirs;

  await resetStages(channel);
  await resetStages(other);
});

/* -------------------------------------------------------------------------- */
/* 1. Rename                                                                   */
/* -------------------------------------------------------------------------- */

test('renaming Packaging relabels the board column and changes nothing about the gate', async ({
  page,
}) => {
  const ideaId = await seedVideo(channel, 'idea', 'Rename me not');

  await openSettings(page, CHANNEL.slug);

  // The channel is unmistakable: in the heading and on the root.
  await expect(page.getByTestId('settings-stages-channel')).toHaveText(CHANNEL.name);
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }),
  ).toHaveAttribute('aria-current', 'page');

  const row = rowByKind(page, 'packaging');
  const name = row.getByTestId('stage-name');
  await expect(name).toHaveValue('Packaging (TTH)');
  await name.fill('Packaging & hook');
  await name.press('Enter');
  await expect(row.getByTestId('stage-name-status')).toHaveAttribute('data-state', 'saved');

  // Postgres holds the label; the kind is untouched, and the other channel's
  // Packaging is still called what the seed called it.
  const packaging = await stageByKind(channel.id, 'packaging');
  expect(packaging.name).toBe('Packaging & hook');
  expect((await stageByKind(other.id, 'packaging')).name).toBe('Packaging (TTH)');

  // The board follows.
  await openBoard(page, CHANNEL.slug);
  await expect(column(page, 'Packaging & hook')).toBeVisible();
  await expect(column(page, 'Packaging (TTH)')).toHaveCount(0);

  // Into the renamed stage: never gated — the gate guards the stages after it.
  await dragCardTo(page, cardIn(page, 'Idea', 'Rename me not'), 'Packaging & hook');
  await expect(cardIn(page, 'Packaging & hook', 'Rename me not')).toBeVisible();
  // The card moves optimistically; the row moves when `move_video` lands, and
  // the card stays `aria-busy` until the answer is back — a drop on a busy
  // card is ignored, so the next drag waits for it.
  await expect.poll(() => videoStageId(ideaId)).toBe(packaging.id);
  await expect(cardIn(page, 'Packaging & hook', 'Rename me not')).not.toHaveAttribute(
    'aria-busy',
    'true',
  );

  // Out of it with an empty concept and no hook: refused, by kind. The toast
  // names the column by its new label and the missing field by the gate's
  // wording — the label changed, the rule did not.
  await dragCardTo(page, cardIn(page, 'Packaging & hook', 'Rename me not'), 'Scripting');
  const toast = page.getByTestId('toast');
  await expect(toast).toContainText('Could not move “Rename me not” to Scripting.');
  await expect(toast).toContainText('Packaging still needs');
  await expect(cardIn(page, 'Packaging & hook', 'Rename me not')).toBeVisible();
  await expect(cardIn(page, 'Scripting', 'Rename me not')).toHaveCount(0);
  expect(await videoStageId(ideaId)).toBe(packaging.id);

  // And a blank name is refused before it reaches the row.
  await openSettings(page, CHANNEL.slug);
  const again = rowByKind(page, 'packaging').getByTestId('stage-name');
  await again.fill('   ');
  await again.press('Enter');
  await expect(rowByKind(page, 'packaging').getByTestId('stage-name-status')).toHaveAttribute(
    'data-state',
    'error',
  );
  expect((await stageByKind(channel.id, 'packaging')).name).toBe('Packaging & hook');
});

/* -------------------------------------------------------------------------- */
/* 2. Switching off an occupied stage                                          */
/* -------------------------------------------------------------------------- */

test('switching off a stage that holds a video is refused with the count and a link; archived videos do not count', async ({
  page,
}) => {
  const videoId = await seedVideo(channel, 'scripting', 'Still being written');

  await openSettings(page, CHANNEL.slug);

  const row = rowByKind(page, 'scripting');
  await expect(row.getByTestId('stage-count')).toHaveAttribute('data-count', '1');

  const toggle = row.getByTestId('stage-enabled');
  await expect(toggle).toBeChecked();
  await toggle.click();

  const refusal = row.getByTestId('stage-refusal');
  await expect(refusal).toContainText('Scripting still holds a video');
  await expect(refusal).toContainText('Move it on or archive it first');
  await expect(row.getByTestId('stage-refusal-link')).toHaveAttribute(
    'href',
    `/c/${CHANNEL.slug}/board`,
  );
  // The switch sprang back, and the row never went off.
  await expect(toggle).toBeChecked();
  expect((await stageByKind(channel.id, 'scripting')).is_enabled).toBe(true);

  // Archived videos are off the board already, so they are not in the way.
  await db.query('update public.videos set archived_at = now() where id = $1', [videoId]);
  await openSettings(page, CHANNEL.slug);
  await expect(rowByKind(page, 'scripting').getByTestId('stage-count')).toHaveAttribute(
    'data-count',
    '0',
  );
  await rowByKind(page, 'scripting').getByTestId('stage-enabled').click();
  await expect(rowByKind(page, 'scripting')).toHaveAttribute('data-enabled', 'false');
  await expect
    .poll(async () => (await stageByKind(channel.id, 'scripting')).is_enabled)
    .toBe(false);
});

/* -------------------------------------------------------------------------- */
/* 3. Switching an empty stage off and on                                      */
/* -------------------------------------------------------------------------- */

test('switching off an empty stage removes its column, and switching it on brings it back', async ({
  page,
}) => {
  await openSettings(page, CHANNEL.slug);

  const row = rowByKind(page, 'repurposed');
  await row.getByTestId('stage-enabled').click();
  await expect(row).toHaveAttribute('data-enabled', 'false');
  await expect(row.getByTestId('stage-refusal')).toHaveCount(0);
  await expect
    .poll(async () => (await stageByKind(channel.id, 'repurposed')).is_enabled)
    .toBe(false);

  await openBoard(page, CHANNEL.slug);
  expect(await columnNames(page)).toEqual(
    SEED_STAGES.map((stage) => stage.name).filter((name) => name !== 'Repurposed'),
  );

  await openSettings(page, CHANNEL.slug);
  await expect(rowByKind(page, 'repurposed')).toHaveAttribute('data-enabled', 'false');
  await rowByKind(page, 'repurposed').getByTestId('stage-enabled').click();
  await expect(rowByKind(page, 'repurposed')).toHaveAttribute('data-enabled', 'true');
  await expect
    .poll(async () => (await stageByKind(channel.id, 'repurposed')).is_enabled)
    .toBe(true);

  await openBoard(page, CHANNEL.slug);
  expect(await columnNames(page)).toEqual(SEED_STAGES.map((stage) => stage.name));
});

/* -------------------------------------------------------------------------- */
/* 4. The core order                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What a client can do to `stages` with its own session, run inside the page:
 * the forged versions of the moves the screen does not offer. The control —
 * a rename, which the client *is* granted — proves the token works, so the
 * refusals below are the grant and the function, not a broken session.
 */
async function forgedWrites(
  page: Page,
  input: { channelId: string; swappedIds: string[]; stageId: string },
): Promise<{
  control: { status: number };
  reorder: { status: number; body: string };
  position: { status: number; body: string };
  enabled: { status: number; body: string };
}> {
  return page.evaluate(
    async ({ gateway, anon, email, password, channelId, swappedIds, stageId }) => {
      const session = await fetch(`${gateway}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: anon, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const { access_token: token } = (await session.json()) as { access_token?: string };
      const headers = {
        apikey: anon,
        Authorization: `Bearer ${token ?? ''}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      };
      async function attempt(url: string, method: string, body: unknown) {
        const response = await fetch(url, { method, headers, body: JSON.stringify(body) });
        return { status: response.status, body: await response.text() };
      }

      const control = await attempt(`${gateway}/rest/v1/stages?id=eq.${stageId}`, 'PATCH', {
        name: 'Filming (renamed directly)',
      });
      await attempt(`${gateway}/rest/v1/stages?id=eq.${stageId}`, 'PATCH', { name: 'Filming' });

      const reorder = await attempt(`${gateway}/rest/v1/rpc/reorder_stages`, 'POST', {
        p_channel: channelId,
        p_stage_ids: swappedIds,
      });
      const position = await attempt(`${gateway}/rest/v1/stages?id=eq.${stageId}`, 'PATCH', {
        position: 1,
      });
      const enabled = await attempt(`${gateway}/rest/v1/stages?id=eq.${stageId}`, 'PATCH', {
        is_enabled: false,
      });
      return { control: { status: control.status }, reorder, position, enabled };
    },
    {
      gateway: GATEWAY_URL,
      anon: ANON_KEY,
      email: SEED_EMAIL,
      password: SEED_PASSWORD,
      ...input,
    },
  );
}

test('a core stage is never offered a move across another core stage, and a forged one is refused by the database', async ({
  page,
}) => {
  await openSettings(page, CHANNEL.slug);

  // Nine core stages in a row: no arrow anywhere, each saying why.
  await expect(page.getByTestId('stage-row')).toHaveCount(9);
  await expect(page.locator('[data-testid^="stage-move-"][data-offered="true"]')).toHaveCount(0);
  const editingUp = rowByKind(page, 'editing').getByTestId('stage-move-up');
  await expect(editingUp).toBeDisabled();
  await expect(editingUp).toHaveAttribute(
    'title',
    'Core stages keep their order: Filming stays before Editing.',
  );

  // Posted straight at PostgREST with a real session.
  const before = await stagesOf(channel.id);
  const filming = before.find((stage) => stage.kind === 'filming')!;
  const editing = before.find((stage) => stage.kind === 'editing')!;
  const swapped = before.map((stage) =>
    stage.id === filming.id ? editing.id : stage.id === editing.id ? filming.id : stage.id,
  );

  const result = await forgedWrites(page, {
    channelId: channel.id,
    swappedIds: swapped,
    stageId: filming.id,
  });

  // The session is good: the one column a client may write, it wrote.
  expect(result.control.status, 'the rename control should succeed').toBe(200);
  // The function refuses the crossing by name...
  expect(result.reorder.status).toBe(400);
  expect(result.reorder.body).toContain('core order');
  // ...and the columns themselves are not the client's to write at all.
  expect(result.position.status).toBe(403);
  expect(result.position.body).toContain('42501');
  expect(result.enabled.status).toBe(403);
  expect(result.enabled.body).toContain('42501');

  // Nothing moved and nothing went off.
  const after = await stagesOf(channel.id);
  expect(after.map((stage) => [stage.kind, stage.position, stage.is_enabled])).toEqual(
    before.map((stage) => [stage.kind, stage.position, stage.is_enabled]),
  );
});

/* -------------------------------------------------------------------------- */
/* 5. An added, inert stage                                                    */
/* -------------------------------------------------------------------------- */

test('an added stage gets a column, moves between core stages, holds a video, and cannot be removed while it does', async ({
  page,
}) => {
  const ideaId = await seedVideo(channel, 'idea', 'Needs a sponsor read');

  await openSettings(page, CHANNEL.slug);

  await page.getByTestId('add-stage-name').fill('Sponsor review');
  await page.getByTestId('add-stage-submit').click();

  const row = rowByName(page, 'Sponsor review');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-kind', 'inert');
  await expect(row.getByTestId('stage-kind')).toHaveText('added — no behaviour');
  await expect(page.getByTestId('stage-row')).toHaveCount(10);

  // It arrived last, so only "up" is offered — and now Repurposed can step
  // down over it, because that crosses nothing core.
  await expect(row.getByTestId('stage-move-up')).toHaveAttribute('data-offered', 'true');
  await expect(row.getByTestId('stage-move-down')).toHaveAttribute('data-offered', 'false');
  await expect(rowByKind(page, 'repurposed').getByTestId('stage-move-down')).toHaveAttribute(
    'data-offered',
    'true',
  );
  await expect(rowByKind(page, 'published').getByTestId('stage-move-down')).toHaveAttribute(
    'data-offered',
    'false',
  );

  // Two steps up: between Scheduled and Published... no — between Published
  // and Repurposed, then between Scheduled and Published. Each is one round
  // trip through reorder_stages; each lands as 1..10 in Postgres.
  await row.getByTestId('stage-move-up').click();
  await expect
    .poll(async () => (await stagesOf(channel.id)).map((stage) => stage.name))
    .toEqual([
      ...SEED_STAGES.map((stage) => stage.name).slice(0, 8),
      'Sponsor review',
      'Repurposed',
    ]);
  // Focus stayed with the stage — on the arrow that is still offered.
  await expect(row.getByTestId('stage-move-up')).toBeFocused();

  await row.getByTestId('stage-move-up').click();
  await expect
    .poll(async () => (await stagesOf(channel.id)).map((stage) => [stage.name, stage.position]))
    .toEqual([
      ...SEED_STAGES.slice(0, 7).map((stage) => [stage.name, stage.position]),
      ['Sponsor review', 8],
      ['Published', 9],
      ['Repurposed', 10],
    ]);

  // The board draws it there, and a video can be dragged into it. `move_video`
  // gives a null kind order 0, so the gate does not apply on the way in — a
  // titleless idea can sit in it, which is exactly what "no behaviour" means.
  await openBoard(page, CHANNEL.slug);
  expect(await columnNames(page)).toEqual([
    ...SEED_STAGES.map((stage) => stage.name).slice(0, 7),
    'Sponsor review',
    'Published',
    'Repurposed',
  ]);
  await dragCardTo(page, cardIn(page, 'Idea', 'Needs a sponsor read'), 'Sponsor review');
  await expect(cardIn(page, 'Sponsor review', 'Needs a sponsor read')).toBeVisible();
  await expect(page.getByTestId('toast')).toHaveCount(0);
  const sponsor = (await stagesOf(channel.id)).find((stage) => stage.name === 'Sponsor review')!;
  await expect.poll(() => videoStageId(ideaId)).toBe(sponsor.id);
  await expect(cardIn(page, 'Sponsor review', 'Needs a sponsor read')).not.toHaveAttribute(
    'aria-busy',
    'true',
  );

  // Removing it while the video is in it is refused, with a link to the board;
  // switching it off is refused the same way.
  await openSettings(page, CHANNEL.slug);
  const again = rowByName(page, 'Sponsor review');
  await expect(again.getByTestId('stage-count')).toHaveAttribute('data-count', '1');
  await again.getByTestId('stage-remove').click();
  await again.getByTestId('stage-remove-yes').click();
  await expect(again.getByTestId('stage-refusal')).toContainText('Sponsor review still holds a video');
  await expect(again.getByTestId('stage-refusal-link')).toHaveAttribute(
    'href',
    `/c/${CHANNEL.slug}/board`,
  );
  expect((await stagesOf(channel.id)).some((stage) => stage.id === sponsor.id)).toBe(true);

  // Move the video back out (from the board, through the same RPC) and the
  // removal goes through.
  await openBoard(page, CHANNEL.slug);
  await dragCardTo(page, cardIn(page, 'Sponsor review', 'Needs a sponsor read'), 'Idea');
  await expect(cardIn(page, 'Idea', 'Needs a sponsor read')).toBeVisible();
  const idea = await stageByKind(channel.id, 'idea');
  await expect.poll(() => videoStageId(ideaId)).toBe(idea.id);

  await openSettings(page, CHANNEL.slug);
  await rowByName(page, 'Sponsor review').getByTestId('stage-remove').click();
  await rowByName(page, 'Sponsor review').getByTestId('stage-remove-yes').click();
  await expect(rowByName(page, 'Sponsor review')).toHaveCount(0);
  await expect
    .poll(async () => (await stagesOf(channel.id)).some((stage) => stage.id === sponsor.id))
    .toBe(false);
});

/* -------------------------------------------------------------------------- */
/* 6. Per channel                                                              */
/* -------------------------------------------------------------------------- */

test('the other channel is untouched by every edit above, and has its own address', async ({
  page,
}) => {
  await openSettings(page, CHANNEL.slug);
  await page.getByTestId('add-stage-name').fill('Only here');
  await page.getByTestId('add-stage-submit').click();
  await expect(rowByName(page, 'Only here')).toBeVisible();
  await rowByKind(page, 'repurposed').getByTestId('stage-enabled').click();
  await expect(rowByKind(page, 'repurposed')).toHaveAttribute('data-enabled', 'false');

  // The switch at the top is a link to the other channel's own page.
  await page
    .getByTestId('settings-channel-switch')
    .getByRole('link', { name: OTHER.name })
    .click();
  await page.waitForURL(`**/settings/stages/${OTHER.slug}`);
  await expect(page.getByTestId('settings-stages-channel')).toHaveText(OTHER.name);
  await expect(page.getByTestId('stage-row')).toHaveCount(9);
  await expect(rowByName(page, 'Only here')).toHaveCount(0);
  await expect(rowByKind(page, 'repurposed')).toHaveAttribute('data-enabled', 'true');

  const theirs = await stagesOf(other.id);
  expect(theirs).toHaveLength(9);
  expect(theirs.every((stage) => stage.is_enabled)).toBe(true);
});
