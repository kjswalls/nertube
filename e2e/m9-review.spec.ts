import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/**
 * The M9 review's findings, pinned.
 *
 * The last milestone's adversarial review measured and probed its way to a
 * list: settings fields one glyph wide at 390, channel links that could not
 * be clicked on a short window, focus that fell to <body> from a backdrop, a
 * sheet, a panel and a toast, an Escape that saved the edit it claimed to
 * throw away, a `p` that promoted the wrong idea, a stage select that moved a
 * video on one arrow key. Each fix is in the file the finding named; this is
 * where each is proved, so none of them can quietly come back.
 *
 * Every assertion is about the outcome — where focus is, what the database
 * holds, how wide a field is — never about an intermediate flicker.
 */

const CHANNEL = { name: 'M9 Review', slug: 'm9-review' };

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

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}

/** The shell has hydrated: the application's own keys are bound. */
async function keysReady(page: Page): Promise<void> {
  await expect(
    page.locator('button[aria-keyshortcuts="c"][data-shortcut-ready="true"]'),
  ).toBeAttached();
}

async function channelRow(): Promise<{ id: string; user_id: string } | null> {
  const result = await db.query<{ id: string; user_id: string }>(
    'select id, user_id from public.channels where slug = $1',
    [CHANNEL.slug],
  );
  return result.rows[0] ?? null;
}

/** This file's own channel, made through the app the first time it is needed. */
async function ensureChannel(page: Page): Promise<{ id: string; user_id: string }> {
  const existing = await channelRow();
  if (existing) return existing;
  await page.goto('/c/new');
  await page.getByLabel('Channel name').fill(CHANNEL.name);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.waitForURL(`**/c/${CHANNEL.slug}/board`);
  return (await channelRow())!;
}

async function clearChannel(): Promise<void> {
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug = $1)`,
    [CHANNEL.slug],
  );
}

async function seedVideo(
  channel: { id: string; user_id: string },
  title: string,
  kind: 'idea' | 'packaging' | 'editing',
  age: string,
  packaged = true,
): Promise<string> {
  const stage = await db.query<{ id: string }>(
    'select id from public.stages where channel_id = $1 and kind = $2',
    [channel.id, kind],
  );
  const inserted = await db.query<{ id: string }>(
    `insert into public.videos (user_id, channel_id, stage_id, stage_entered_at,
                                title, thumbnail_concept, hooks)
     values ($1, $2, $3, now() - $4::interval, $5, $6, $7::jsonb)
     returning id`,
    [
      channel.user_id,
      channel.id,
      stage.rows[0].id,
      age,
      title,
      packaged && kind !== 'idea' ? 'A hand on a keyboard' : null,
      packaged && kind !== 'idea'
        ? JSON.stringify([{ id: 'h1', text: 'The hook, as spoken', chosen: true }])
        : '[]',
    ],
  );
  return inserted.rows[0].id;
}

async function stageKind(videoId: string): Promise<string> {
  const result = await db.query<{ kind: string }>(
    `select s.kind from public.videos v join public.stages s on s.id = v.stage_id
      where v.id = $1`,
    [videoId],
  );
  return result.rows[0].kind;
}

async function activeElement(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return 'none';
    return `${el.tagName}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}`;
  });
}

async function widthOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('The element has no box: it is not rendered.');
  return box.width;
}

/* -------------------------------------------------------------------------- */
/* 1. Phone: the settings rows keep their fields readable                      */
/* -------------------------------------------------------------------------- */

for (const width of [390, 360]) {
  test(`at ${width}px the bucket and checklist fields are wide enough to read, in 16px type`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);

    // Buckets: every rename field, and the add field. They were 47px (390)
    // and 17px (360) wide beside the quota, the arrows and Remove.
    await page.goto('/settings/buckets/sunday-softworks');
    const names = page.getByTestId('bucket-name');
    await expect(names.first()).toBeVisible();
    for (const field of (await names.all()).slice(0, 8)) {
      expect(await widthOf(field)).toBeGreaterThanOrEqual(200);
    }
    for (const field of await page.getByTestId('add-bucket-name').all()) {
      expect(await widthOf(field)).toBeGreaterThanOrEqual(200);
      // Under 16px, iOS Safari zooms the page when the field is tapped.
      expect(await field.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
    }
    const quota = page.getByTestId('bucket-quota').first();
    expect(await quota.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');

    // Checklists: each item's text, and the add field.
    await page.goto('/settings/checklists/sunday-softworks');
    const texts = page.getByTestId('template-text');
    await expect(texts.first()).toBeVisible();
    for (const field of (await texts.all()).slice(0, 8)) {
      expect(await widthOf(field)).toBeGreaterThanOrEqual(200);
    }
    expect(await texts.first().evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
    expect(await widthOf(page.getByTestId('template-add-text').first())).toBeGreaterThanOrEqual(
      200,
    );

    // And none of it pushes the page sideways.
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(sideways).toBe(false);
  });
}

/* -------------------------------------------------------------------------- */
/* 2. A short window: every channel link in the sidebar can be clicked         */
/* -------------------------------------------------------------------------- */

for (const size of [
  { width: 844, height: 390 },
  { width: 1280, height: 560 },
]) {
  test(`at ${size.width}×${size.height} every channel link in the sidebar can be clicked`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await signIn(page);

    const targets: [RegExp | string, string][] = [
      ['Personal', '**/c/personal/board'],
      ['Sunday Softworks', '**/c/sunday-softworks/board'],
      ['+ New channel', '**/c/new'],
    ];
    for (const [name, url] of targets) {
      await page.goto('/now');
      await keysReady(page);
      // A real click: Playwright scrolls the link into view in its scroller
      // and refuses to click if something else is drawn on top of it — which
      // is exactly what the keyboard hints and the theme control were, over a
      // channel list shrunk to 0px (M9 review).
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name, exact: true })
        .click({ timeout: 5_000 });
      await page.waitForURL(url);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* 3. Focus comes back from a dialog's backdrop and from the `?` sheet         */
/* -------------------------------------------------------------------------- */

test('a click on a dialog backdrop gives focus back to the control that opened it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await keysReady(page);

  const capture = page.locator('button[aria-keyshortcuts="c"]');
  await capture.click();
  const dialog = page.getByRole('dialog', { name: 'Capture an idea' });
  await expect(dialog).toBeVisible();
  await page.mouse.click(1420, 880);
  await expect(dialog).toHaveCount(0);
  await expect(capture).toBeFocused();
});

test('the sheet opened from the hint bar gives focus back to its button, and reads "or" between keys', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await ensureChannel(page);
  await page.goto(`/c/${CHANNEL.slug}/board`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
  await keysReady(page);

  const open = page.getByTestId('shortcut-sheet-open');
  await open.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  // The bar — and so the button that opened the sheet — stays mounted under
  // the sheet. It used to empty itself while any dialog was open, which
  // unmounted the opener and sent focus to <body> on close (M9 review).
  await expect(page.getByTestId('shortcut-hints')).toHaveCount(1);
  await expect(open).toHaveCount(1);

  // "j / k" is either key: a screen reader hears "or", not "j k".
  const row = sheet.locator('[data-testid="shortcut-row"][data-keys="j / k"]');
  expect(await row.textContent()).toContain(' or ');

  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(open).toBeFocused();
});

/* -------------------------------------------------------------------------- */
/* 4. Escape in a checklist template's text reverts and saves nothing          */
/* -------------------------------------------------------------------------- */

test('Escape in a template item puts its text back, keeps focus there, and saves nothing', async ({
  page,
}) => {
  await signIn(page);
  await page.goto('/settings/checklists/personal');
  await keysReady(page);

  const field = page.getByTestId('template-text').first();
  const row = page.getByTestId('template-row').first();
  const id = (await row.getAttribute('data-template-id'))!;
  const original = await field.inputValue();

  await field.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' EDITED');
  await expect(field).toHaveValue(`${original} EDITED`);
  await page.keyboard.press('Escape');

  await expect(field).toHaveValue(original);
  await expect(field).toBeFocused();

  // Leaving the field afterwards saves nothing either: the draft is the
  // stored text again.
  await page.keyboard.press('Tab');
  await page.waitForTimeout(1_500);
  const stored = await db.query<{ text: string }>(
    'select text from public.checklist_templates where id = $1',
    [id],
  );
  expect(stored.rows[0].text).toBe(original);
});

/* -------------------------------------------------------------------------- */
/* 5. Keys that act on "the selected one" act on the one with focus            */
/* -------------------------------------------------------------------------- */

test('in the bank, focus anywhere in a row selects it, so `p` promotes the row the focus is on', async ({
  page,
}) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  await clearChannel();
  const first = await seedVideo(channel, 'Review bank — first', 'idea', '3 days');
  const second = await seedVideo(channel, 'Review bank — second', 'idea', '2 days');
  const third = await seedVideo(channel, 'Review bank — third', 'idea', '1 day');

  await page.goto(`/c/${CHANNEL.slug}/ideas`);
  await expect(page.getByTestId('idea-bank')).toHaveAttribute('data-ready', 'true');
  await keysReady(page);

  await page.keyboard.press('j');
  await page.keyboard.press('j');
  const selected = page.locator('[data-testid="idea-row"][data-selected="true"]');
  const selectedBefore = await selected.getAttribute('data-video-id');

  // Back one tab stop: onto the previous row's Archive button.
  await page.keyboard.press('Shift+Tab');
  const focusedRow = await page.evaluate(
    () =>
      document.activeElement?.closest('[data-testid="idea-row"]')?.getAttribute('data-video-id') ??
      null,
  );
  expect(focusedRow).not.toBeNull();
  expect(focusedRow).not.toBe(selectedBefore);
  await expect(selected).toHaveAttribute('data-video-id', focusedRow!);

  await page.keyboard.press('p');
  await expect.poll(() => stageKind(focusedRow!)).toBe('packaging');
  await expect.poll(() => stageKind(selectedBefore!)).toBe('idea');

  // The promoted row leaves the list; focus and the selection move to its
  // neighbour rather than falling to <body>.
  await expect(
    page.locator(`[data-testid="idea-row"][data-video-id="${focusedRow}"]`),
  ).toHaveCount(0);
  await expect.poll(() => activeElement(page)).not.toBe('BODY');
  const remaining = [first, second, third].filter((id) => id !== focusedRow);
  expect(remaining).toContain(await selected.getAttribute('data-video-id'));
});

test('on the board, `p` promotes the selected idea to Packaging', async ({ page }) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  await clearChannel();
  const idea = await seedVideo(channel, 'Review board — an idea', 'idea', '1 day');

  await page.goto(`/c/${CHANNEL.slug}/board`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
  await keysReady(page);

  await page.keyboard.press('j');
  await expect(
    page.locator('[data-testid="board-card"][data-selected="true"]'),
  ).toContainText('Review board — an idea');
  await page.keyboard.press('p');
  await expect.poll(() => stageKind(idea)).toBe('packaging');
});

/* -------------------------------------------------------------------------- */
/* 6. The stage select: an arrow key chooses, Enter moves                      */
/* -------------------------------------------------------------------------- */

test('an arrow key on the stage select only chooses; Escape puts it back and Enter moves', async ({
  page,
}) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  await clearChannel();
  const video = await seedVideo(channel, 'Review select — editing', 'editing', '2 days');

  await page.goto(`/videos/${video}?section=schedule`);
  await keysReady(page);
  const select = page.getByTestId('stage-select');
  const status = page.getByTestId('stage-select-status');
  await select.focus();

  await page.keyboard.press('ArrowUp');
  await expect(status).toHaveAttribute('data-state', 'chosen');
  await expect(page.getByTestId('stage-select-move')).toBeVisible();
  await expect(select).toBeFocused();
  // Nothing moved.
  await page.waitForTimeout(1_000);
  expect(await stageKind(video)).toBe('editing');

  // Escape: the choice goes, the select shows where the video is.
  await page.keyboard.press('Escape');
  await expect(status).not.toHaveAttribute('data-state', 'chosen');
  await expect(page.getByTestId('stage-select-move')).toHaveCount(0);
  expect(await stageKind(video)).toBe('editing');

  // ArrowUp again, then Enter: now it moves, and focus stays on the select.
  await page.keyboard.press('ArrowUp');
  await expect(status).toHaveAttribute('data-state', 'chosen');
  await page.keyboard.press('Enter');
  await expect(status).toHaveAttribute('data-state', 'moved');
  await expect.poll(() => stageKind(video)).toBe('filming');
  await expect(select).toBeFocused();
});

/* -------------------------------------------------------------------------- */
/* 7. An assist panel closed with Escape gives focus back to its pill          */
/* -------------------------------------------------------------------------- */

test('closing an assist panel with Escape gives focus back to the pill that opened it', async ({
  page,
}) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  await clearChannel();
  const video = await seedVideo(channel, 'Review panel — packaging', 'packaging', '1 day', false);

  await page.goto(`/videos/${video}`);
  await keysReady(page);
  const pill = page.locator('[data-testid="assist-pill"][data-assist="Generate 20"]');
  const panel = page.getByTestId('brainstorm-panel');
  await pill.click();
  await expect(panel).toBeVisible();
  // The panel takes focus as it opens; Escape from inside it closes it.
  await expect.poll(() => panel.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(pill).toBeFocused();
});

/* -------------------------------------------------------------------------- */
/* 8. A refused `]` puts focus on the toast's first link, and it waits         */
/* -------------------------------------------------------------------------- */

test('a refused `]` puts focus on "Fix packaging", the toast waits while it has focus, and Escape goes back to the card', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await signIn(page);
  const channel = await ensureChannel(page);
  await clearChannel();
  // Packaging with nothing filled in: the gate refuses `]`.
  await seedVideo(channel, 'Review toast — unpackaged', 'packaging', '1 day', false);

  await page.goto(`/c/${CHANNEL.slug}/board`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
  await keysReady(page);
  await page.keyboard.press('j');
  const card = page.locator('[data-testid="board-card"][data-selected="true"]');
  await expect(card).toContainText('Review toast — unpackaged');
  await page.keyboard.press(']');

  const toast = page.getByTestId('toast').filter({ hasText: 'Review toast — unpackaged' });
  await expect(toast).toBeVisible();
  // Every missing field is named, not only the first.
  await expect(toast).toContainText('a thumbnail concept written down');
  await expect(toast).toContainText('exactly one chosen hook');
  const fix = toast.getByRole('link', { name: 'Fix packaging' });
  await expect(fix).toBeFocused();

  // Past the error tone's 12 seconds: still there, still focused.
  await page.waitForTimeout(13_000);
  await expect(toast).toBeVisible();
  await expect(fix).toBeFocused();

  // Escape dismisses it, and focus goes back to the card.
  await page.keyboard.press('Escape');
  await expect(toast).toHaveCount(0);
  await expect(card).toBeFocused();
});

/* -------------------------------------------------------------------------- */
/* 9. Titles name the page's own thing                                         */
/* -------------------------------------------------------------------------- */

test('a video page is titled with its video, and a channel page with its channel', async ({
  page,
}) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  await clearChannel();
  const video = await seedVideo(channel, 'Review title — a named video', 'idea', '1 day');

  await page.goto(`/videos/${video}`);
  await expect(page).toHaveTitle('Review title — a named video · NerTube');
  await page.goto(`/c/${CHANNEL.slug}/board`);
  await expect(page).toHaveTitle(`${CHANNEL.name} · board · NerTube`);
  await page.goto(`/c/${CHANNEL.slug}/ideas`);
  await expect(page).toHaveTitle(`${CHANNEL.name} · ideas · NerTube`);
});

/* -------------------------------------------------------------------------- */
/* 10. Forced colors: the capture chips, the current row, the pressed chips    */
/* -------------------------------------------------------------------------- */

test('under forced colors the chosen and focused capture chip, the current sidebar row and a pressed chip are all marked', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ forcedColors: 'active' });
  await signIn(page);
  await keysReady(page);

  // The sidebar's current-row marker keeps a system colour instead of being
  // repainted to the page's own ground.
  const marker = page
    .getByRole('navigation', { name: 'Main' })
    .locator('[aria-current="page"] [data-current-marker]');
  await expect(marker).toHaveCount(1);
  expect(await marker.evaluate((el) => getComputedStyle(el).forcedColorAdjust)).toBe('none');

  // A pressed filter chip on /now carries an outline.
  const chip = page.locator('[aria-pressed="true"]').first();
  if ((await chip.count()) > 0) {
    expect(await chip.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  }

  // The capture box: Tab from the title onto the channel radio. The focus is
  // drawn on the chip, not on the 1×1 clipped input.
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'Capture an idea' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Tab');
  const focusedChip = dialog.locator('[data-chip]:has(> input:focus-visible)');
  await expect(focusedChip).toHaveCount(1);
  expect(await focusedChip.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  // The chosen chip is outlined even without focus.
  await page.keyboard.press('Shift+Tab');
  const chosen = dialog.locator('[data-chip]:has(> input:checked)');
  expect(await chosen.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
});
