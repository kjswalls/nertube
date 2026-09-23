import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/**
 * The keyboard, as one designed set (M9).
 *
 * Four claims, each proved in a browser against the real registry
 * (`lib/shortcuts.ts`) — nothing here is a unit test of it:
 *
 * 1. **Every advertised shortcut works on the route it claims.** "Advertised"
 *    is read off the `?` sheet itself, not off a list in this file: each
 *    route's sheet is compared with the table below, and then every key in
 *    that table is pressed on that route and its effect is checked — in the
 *    database where it writes, in the URL where it navigates.
 * 2. **None fires while typing** — in every text-entry input type, a textarea,
 *   a select, a contenteditable and a `role="textbox"`, and in the real fields
 *    where it matters most: the capture box, the bank's search, a settings
 *    form, and the working title beside an open assist panel.
 * 3. **The sheet** opens with `?`, keeps Tab inside itself, follows a link on
 *    Enter, and closes with Escape or `?`, giving focus back.
 * 4. **Escape closes one thing at a time, newest first**, with two layers open.
 *
 * The fixture is SQL (a channel of its own, rebuilt per test); every action is
 * a key.
 */

const CHANNEL = { name: 'Keys', slug: 'keys' };

const IDEAS = ['Keys — the first idea', 'Keys — the second idea'];
const PACKAGING = ['Keys — packaged one', 'Keys — packaged two'];

/* -------------------------------------------------------------------------- */
/* What each route's sheet must say                                            */
/* -------------------------------------------------------------------------- */

const GET_AROUND = ['g n', 'g b', 'g i', 'g c', 'g s', '1–9'];
// `c`, then the keys that work inside the box it opens.
const CAPTURE = ['c', 'Enter', 'Shift+Enter', 'Alt+1–9', 'Escape'];
const CLOSING = ['Escape'];

type Sheet = Record<string, string[]>;

const EVERYWHERE: Sheet = {
  'Get around': GET_AROUND,
  Capture: CAPTURE,
  'Closing things': CLOSING,
};

const SHEETS: Record<'board' | 'now' | 'ideas' | 'plain', Sheet> = {
  board: {
    ...EVERYWHERE,
    'On the board': ['j / k', '[ / ]', 'p', 'Enter', 'Escape'],
  },
  now: {
    ...EVERYWHERE,
    'On Now': ['j / k', 'x', 'Enter', 'Escape'],
  },
  ideas: {
    ...EVERYWHERE,
    'In the idea bank': ['/', 'j / k', 'p', 'Enter', 'Escape'],
  },
  // The calendar, a video, settings: the application's keys and nothing more.
  plain: EVERYWHERE,
};

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

async function channelRow(): Promise<{ id: string; user_id: string } | null> {
  const result = await db.query<{ id: string; user_id: string }>(
    'select id, user_id from public.channels where slug = $1',
    [CHANNEL.slug],
  );
  return result.rows[0] ?? null;
}

async function seedVideo(
  channel: { id: string; user_id: string },
  title: string,
  kind: 'idea' | 'packaging',
  age: string,
): Promise<string> {
  const stage = await db.query<{ id: string }>(
    'select id from public.stages where channel_id = $1 and kind = $2',
    [channel.id, kind],
  );
  const stageId = stage.rows[0].id;
  const packaged = kind === 'packaging';
  const inserted = await db.query<{ id: string }>(
    `insert into public.videos (user_id, channel_id, stage_id, stage_entered_at,
                                title, thumbnail_concept, hooks)
     values ($1, $2, $3, now() - $4::interval, $5, $6, $7::jsonb)
     returning id`,
    [
      channel.user_id,
      channel.id,
      stageId,
      age,
      title,
      packaged ? 'A hand on a keyboard, mid-shortcut' : null,
      packaged
        ? JSON.stringify([{ id: 'h1', text: 'The hook, as spoken', chosen: true }])
        : '[]',
    ],
  );
  const id = inserted.rows[0].id;
  if (packaged) {
    // The checklist `move_video` would have copied in, all unticked, so `/now`
    // has a box for `x` to tick.
    await db.query(
      `insert into public.checklist_items (user_id, video_id, channel_id, stage_id, text, position, est_minutes)
       select $1, $2, $3, $4, t.text, t.position, t.est_minutes
         from public.checklist_templates t
        where t.stage_id = $4`,
      [channel.user_id, id, channel.id, stageId],
    );
  }
  return id;
}

let ids: Record<string, string> = {};

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}

test.beforeEach(async ({ page }) => {
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug = $1)`,
    [CHANNEL.slug],
  );

  await signIn(page);
  if ((await channelRow()) === null) {
    await page.goto('/c/new');
    await page.getByLabel('Channel name').fill(CHANNEL.name);
    await page.getByRole('button', { name: 'Create channel' }).click();
    await page.waitForURL(`**/c/${CHANNEL.slug}/board`);
  }

  const channel = (await channelRow())!;
  ids = {};
  // Ages set so every list sorts the same way every run: oldest first.
  ids[IDEAS[0]] = await seedVideo(channel, IDEAS[0], 'idea', '3 days');
  ids[IDEAS[1]] = await seedVideo(channel, IDEAS[1], 'idea', '2 days');
  ids[PACKAGING[0]] = await seedVideo(channel, PACKAGING[0], 'packaging', '9 days');
  ids[PACKAGING[1]] = await seedVideo(channel, PACKAGING[1], 'packaging', '8 days');
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** The page has hydrated enough for the application's own keys to be bound. */
async function keysReady(page: Page): Promise<void> {
  await expect(
    page.locator('button[aria-keyshortcuts="c"][data-shortcut-ready="true"]'),
  ).toBeVisible();
}

async function openBoard(page: Page): Promise<void> {
  await page.goto(`/c/${CHANNEL.slug}/board`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
  await keysReady(page);
}

async function openIdeas(page: Page): Promise<void> {
  await page.goto(`/c/${CHANNEL.slug}/ideas`);
  await expect(page.getByTestId('idea-bank')).toHaveAttribute('data-ready', 'true');
  await keysReady(page);
}

async function openNow(page: Page): Promise<void> {
  await page.goto('/now');
  await expect(page.getByTestId('now')).toHaveAttribute('data-ready', 'true');
  await keysReady(page);
  const chip = page.getByTestId('channel-chip').filter({ hasText: CHANNEL.name });
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
}

const sheet = (page: Page): Locator => page.getByRole('dialog', { name: 'Keyboard shortcuts' });

async function openSheet(page: Page): Promise<Locator> {
  await page.keyboard.press('?');
  await expect(sheet(page)).toBeVisible();
  return sheet(page);
}

/** The sheet as it reads: group title → the keys listed under it, in order. */
async function readSheet(dialog: Locator): Promise<Sheet> {
  const out: Sheet = {};
  for (const group of await dialog.getByTestId('shortcut-group').all()) {
    // `textContent`, not `innerText`: the heading is uppercased by CSS.
    const title = ((await group.getByRole('heading').textContent()) ?? '').trim();
    const keys: string[] = [];
    for (const row of await group.getByTestId('shortcut-row').all()) {
      keys.push((await row.getAttribute('data-keys'))!);
    }
    out[title] = keys;
  }
  return out;
}

async function expectSheet(page: Page, expected: Sheet): Promise<void> {
  const dialog = await openSheet(page);
  expect(await readSheet(dialog)).toEqual(expected);
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
}

async function stageKind(videoId: string): Promise<string> {
  const result = await db.query<{ kind: string }>(
    `select s.kind from public.videos v join public.stages s on s.id = v.stage_id
      where v.id = $1`,
    [videoId],
  );
  return result.rows[0].kind;
}

async function checkedCount(videoId: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `select count(*)::int as n from public.checklist_items
      where video_id = $1 and checked_at is not null`,
    [videoId],
  );
  return result.rows[0].n;
}

const selectedCard = (page: Page) =>
  page.locator('[data-testid="board-card"][data-selected="true"]');
const selectedRow = (page: Page) =>
  page.locator('[data-testid="now-row"][data-selected="true"]');
const selectedIdea = (page: Page) =>
  page.locator('[data-testid="idea-row"][data-selected="true"]');

/** The digit the sidebar draws beside a channel. */
async function digitOf(page: Page, name: string): Promise<string> {
  const link = page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name, exact: true });
  const digit = await link.getAttribute('aria-keyshortcuts');
  if (digit === null) throw new Error(`${name} has no digit in the sidebar`);
  return digit;
}

/* -------------------------------------------------------------------------- */
/* 1. Every advertised key works where the sheet says it does                  */
/* -------------------------------------------------------------------------- */

test('each route advertises exactly its own keys', async ({ page }) => {
  await openBoard(page);
  await expectSheet(page, SHEETS.board);

  await openNow(page);
  await expectSheet(page, SHEETS.now);

  await openIdeas(page);
  await expectSheet(page, SHEETS.ideas);

  await page.goto('/calendar');
  await keysReady(page);
  await expectSheet(page, SHEETS.plain);

  await page.goto(`/videos/${ids[PACKAGING[0]]}`);
  await keysReady(page);
  await expectSheet(page, SHEETS.plain);

  await page.goto(`/settings/stages/${CHANNEL.slug}`);
  await keysReady(page);
  await expectSheet(page, SHEETS.plain);
});

test('g then a letter goes where the sidebar row goes, and 1–9 picks a channel', async ({
  page,
}) => {
  await openBoard(page);

  // `g` alone says what it is waiting for.
  await page.keyboard.press('g');
  const waiting = page.getByTestId('shortcut-sequence');
  await expect(waiting).toBeVisible();
  for (const place of ['Now', 'Board', 'Ideas', 'Calendar', 'Settings']) {
    await expect(waiting).toContainText(place);
  }
  await page.keyboard.press('i');
  await page.waitForURL(`**/c/${CHANNEL.slug}/ideas`);
  await expect(waiting).toHaveCount(0);
  await expect(page.getByTestId('idea-bank')).toHaveAttribute('data-ready', 'true');
  await keysReady(page);

  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await page.waitForURL(`**/settings/stages/${CHANNEL.slug}`);
  await keysReady(page);

  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await page.waitForURL('**/calendar');
  // `g c` is the calendar and never capture: after `g` the next key is a place.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await keysReady(page);

  await page.keyboard.press('g');
  await page.keyboard.press('n');
  await page.waitForURL('**/now');
  await expect(page.getByTestId('now')).toHaveAttribute('data-ready', 'true');
  await keysReady(page);

  // Off a channel's route, Board is the sidebar's Board row — same href.
  const boardHref = await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Board', exact: true })
    .getAttribute('href');
  await page.keyboard.press('g');
  await page.keyboard.press('b');
  await page.waitForURL(`**${boardHref}`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
  await keysReady(page);

  // 1–9: the digit drawn beside the channel. A seeded channel, because only
  // the first nine are numbered and a full run has created more than that.
  const target = 'Sunday Softworks';
  const targetHref = await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: target, exact: true })
    .getAttribute('href');
  expect(targetHref).not.toBe(boardHref);
  await page.keyboard.press(await digitOf(page, target));
  await page.waitForURL(`**${targetHref}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(target);
  await page.goto(`/c/${CHANNEL.slug}/board`);

  // A sequence nobody finishes goes away, and consumes nothing after it.
  await keysReady(page);
  await page.keyboard.press('g');
  await expect(waiting).toBeVisible();
  await expect(waiting).toHaveCount(0, { timeout: 5_000 });
  await page.keyboard.press('n');
  await page.waitForTimeout(300);
  expect(new URL(page.url()).pathname).toBe(`/c/${CHANNEL.slug}/board`);
});

test('c, and the keys inside the capture box', async ({ page }) => {
  await openBoard(page);
  const other = 'Personal';
  const otherDigit = await digitOf(page, other);

  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'Capture an idea' });
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel('Idea', { exact: true });
  await expect(field).toBeFocused();
  await expect(dialog.getByRole('radio', { name: CHANNEL.name })).toBeChecked();

  // Shift+Enter opens the rest of the form, at the hook.
  await field.fill('Keys — not to be saved');
  await page.keyboard.press('Shift+Enter');
  await expect(dialog.getByLabel('One-line hook')).toBeFocused();

  // Alt+digit, from the title field, retargets.
  await field.focus();
  await page.keyboard.press(`Alt+Digit${otherDigit}`);
  await expect(dialog.getByRole('radio', { name: other })).toBeChecked();

  // Escape closes without writing.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const unsaved = await db.query("select 1 from public.videos where title = 'Keys — not to be saved'");
  expect(unsaved.rowCount).toBe(0);

  // Enter saves, into the route's channel.
  await page.keyboard.press('c');
  await expect(field).toBeFocused();
  await field.fill('Keys — captured by keyboard');
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => {
      const saved = await db.query<{ slug: string; kind: string }>(
        `select c.slug, s.kind from public.videos v
           join public.channels c on c.id = v.channel_id
           join public.stages s on s.id = v.stage_id
          where v.title = 'Keys — captured by keyboard'`,
      );
      return saved.rows;
    })
    .toEqual([{ slug: CHANNEL.slug, kind: 'idea' }]);
  await db.query("delete from public.videos where title = 'Keys — captured by keyboard'");
});

test('on the board: j / k, [ / ], Enter and Escape', async ({ page }) => {
  await openBoard(page);

  await page.keyboard.press('j');
  await expect(selectedCard(page)).toHaveCount(1);
  const first = (await selectedCard(page).getAttribute('data-video-id'))!;
  await page.keyboard.press('j');
  const second = (await selectedCard(page).getAttribute('data-video-id'))!;
  expect(second).not.toBe(first);
  await page.keyboard.press('k');
  await expect(selectedCard(page)).toHaveAttribute('data-video-id', first);

  // The first card is in the first column, an idea. `]` moves it on a stage,
  // `[` brings it back — the same `move_video` the drag uses.
  expect(await stageKind(first)).toBe('idea');
  await page.keyboard.press(']');
  await expect.poll(() => stageKind(first)).toBe('packaging');
  await expect(selectedCard(page)).toHaveAttribute('data-video-id', first);
  // A second move while the first is in flight is dropped on purpose (M1), so
  // wait for the card to settle before sending it back.
  await expect(selectedCard(page)).not.toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('[');
  await expect.poll(() => stageKind(first)).toBe('idea');

  await page.keyboard.press('Escape');
  await expect(selectedCard(page)).toHaveCount(0);

  // (The round trip re-ordered the column, so open whatever `j` lands on.)
  await page.keyboard.press('j');
  await expect(selectedCard(page)).toHaveCount(1);
  const opened = (await selectedCard(page).getAttribute('data-video-id'))!;
  await page.keyboard.press('Enter');
  await page.waitForURL(`**/videos/${opened}`);
});

test('on Now: j / k, x, Enter and Escape', async ({ page }) => {
  await openNow(page);

  await page.keyboard.press('j');
  await expect(selectedRow(page)).toHaveCount(1);
  const first = (await selectedRow(page).getAttribute('data-video-id'))!;
  expect(first).toBe(ids[PACKAGING[0]]);
  await page.keyboard.press('j');
  await expect(selectedRow(page)).toHaveAttribute('data-video-id', ids[PACKAGING[1]]);
  await page.keyboard.press('k');
  await expect(selectedRow(page)).toHaveAttribute('data-video-id', first);

  // `x` does the row's next action: here, the first unticked box.
  expect(await checkedCount(first)).toBe(0);
  await page.keyboard.press('x');
  await expect.poll(() => checkedCount(first)).toBe(1);
  expect(new URL(page.url()).pathname).toBe('/now');

  await expect(selectedRow(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(selectedRow(page)).toHaveCount(0);

  await page.keyboard.press('j');
  const opened = (await selectedRow(page).getAttribute('data-video-id'))!;
  await page.keyboard.press('Enter');
  await page.waitForURL(`**/videos/${opened}`);
});

test('in the idea bank: /, j / k, p, Enter and Escape', async ({ page }) => {
  await openIdeas(page);

  await page.keyboard.press('/');
  await expect(page.getByTestId('idea-search')).toBeFocused();
  await page.getByTestId('idea-search').evaluate((element) => element.blur());

  await page.keyboard.press('j');
  await expect(selectedIdea(page)).toHaveCount(1);
  const first = (await selectedIdea(page).getAttribute('data-video-id'))!;
  await page.keyboard.press('j');
  const second = (await selectedIdea(page).getAttribute('data-video-id'))!;
  expect(second).not.toBe(first);
  await page.keyboard.press('k');
  await expect(selectedIdea(page)).toHaveAttribute('data-video-id', first);

  await page.keyboard.press('p');
  await expect.poll(() => stageKind(first)).toBe('packaging');
  await expect(page.locator(`[data-testid="idea-row"][data-video-id="${first}"]`)).toHaveCount(0);

  await page.keyboard.press('j');
  await expect(selectedIdea(page)).toHaveAttribute('data-video-id', second);
  await page.keyboard.press('Escape');
  await expect(selectedIdea(page)).toHaveCount(0);

  await page.keyboard.press('j');
  await page.keyboard.press('Enter');
  await page.waitForURL(`**/videos/${second}`);
});

test('a key typed with AltGr is still that key; Ctrl or Alt alone is not', async ({
  page,
}) => {
  await openBoard(page);
  await page.keyboard.press('j');
  const card = (await selectedCard(page).getAttribute('data-video-id'))!;
  const before = await stageKind(card);

  // Synthetic, because the harness's keyboard is US: on a German or French
  // Windows keyboard `]` is AltGr+9, which the browser reports as Ctrl+Alt
  // with the AltGraph modifier set.
  const press = (init: {
    key: string;
    ctrlKey?: boolean;
    altKey?: boolean;
    modifierAltGraph?: boolean;
  }) =>
    page.evaluate((options) => {
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(
        new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true }),
      );
    }, init);

  // Ctrl+] with no AltGr is the browser's, not ours.
  await press({ key: ']', ctrlKey: true });
  await page.waitForTimeout(300);
  expect(await stageKind(card)).toBe(before);

  await press({ key: ']', ctrlKey: true, altKey: true, modifierAltGraph: true });
  await expect.poll(() => stageKind(card)).not.toBe(before);
  await expect(selectedCard(page)).not.toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('[');
  await expect.poll(() => stageKind(card)).toBe(before);
});

/* -------------------------------------------------------------------------- */
/* 2. Never while typing                                                       */
/* -------------------------------------------------------------------------- */

/** Every key the application binds anywhere, and some that start sequences. */
const EVERY_KEY = ['c', '?', 'g', 'n', 'j', 'k', ']', '[', 'x', 'p', '/', '1', '2', 'Enter', 'Escape'];

test('no shortcut fires from any kind of field', async ({ page }) => {
  await openBoard(page);

  // A card selected first, so a stray j, ], [, Enter or Escape would show.
  await page.keyboard.press('j');
  const chosen = (await selectedCard(page).getAttribute('data-video-id'))!;
  const kindBefore = await stageKind(chosen);

  // Every field type the registry has to recognise, dropped into the page.
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'typing-fixture';
    const types = [
      'text', 'search', 'email', 'url', 'tel', 'password', 'number',
      'date', 'time', 'datetime-local', 'month', 'week',
    ];
    for (const type of types) {
      const input = document.createElement('input');
      input.type = type;
      input.dataset.field = `input-${type}`;
      host.append(input);
    }
    const textarea = document.createElement('textarea');
    textarea.dataset.field = 'textarea';
    const select = document.createElement('select');
    select.dataset.field = 'select';
    for (const value of ['a', 'b', 'c', 'j', 'x']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    editable.dataset.field = 'contenteditable';
    const textbox = document.createElement('div');
    textbox.setAttribute('role', 'textbox');
    textbox.tabIndex = 0;
    textbox.dataset.field = 'role-textbox';
    host.append(textarea, select, editable, textbox);
    document.querySelector('main')!.prepend(host);
  });

  const fields = await page.locator('#typing-fixture [data-field]').all();
  expect(fields.length).toBe(16);

  for (const field of fields) {
    const name = await field.getAttribute('data-field');
    await field.focus();
    for (const key of EVERY_KEY) await page.keyboard.press(key);

    await expect(page.getByRole('dialog'), `${name}: nothing opened`).toHaveCount(0);
    await expect(page.getByTestId('shortcut-sequence'), `${name}: no sequence`).toHaveCount(0);
    expect(new URL(page.url()).pathname, `${name}: did not navigate`).toBe(
      `/c/${CHANNEL.slug}/board`,
    );
    await expect(selectedCard(page), `${name}: selection kept`).toHaveAttribute(
      'data-video-id',
      chosen,
    );
  }
  expect(await stageKind(chosen)).toBe(kindBefore);

  // The text fields received the text — the keys were typing, not lost.
  await expect(page.locator('[data-field="input-text"]')).toHaveValue('c?gnjk][xp/12');
  await expect(page.locator('[data-field="textarea"]')).toHaveValue('c?gnjk][xp/12\n');

  // A checkbox is a control, not a field: `j` from one still selects.
  await page.evaluate(() => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.field = 'checkbox';
    document.querySelector('#typing-fixture')!.append(box);
  });
  await page.locator('[data-field="checkbox"]').focus();
  await page.keyboard.press('j');
  await expect(selectedCard(page)).not.toHaveAttribute('data-video-id', chosen);
});

test('no shortcut fires from the real fields: search, capture, settings, a title beside an assist panel', async ({
  page,
}) => {
  const typed = 'g n?c j]p/1x';

  // The bank's search box: `p` must not promote and `/` must stay a slash.
  await openIdeas(page);
  const search = page.getByTestId('idea-search');
  await search.focus();
  await page.keyboard.type(typed);
  await expect(search).toHaveValue(typed);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(selectedIdea(page)).toHaveCount(0);
  expect(await stageKind(ids[IDEAS[0]])).toBe('idea');
  expect(await stageKind(ids[IDEAS[1]])).toBe('idea');

  // The capture box's title.
  await page.keyboard.press('Escape'); // nothing to close: the key reaches no layer
  await search.evaluate((element) => element.blur());
  await page.keyboard.press('c');
  const capture = page.getByRole('dialog', { name: 'Capture an idea' });
  const title = capture.getByLabel('Idea', { exact: true });
  await expect(title).toBeFocused();
  await page.keyboard.type(typed);
  await expect(title).toHaveValue(typed);
  await expect(sheet(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(capture).toHaveCount(0);

  // A settings form: a stage's name. Escape there reverts the edit, and that
  // is all it does.
  await page.goto(`/settings/stages/${CHANNEL.slug}`);
  await keysReady(page);
  const name = page.getByTestId('stage-name').first();
  const original = await name.inputValue();
  await name.focus();
  await page.keyboard.press('End');
  await page.keyboard.type(typed);
  await expect(name).toHaveValue(original + typed);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(`/settings/stages/${CHANNEL.slug}`);
  await page.keyboard.press('Escape');
  await expect(name).toHaveValue(original);

  // The working title, with M8's assist panel open beside it.
  await openPanel(page, ids[PACKAGING[0]]);
  const working = page.getByTestId('working-title');
  const before = await working.inputValue();
  await working.focus();
  await page.keyboard.press('End');
  await page.keyboard.type(typed);
  await expect(working).toHaveValue(before + typed);
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('brainstorm-panel')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* 3. The sheet                                                                */
/* -------------------------------------------------------------------------- */

test('the sheet: ? opens it, Tab stays inside, Enter follows a link, Escape and ? close it', async ({
  page,
}) => {
  await openBoard(page);

  // Opened from the page, it takes focus; closed, it gives focus back.
  await page.keyboard.press('j');
  const card = selectedCard(page);
  await expect(card).toBeFocused();
  const dialog = await openSheet(page);
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
    true,
  );

  // Honest about what is not here: the views whose keys are elsewhere.
  const elsewhere = dialog.getByTestId('shortcut-sheet-elsewhere');
  await expect(elsewhere.getByRole('link', { name: 'Now' })).toBeVisible();
  await expect(elsewhere.getByRole('link', { name: 'the idea bank' })).toBeVisible();
  await expect(elsewhere.getByRole('link', { name: 'the board' })).toHaveCount(0);

  // Tab and Shift+Tab walk the sheet's controls and never leave it.
  const stops = await dialog.locator('a[href], button').count();
  for (let index = 0; index < stops + 2; index += 1) {
    await page.keyboard.press('Tab');
    expect(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
      `Tab ${index + 1} stayed in the sheet`,
    ).toBe(true);
  }
  for (let index = 0; index < stops + 2; index += 1) {
    await page.keyboard.press('Shift+Tab');
    expect(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
      `Shift+Tab ${index + 1} stayed in the sheet`,
    ).toBe(true);
  }

  // Escape closes it, and focus goes back to the card it came from.
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(card).toBeFocused();

  // `?` again closes it too.
  await openSheet(page);
  await page.keyboard.press('?');
  await expect(sheet(page)).toHaveCount(0);

  // The hint bar's button opens the same sheet, for anyone who never pressed ?.
  await page.getByTestId('shortcut-sheet-open').click();
  await expect(sheet(page)).toBeVisible();

  // Enter on a link in it goes there, and the sheet does not follow.
  const link = sheet(page).getByRole('link', { name: 'the idea bank' });
  await link.focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(`**/c/${CHANNEL.slug}/ideas`);
  await expect(sheet(page)).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* 4. Escape: one layer at a time, newest first                                */
/* -------------------------------------------------------------------------- */

test('Escape closes one layer at a time, newest first', async ({ page }) => {
  await openBoard(page);

  // A dialog over a selection: the dialog, then the selection.
  await page.keyboard.press('j');
  await expect(selectedCard(page)).toHaveCount(1);
  await page.keyboard.press('c');
  const capture = page.getByRole('dialog', { name: 'Capture an idea' });
  await expect(capture).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(capture).toHaveCount(0);
  await expect(selectedCard(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(selectedCard(page)).toHaveCount(0);

  // The sheet over a selection: the same.
  await page.keyboard.press('j');
  await openSheet(page);
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(selectedCard(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(selectedCard(page)).toHaveCount(0);

  // An armed `g` is the newest thing of all: Escape takes it and nothing else,
  // and the next key is an ordinary key again.
  await page.keyboard.press('j');
  await page.keyboard.press('g');
  await expect(page.getByTestId('shortcut-sequence')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('shortcut-sequence')).toHaveCount(0);
  await expect(selectedCard(page)).toHaveCount(1);
  await page.keyboard.press('c');
  await expect(capture).toBeVisible();
  await page.keyboard.press('Escape');

  // A sheet over an assist panel: the sheet, then the panel.
  await openPanel(page, ids[PACKAGING[0]]);
  const panel = page.getByTestId('brainstorm-panel');
  await panel.locator('button').first().focus();
  await openSheet(page);
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((element) => element.contains(document.activeElement))).toBe(
    true,
  );
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('on a phone, the menu is a layer too, and the page keys wait behind it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openBoard(page);

  await page.getByRole('button', { name: 'Menu' }).click();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu).toBeVisible();

  // Behind the menu the page's keys are inert — `?` included.
  await page.keyboard.press('?');
  await page.keyboard.press('j');
  await expect(sheet(page)).toHaveCount(0);
  await expect(selectedCard(page)).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */

const panelOf = (page: Page) => page.getByTestId('brainstorm-panel');
const pill = (page: Page) =>
  page.locator('[data-testid="assist-pill"][data-assist="Generate 20"]');

/** Open the brainstorm panel, retrying the click through hydration. */
async function openPanel(page: Page, videoId: string): Promise<void> {
  await page.goto(`/videos/${videoId}`);
  await keysReady(page);
  await expect(async () => {
    if ((await panelOf(page).count()) === 0) await pill(page).click();
    await expect(panelOf(page)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}
