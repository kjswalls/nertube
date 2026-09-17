import { Client } from 'pg';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/**
 * Quick capture, end to end.
 *
 * Everything here drives the real application against the real dev stack: the
 * real `c` binding, the real modal, the real `captureVideo` server action and
 * the real `capture_video` RPC with RLS on. The assertions that matter are made
 * twice over — once in the browser (what the person sees) and once in Postgres
 * (what was actually written), because "the modal closed" is not evidence that
 * an idea exists and "a row exists" is not evidence anyone could tell.
 *
 * `npm run e2e` starts both servers; see playwright.config.ts.
 */

/* -------------------------------------------------------------------------- */
/* The database, read directly                                                 */
/* -------------------------------------------------------------------------- */

interface CapturedRow {
  id: string;
  title: string;
  one_line_hook: string | null;
  notes: string | null;
  tags: string[];
  stage_kind: string | null;
  channel_slug: string;
}

async function withDb<T>(run: (client: Client) => Promise<T>): Promise<T> {
  // The same database the stack serves (`NERTUBE_DEV_DB`). Read-only here, and
  // as `postgres` — this is the harness checking the app's work, not the app.
  const client = new Client({ ...PG });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Every video with this exact title, with the stage and channel it landed in. */
function rowsTitled(title: string): Promise<CapturedRow[]> {
  return withDb(async (client) => {
    const result = await client.query<CapturedRow>(
      `select v.id, v.title, v.one_line_hook, v.notes, v.tags,
              s.kind as stage_kind, c.slug as channel_slug
         from public.videos v
         join public.stages   s on s.id = v.stage_id
         join public.channels c on c.id = v.channel_id
        where v.title = $1`,
      [title],
    );
    return result.rows;
  });
}

/** How many videos exist at all — the "nothing was written" assertion. */
function videoCount(): Promise<number> {
  return withDb(async (client) => {
    const result = await client.query<{ count: string }>(
      'select count(*)::text as count from public.videos',
    );
    return Number(result.rows[0].count);
  });
}

/* -------------------------------------------------------------------------- */
/* The app                                                                     */
/* -------------------------------------------------------------------------- */

/** Unique per run, so a reused stack never makes one spec see another's row. */
function uniqueTitle(label: string): string {
  return `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/c\/[^/]+\/board$/);
}

function modal(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Capture an idea' });
}

function titleField(scope: Page | Locator): Locator {
  return scope.getByLabel('Idea', { exact: true });
}

/**
 * Open the capture modal the way a person does, and wait for the cursor.
 *
 * The wait first: the `c` binding is attached by an effect, so a press that
 * lands on server-rendered HTML does nothing at all. The header's capture
 * button carries `data-shortcut-ready` once the binding is live — the app
 * saying so, rather than this file guessing with a sleep.
 */
async function openModal(page: Page): Promise<Locator> {
  await expect(
    page.locator('button[aria-keyshortcuts="c"][data-shortcut-ready="true"]'),
  ).toBeVisible();

  await page.keyboard.press('c');
  const dialog = modal(page);
  await expect(dialog).toBeVisible();
  await expect(titleField(dialog)).toBeFocused();
  return dialog;
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

/* -------------------------------------------------------------------------- */
/* Specs                                                                       */
/* -------------------------------------------------------------------------- */

test('`c` opens the capture modal from the board, and Enter saves the idea', async ({
  page,
}) => {
  const title = uniqueTitle('Capture from the board');

  // Nothing focused but the document: `c` is a global binding, not a control.
  const dialog = await openModal(page);

  // It is a modal dialog, and it says what it is.
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(
    dialog.getByRole('heading', { name: 'Capture an idea' }),
  ).toBeVisible();
  // One field on the fast path: the disclosure's three are not rendered at all.
  await expect(dialog.getByLabel('One-line hook')).toHaveCount(0);
  await expect(dialog.getByLabel('Notes')).toHaveCount(0);

  await page.keyboard.type(title);
  await page.keyboard.press('Enter');

  // Enter saves *and closes*.
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(`Captured “${title}” in Personal.`)).toBeVisible();

  // And it is really there, in the Idea stage of the channel the board is about.
  const rows = await rowsTitled(title);
  expect(rows).toHaveLength(1);
  expect(rows[0].stage_kind).toBe('idea');
  expect(rows[0].channel_slug).toBe('personal');
});

test('the captured idea shows up on the board without a manual reload', async ({
  page,
}) => {
  const cards = page.locator('[data-testid="board-card"]');
  const before = await cards.count();

  // The board renders no cards at all until the M1 board task lands them; there
  // is then nothing for a new one to appear among, and this assertion would be
  // about the wrong thing. The capture itself is covered by the spec above.
  test.skip(
    before === 0,
    'the board renders no cards yet, so "it appears" has nothing to observe',
  );

  const title = uniqueTitle('Appears without a reload');
  await openModal(page);
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');

  // No page.reload() anywhere: the server action revalidated the board and the
  // form asked the router to re-render it.
  await expect(cards.filter({ hasText: title })).toHaveCount(1);
  expect(await cards.count()).toBe(before + 1);
});

test('`c` typed inside a text field types a "c" instead of opening a second modal', async ({
  page,
}) => {
  const dialog = await openModal(page);

  await page.keyboard.type('chalk');
  await page.keyboard.press('c');

  await expect(modal(page)).toHaveCount(1);
  await expect(titleField(dialog)).toHaveValue('chalkc');

  // The same has to be true of a textarea, which is what the disclosure adds.
  await page.keyboard.press('Shift+Enter');
  const notes = dialog.getByLabel('Notes');
  await expect(notes).toBeVisible();
  await notes.click();
  await page.keyboard.type('cc');
  await expect(modal(page)).toHaveCount(1);
  await expect(notes).toHaveValue('cc');
});

test('Escape closes the modal without saving, and gives focus back', async ({
  page,
}) => {
  const title = uniqueTitle('Escaped, never saved');
  const before = await videoCount();

  // Open it from a control, so there is something specific to return focus to.
  const signOut = page.getByRole('button', { name: 'Sign out' });
  await signOut.focus();

  const dialog = await openModal(page);
  await page.keyboard.type(title);
  await page.keyboard.press('Escape');

  await expect(dialog).toHaveCount(0);
  await expect(signOut).toBeFocused();

  expect(await rowsTitled(title)).toHaveLength(0);
  expect(await videoCount()).toBe(before);

  // And the typing is gone: `c` opens a fresh capture, not the last one.
  const reopened = await openModal(page);
  await expect(titleField(reopened)).toHaveValue('');
});

test('focus is trapped in the modal while it is open', async ({ page }) => {
  const dialog = await openModal(page);
  await expect(dialog.getByRole('button', { name: 'More' })).toBeVisible();

  // Round the tab order twice; focus never leaves the dialog.
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() =>
      Boolean(document.activeElement?.closest('[role="dialog"]')),
    );
    expect(inside, `focus left the dialog after ${press + 1} Tab presses`).toBe(
      true,
    );
  }

  // Backwards too.
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press('Shift+Tab');
    const inside = await page.evaluate(() =>
      Boolean(document.activeElement?.closest('[role="dialog"]')),
    );
    expect(
      inside,
      `focus left the dialog after ${press + 1} Shift+Tab presses`,
    ).toBe(true);
  }
});

test('an empty or whitespace-only title is refused, and writes nothing', async ({
  page,
}) => {
  const before = await videoCount();

  // "Before the round trip" is a claim about the network, so watch it: a server
  // action is a POST to the current URL, and a refused capture must not make
  // one.
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(request.url());
  });

  const dialog = await openModal(page);

  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveText(/give the idea a title/i);

  // Whitespace is not a title either — and `required` alone cannot see that.
  await titleField(dialog).fill('     ');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveText(/give the idea a title/i);

  // The refusal is client-side, so nothing was written and nothing was sent.
  expect(posts, 'a refused capture should never reach the server').toEqual([]);
  expect(await videoCount()).toBe(before);

  // The field still works: typing a title clears the error and saves.
  const title = uniqueTitle('Refused, then accepted');
  await titleField(dialog).fill(title);
  await page.keyboard.press('Enter');
  await expect(modal(page)).toHaveCount(0);
  expect(await rowsTitled(title)).toHaveLength(1);
});

test('1–9 retargets the channel before Enter, and is plain text afterwards', async ({
  page,
}) => {
  const title = uniqueTitle('Retargeted with 2');
  const dialog = await openModal(page);

  // The board is Personal's, so that is what the capture is aimed at.
  await expect(dialog.getByRole('radio', { name: 'Personal' })).toBeChecked();

  await page.keyboard.press('2');
  await expect(
    dialog.getByRole('radio', { name: 'Sunday Softworks' }),
  ).toBeChecked();
  await expect(titleField(dialog)).toHaveValue('');

  // Once there is a title, a digit is part of it.
  await page.keyboard.type('Retargeted with ');
  await page.keyboard.press('1');
  await expect(titleField(dialog)).toHaveValue('Retargeted with 1');
  await expect(
    dialog.getByRole('radio', { name: 'Sunday Softworks' }),
  ).toBeChecked();

  await titleField(dialog).fill(title);
  await page.keyboard.press('Enter');
  await expect(modal(page)).toHaveCount(0);

  const rows = await rowsTitled(title);
  expect(rows).toHaveLength(1);
  expect(rows[0].channel_slug).toBe('sunday-softworks');
  expect(rows[0].stage_kind).toBe('idea');
});

test('Shift+Enter opens the disclosure, and its fields are saved too', async ({
  page,
}) => {
  const title = uniqueTitle('With a hook and notes');
  const dialog = await openModal(page);

  await page.keyboard.type(title);
  // Shift+Enter must not submit the form, which is what Enter in a single-line
  // input normally does whether Shift is held or not.
  await page.keyboard.press('Shift+Enter');

  const hook = dialog.getByLabel('One-line hook');
  await expect(hook).toBeFocused();
  await expect(titleField(dialog)).toHaveValue(title);

  await hook.fill('The one line that makes you click');
  await dialog.getByLabel('Notes').fill('Two shots, one afternoon.');
  await dialog.getByLabel('Tags').fill('desk, workflow, desk');

  await hook.press('Enter');
  await expect(modal(page)).toHaveCount(0);

  const rows = await rowsTitled(title);
  expect(rows).toHaveLength(1);
  expect(rows[0].one_line_hook).toBe('The one line that makes you click');
  expect(rows[0].notes).toBe('Two shots, one afternoon.');
  // Trimmed, de-duplicated, in the order they were typed.
  expect(rows[0].tags).toEqual(['desk', 'workflow']);
});

test('/capture is the same form as a standalone, phone-sized page', async ({
  page,
}) => {
  // A phone, because that is what this route is for.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/capture');

  const field = titleField(page);
  await expect(field).toBeFocused();
  // No modal involved: this is the page itself.
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Nothing needs a mouse and nothing needs a sideways scroll.
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflows, 'the capture page should not scroll sideways on a phone').toBe(
    false,
  );
  const button = page.getByRole('button', { name: 'Capture' });
  const box = await button.boundingBox();
  expect(box?.height ?? 0, 'the save button should be a real tap target').toBeGreaterThanOrEqual(
    44,
  );

  const title = uniqueTitle('Captured from the page');
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');

  await expect(page.getByText(`Captured “${title}” in Personal.`)).toBeVisible();
  // Ready for the next one: cleared, still focused, still on /capture.
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();
  await expect(page).toHaveURL(/\/capture$/);

  const rows = await rowsTitled(title);
  expect(rows).toHaveLength(1);
  expect(rows[0].stage_kind).toBe('idea');
  expect(rows[0].channel_slug).toBe('personal');

  // `?c=<slug>` is the per-channel bookmark.
  await page.goto('/capture?c=sunday-softworks');
  await expect(
    page.getByRole('radio', { name: 'Sunday Softworks' }),
  ).toBeChecked();
});
