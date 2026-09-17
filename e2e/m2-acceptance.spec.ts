import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/**
 * M2 acceptance — PLAN.md's own list, walked in a browser.
 *
 * > *Runnable:* fill the three fields, move to Scripting; skip with a reason,
 * > see the badge; clear the title afterwards and see "Complete packaging".
 *
 * `e2e/packaging.spec.ts` and `e2e/flow-fields.spec.ts` test the two halves in
 * detail. This file is the composed page: one person, one video, the whole
 * sentence — plus the two links PLAN.md asks a gate refusal to offer, followed
 * from the board and checked for where the caret actually lands. A link that
 * scrolls a field into view and leaves focus on the body is a link that still
 * has to be finished with a click, so "did it focus" is the assertion, not
 * "is the fragment in the href".
 *
 * Every browser claim that changes a row is paired with a read of that row
 * through the same RLS-scoped path the app uses, because "the page says it
 * saved" and "the database has it" are different sentences.
 */

const CHANNEL = { name: 'M2 Acceptance', slug: 'm2-acceptance' };

const IDEA = 'Idea';
const PACKAGING = 'Packaging (TTH)';
const SCRIPTING = 'Scripting';

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

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

test.beforeEach(async () => {
  // Rebuilt per test: these assertions are about the exact contents of one row,
  // so a survivor from a failed run is not a cosmetic problem.
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug = $1)`,
    [CHANNEL.slug],
  );
  await db.query('delete from public.channels where slug = $1', [CHANNEL.slug]);
});

interface VideoRow {
  id: string;
  title: string;
  thumbnail_concept: string | null;
  hooks: { id: string; text: string; chosen?: boolean }[];
  packaging_skipped_at: string | null;
  packaging_skip_reason: string | null;
  stage_kind: string | null;
}

async function videoTitled(title: string): Promise<VideoRow> {
  const result = await db.query<VideoRow>(
    `select v.id, v.title, v.thumbnail_concept, v.hooks,
            v.packaging_skipped_at, v.packaging_skip_reason, s.kind as stage_kind
       from public.videos v
       join public.stages s on s.id = v.stage_id
       join public.channels c on c.id = v.channel_id
      where c.slug = $1 and v.title = $2`,
    [CHANNEL.slug, title],
  );
  if (result.rows.length !== 1) {
    throw new Error(
      `expected exactly one video called ${JSON.stringify(title)}, found ${result.rows.length}`,
    );
  }
  return result.rows[0];
}

/** The row behind a card, found by the id in its detail link rather than its title. */
async function videoById(id: string): Promise<VideoRow> {
  const result = await db.query<VideoRow>(
    `select v.id, v.title, v.thumbnail_concept, v.hooks,
            v.packaging_skipped_at, v.packaging_skip_reason, s.kind as stage_kind
       from public.videos v
       join public.stages s on s.id = v.stage_id
      where v.id = $1`,
    [id],
  );
  return result.rows[0];
}

/* -------------------------------------------------------------------------- */
/* Browser helpers                                                             */
/* -------------------------------------------------------------------------- */

async function signIn(page: Page): Promise<void> {
  // Wide enough that all nine columns are laid out, so a drag has somewhere to
  // aim; the detail page is a single column either way.
  await page.setViewportSize({ width: 2880, height: 1000 });
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/c\/[^/]+\/board$/);
}

async function createChannel(page: Page): Promise<void> {
  await page.goto('/c/new');
  await page.getByLabel('Channel name').fill(CHANNEL.name);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.waitForURL(`**/c/${CHANNEL.slug}/board`);
}

async function openBoard(page: Page): Promise<void> {
  await page.goto(`/c/${CHANNEL.slug}/board`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
}

const column = (page: Page, name: string): Locator =>
  page.getByRole('region', { name, exact: true });

const cardIn = (page: Page, name: string, title: string): Locator =>
  column(page, name).getByTestId('board-card').filter({ hasText: title });

/** Capture an idea the way a person does: `c`, type, Enter. */
async function capture(page: Page, title: string): Promise<void> {
  await expect(
    page.locator('button[aria-keyshortcuts="c"][data-shortcut-ready="true"]'),
  ).toBeVisible();
  await page.keyboard.press('c');
  await expect(page.getByRole('dialog', { name: 'Capture an idea' })).toBeVisible();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Capture an idea' })).toHaveCount(0);
  await expect(cardIn(page, IDEA, title)).toBeVisible();
}

async function dragCardTo(
  page: Page,
  card: Locator,
  targetColumn: string,
): Promise<void> {
  const dropzone = column(page, targetColumn).getByTestId('column-dropzone');
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent('dragstart', { dataTransfer });
  await dropzone.dispatchEvent('dragover', { dataTransfer });
  await dropzone.dispatchEvent('drop', { dataTransfer });
  await dataTransfer.dispose();
}

/**
 * Drag, and wait for the *database* to have agreed.
 *
 * The card moves optimistically, so "it is in the other column" is true a beat
 * before `move_video` has returned. Reading the row at that moment is a race
 * this suite would lose intermittently and for the wrong reason, so every
 * accepted drag waits for the board's own announcement of the confirmed move.
 */
async function dragAndSettle(
  page: Page,
  card: Locator,
  targetColumn: string,
  title: string,
): Promise<void> {
  await dragCardTo(page, card, targetColumn);
  await expect(page.getByTestId('board-announcer')).toContainText(
    `Moved “${title}” to ${targetColumn}.`,
  );
}

/** Drag, and wait for the refusal toast the gate produces. */
async function dragAndBeRefused(
  page: Page,
  card: Locator,
  targetColumn: string,
): Promise<Locator> {
  await dragCardTo(page, card, targetColumn);
  const toast = page.locator('[data-testid="toast"][data-tone="error"]');
  await expect(toast).toBeVisible();
  return toast;
}

const gate = (page: Page): Locator => page.getByTestId('gate-indicator');
const saved = (page: Page): Promise<void> =>
  expect(page.getByTestId('packaging-save-status')).toHaveText('Saved');

/** The `id` of whatever has the caret right now. */
async function focusedId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.id ?? null);
}

/* -------------------------------------------------------------------------- */
/* 1. Fill the three fields, move to Scripting, then clear the title           */
/* -------------------------------------------------------------------------- */

test('the gate opens when the three fields are filled, and closes again when the title is cleared', async ({
  page,
}) => {
  await signIn(page);
  await createChannel(page);

  const title = 'Three fields, then Scripting';
  await capture(page, title);

  // Idea → Packaging is not gated: the gate only applies to stages *after*
  // Packaging in CORE_KIND_ORDER.
  await dragAndSettle(page, cardIn(page, IDEA, title), PACKAGING, title);
  await expect(cardIn(page, PACKAGING, title)).toBeVisible();

  const captured = await videoTitled(title);
  expect(captured.stage_kind).toBe('packaging');

  await page.goto(`/videos/${captured.id}`);

  // ---- The block is the first thing on the page, and it says what is missing.
  const block = page.getByTestId('packaging-block');
  await expect(block).toBeVisible();
  await expect(gate(page)).toHaveAttribute('data-gate', 'thumbnail_concept');

  // The title came from capture, so the concept is what the gate stops on
  // first. The sketch sits beside the written concept, in one group, which is
  // the whole point of composing them together.
  const pair = page.getByTestId('thumbnail-pair');
  await expect(pair.getByTestId('thumbnail-concept')).toBeVisible();
  await expect(pair.getByTestId('concept-sketch-frame')).toBeVisible();

  // ---- Field 1 and 2: a working title (already set) and the written concept.
  await page.getByTestId('thumbnail-concept').fill(
    'Face left, shocked, three props on the desk, big yellow 3',
  );
  await page.getByTestId('thumbnail-concept').blur();
  await saved(page);
  await expect(gate(page)).toHaveAttribute('data-gate', 'hook');

  // ---- Field 3: three hooks, one chosen.
  for (const hook of [
    'I spent six weeks doing this wrong.',
    'Everyone told me this was the easy part.',
    'This cost me four hundred pounds to learn.',
  ]) {
    await page.getByTestId('hook-input').fill(hook);
    await page.getByTestId('hook-input').press('Enter');
  }
  await saved(page);
  await expect(page.getByTestId('hook-count-number')).toHaveText('3');
  // Nothing chosen yet, so the gate is still shut — and says which way.
  await expect(gate(page)).toHaveAttribute('data-gate', 'hook');
  await expect(gate(page)).toContainText('none is chosen yet');

  await page.getByTestId('hook-row').nth(1).getByTestId('hook-choose').click();
  await saved(page);
  await expect(gate(page)).toHaveAttribute('data-gate', 'ready');
  await expect(gate(page)).toContainText('Packaging: ready');
  await expect(page.getByTestId('gate-unsaved')).toHaveCount(0);

  // The row agrees with the indicator, which is the only reason the indicator
  // is worth anything.
  const filled = await videoById(captured.id);
  expect(filled.title).toBe(title);
  expect(filled.thumbnail_concept).toContain('big yellow 3');
  expect(filled.hooks.filter((hook) => hook.chosen)).toHaveLength(1);

  // ---- The move the whole block exists to allow.
  await page.getByTestId('stage-select').selectOption({ label: SCRIPTING });
  await expect(page.getByTestId('stage-select-status')).toContainText(
    `Moved to ${SCRIPTING}.`,
  );
  expect((await videoById(captured.id)).stage_kind).toBe('scripting');

  // ---- "Clear the title afterwards": the gate goes back to refusing, and it
  // names the field it stopped on. The video has already left Packaging, so
  // this is the case PLAN.md's review log calls out — a later-cleared field
  // has to resurface rather than being locked in behind the move.
  await page.reload();
  await page.getByTestId('working-title').fill('');
  await page.getByTestId('working-title').blur();
  await saved(page);

  await expect(gate(page)).toHaveAttribute('data-gate', 'title');
  await expect(gate(page)).toContainText('needs a working title');
  expect((await videoById(captured.id)).title).toBe('');

  // And the database says the same thing: the next move is refused for the
  // field the page is naming.
  const refusal = await page
    .getByTestId('stage-select')
    .selectOption({ label: 'Filming' })
    .then(() => page.getByTestId('stage-select-status'));
  await expect(refusal).toHaveAttribute('data-state', 'error');
  await expect(refusal).toContainText('a working title');
  expect((await videoById(captured.id)).stage_kind).toBe('scripting');
});

/* -------------------------------------------------------------------------- */
/* 2. Skip with a reason, and see the badge on the card                        */
/* -------------------------------------------------------------------------- */

test('skipping packaging with a reason puts the badge on the card and opens the gate', async ({
  page,
}) => {
  await signIn(page);
  await createChannel(page);

  const title = 'Sponsor reupload';
  await capture(page, title);
  await dragAndSettle(page, cardIn(page, IDEA, title), PACKAGING, title);
  const video = await videoTitled(title);

  await page.goto(`/videos/${video.id}`);
  await expect(gate(page)).toHaveAttribute('data-gate', 'thumbnail_concept');

  // Three deliberate acts: open the disclosure, read what it does, type why.
  await page.getByTestId('packaging-skip-open').click();

  // An empty reason is refused out loud rather than by a dead button.
  await page.getByTestId('packaging-skip-confirm').click();
  await expect(page.getByTestId('skip-notice')).toContainText('A reason is required');
  expect((await videoById(video.id)).packaging_skipped_at).toBeNull();

  const reason = 'Sponsor deadline — packaging was decided in the brief three weeks ago';
  await page.getByTestId('skip-reason-input').fill(reason);
  await page.getByTestId('packaging-skip-confirm').click();
  await saved(page);

  await expect(page.getByTestId('packaging-skipped')).toBeVisible();
  await expect(page.getByTestId('skip-reason')).toHaveText(reason);
  await expect(gate(page)).toHaveAttribute('data-gate', 'skipped');

  const skipped = await videoById(video.id);
  expect(skipped.packaging_skipped_at).not.toBeNull();
  expect(skipped.packaging_skip_reason).toBe(reason);

  // ---- The badge PLAN.md asks for, on the card, on the board.
  await openBoard(page);
  const card = cardIn(page, PACKAGING, title);
  await expect(card).toContainText('TTH skipped');

  // ---- And the gate lets it through with all three fields still empty.
  await dragAndSettle(page, card, SCRIPTING, title);
  await expect(cardIn(page, SCRIPTING, title)).toBeVisible();
  expect((await videoById(video.id)).stage_kind).toBe('scripting');
});

/* -------------------------------------------------------------------------- */
/* 3. The two links out of a refusal                                           */
/* -------------------------------------------------------------------------- */

test('a refused drop offers "Fix packaging" and "Skip gate…", and both land in the field they name', async ({
  page,
}) => {
  await signIn(page);
  await createChannel(page);

  const title = 'Refused on the way to Scripting';
  await capture(page, title);

  // Straight from Idea to Scripting: past Packaging, with nothing but a title.
  const toast = await dragAndBeRefused(page, cardIn(page, IDEA, title), SCRIPTING);
  // The refusal names the field `move_video` stopped on.
  await expect(toast).toContainText('thumbnail concept');

  const fix = toast.getByRole('link', { name: 'Fix packaging' });
  const skip = toast.getByRole('link', { name: /Skip gate/ });
  await expect(fix).toBeVisible();
  await expect(skip).toBeVisible();

  // ---- "Fix packaging": follow it, and check where the caret is.
  await fix.click();
  await page.waitForURL(/\/videos\/[0-9a-f-]+#packaging-concept$/);
  await expect(page.getByTestId('packaging-block')).toBeVisible();
  expect(
    await focusedId(page),
    'following "Fix packaging" must put the caret in the field the gate named',
  ).toBe('packaging-concept');

  // Typing lands in that field without touching anything first — no click, no
  // tab, nothing but the link and the keyboard.
  await page.keyboard.type('Two hands holding a broken part, caption: DO NOT DO THIS');
  await expect(page.getByTestId('thumbnail-concept')).toHaveValue(
    'Two hands holding a broken part, caption: DO NOT DO THIS',
  );
  await page.getByTestId('thumbnail-concept').blur();
  await saved(page);
  await expect(gate(page)).toHaveAttribute('data-gate', 'hook');

  // ---- "Skip gate…": the same refusal, the other way out.
  await openBoard(page);
  const secondToast = await dragAndBeRefused(
    page,
    cardIn(page, IDEA, title),
    SCRIPTING,
  );
  // The concept is written now, so the gate has moved on to the hook — and the
  // "Fix packaging" link moves with it.
  await expect(
    secondToast.getByRole('link', { name: 'Fix packaging' }),
  ).toHaveAttribute('href', /#packaging-hook$/);

  await secondToast.getByRole('link', { name: /Skip gate/ }).click();
  await page.waitForURL(/\/videos\/[0-9a-f-]+#packaging-skip$/);

  // The disclosure is open — a link to a closed one would do nothing visible —
  // and the caret is in the box that has to be typed in.
  await expect(page.getByTestId('packaging-skip-form')).toBeVisible();
  expect(
    await focusedId(page),
    'following "Skip gate…" must open the disclosure and focus the reason',
  ).toBe('packaging-skip');
  await expect(page.getByTestId('skip-reason-input')).toBeFocused();

  // It is still a deliberate act: the reason is typed, and it is still refused
  // when it is blank.
  await page.keyboard.type('Reupload of a video whose packaging already shipped');
  await page.getByTestId('packaging-skip-confirm').click();
  await saved(page);
  await expect(page.getByTestId('packaging-skipped')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* 4. One page, one save path                                                  */
/* -------------------------------------------------------------------------- */

test('the packaging block and the flow fields are one page saving through one action', async ({
  page,
}) => {
  await signIn(page);
  await createChannel(page);

  const title = 'Composed detail page';
  await capture(page, title);
  const video = await videoTitled(title);
  await page.goto(`/videos/${video.id}`);

  // The gate is first on the page and the flow fields follow it: BRIEF.md's
  // principle 1 is an order of operations, and the page is that order.
  const blockBox = await page.getByTestId('packaging-block').boundingBox();
  const flowBox = await page.getByTestId('flow-fields').boundingBox();
  expect(blockBox).not.toBeNull();
  expect(flowBox).not.toBeNull();
  expect(blockBox!.y).toBeLessThan(flowBox!.y);

  // There is exactly one working-title input on the page. M1's stub bound a
  // second one to the same column; two inputs over one column is a race.
  await expect(page.getByLabel('Working title')).toHaveCount(1);

  // A packaging save and a flow save, one after the other, both landing.
  await page.getByTestId('working-title').fill('Composed, and renamed');
  await page.getByTestId('working-title').blur();
  await saved(page);

  await page.getByTestId('waiting-on').fill('the thumbnail photographer');
  await page.getByTestId('waiting-on').blur();
  await expect(page.getByTestId('waiting-on-status')).toHaveText('Saved');

  const after = await videoById(video.id);
  expect(after.title).toBe('Composed, and renamed');

  const waiting = await db.query<{ waiting_on: string; waiting_since: string | null }>(
    'select waiting_on, waiting_since from public.videos where id = $1',
    [video.id],
  );
  expect(waiting.rows[0].waiting_on).toBe('the thumbnail photographer');
  expect(waiting.rows[0].waiting_since).not.toBeNull();
});
