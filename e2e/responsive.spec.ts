import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/**
 * M9 — the responsive pass, measured rather than eyeballed.
 *
 * ## What this file is answering
 *
 * M3's review, finding 32: *the app shell has no responsive breakpoint.* At
 * 390×844 the 224px sidebar left `main` 166px wide and, after two 32px gutters,
 * a **102px** content column (72px at 360). On `/now` every row wrapped to two
 * or three words a line and the tick box sat over the text. M9 reproduced those
 * numbers in a browser before touching anything; they are in
 * `docs/MILESTONES.md` beside the ones this file now pins.
 *
 * Five claims, one block each:
 *
 * 1. **No page scrolls sideways**, on any signed-in route, at any of the seven
 *    widths the brief names — 390, 360, 768, 1024, 1280, 1440, 1920.
 * 2. **The sidebar collapses at phone width**, into the application's one modal
 *    (`placement="start"`), and is operable by keyboard: reachable by Tab,
 *    announced as a dialog with `aria-expanded` on its button, trapped,
 *    dismissed by Escape / the backdrop / a chosen link, focus returned.
 * 3. **`/now` rows are readable with nothing overlapping**, every row control
 *    44px tall, at 390 and 360 — and a tick still writes the row.
 * 4. **`/capture` saves with the keyboard open**: the save is on screen in the
 *    part of a phone a keyboard leaves, and one gesture saves.
 * 5. **The desktop layout is unchanged**: the sidebar's boxes at 1024–1920 are
 *    the numbers M3 signed off, measured, not assumed.
 *
 * Both themes are exercised where colour is what the layout changes: the phone
 * bar and the sheet are drawn on `--sidebar`, and that is checked in each.
 *
 * ## "The keyboard is open"
 *
 * Playwright cannot raise a software keyboard. What a keyboard *does* to a
 * page is leave it a shorter visible area — on a 390×844 iPhone, roughly the
 * top 440px once the keyboard and its suggestion bar are up — so the claim is
 * tested as a 390×440 viewport: the save must be inside it, unscrolled, and a
 * tap or the return key must write the row.
 */

const WIDTHS = [390, 360, 768, 1024, 1280, 1440, 1920] as const;
const PHONE = { width: 390, height: 844 };
/** A 390×844 phone with its keyboard up. See the note above. */
const PHONE_WITH_KEYBOARD = { width: 390, height: 440 };

const CHANNEL = { name: 'M9 Phone', slug: 'm9-phone' };
const PREFIX = 'M9 phone —';

/** The ground and sidebar colours, in the two themes (`app/globals.css`). */
const SIDEBAR = { light: 'rgb(239, 242, 238)', dark: 'rgb(12, 16, 14)' };

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
  await db.query('delete from public.videos where title like $1', [`${PREFIX}%`]);
  await db?.end();
});

async function signIn(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}

async function channelRow(): Promise<{ id: string; user_id: string } | null> {
  const result = await db.query<{ id: string; user_id: string }>(
    'select id, user_id from public.channels where slug = $1',
    [CHANNEL.slug],
  );
  return result.rows[0] ?? null;
}

async function ensureChannel(page: Page): Promise<{ id: string; user_id: string }> {
  const existing = await channelRow();
  if (existing) return existing;
  await page.goto('/c/new');
  await page.getByLabel('Channel name').fill(CHANNEL.name);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.waitForURL(`**/c/${CHANNEL.slug}/board`);
  const created = await channelRow();
  if (!created) throw new Error('the fixture channel was not created');
  return created;
}

interface SeedVideo {
  title: string;
  kind: string;
  age: string;
  /** Title, concept and a chosen hook — the gate open. */
  packaged?: boolean;
  /** Two hooks, neither chosen: rule 7's choice row. */
  unchosenHooks?: boolean;
  checklist?: 'none' | 'open' | 'done';
  waitingOn?: string;
  targetInDays?: number;
  publishedAgo?: string;
}

/**
 * One video, written the way `move_video` would have left it — the same shape
 * `e2e/now.spec.ts` seeds, so the rows are the ranking's rows and not a mock.
 */
async function seedVideo(
  channel: { id: string; user_id: string },
  video: SeedVideo,
): Promise<string> {
  const stage = await db.query<{ id: string }>(
    'select id from public.stages where channel_id = $1 and kind = $2',
    [channel.id, video.kind],
  );
  const stageId = stage.rows[0].id;
  const packaged = video.packaged ?? true;
  const hooks = video.unchosenHooks
    ? [
        { id: 'h1', text: 'You have been measuring the wrong thing all along', chosen: false },
        { id: 'h2', text: 'Three numbers, and why only one of them matters', chosen: false },
      ]
    : packaged
      ? [{ id: 'h1', text: 'The hook, as spoken', chosen: true }]
      : [];

  const inserted = await db.query<{ id: string }>(
    `insert into public.videos (
       user_id, channel_id, stage_id, stage_entered_at,
       title, thumbnail_concept, hooks,
       waiting_on, waiting_since, target_publish_date, published_at
     ) values (
       $1, $2, $3, now() - $4::interval,
       $5, $6, $7::jsonb,
       $8, case when $8::text is null then null else now() - $4::interval end,
       case when $9::int is null then null else (current_date + $9::int) end,
       case when $10::text is null then null else now() - $10::interval end
     ) returning id`,
    [
      channel.user_id,
      channel.id,
      stageId,
      video.age,
      video.title,
      packaged || video.unchosenHooks ? 'A close-up of the thing, mid-failure' : null,
      JSON.stringify(hooks),
      video.waitingOn ?? null,
      video.targetInDays ?? null,
      video.publishedAgo ?? null,
    ],
  );
  const id = inserted.rows[0].id;

  if ((video.checklist ?? 'none') !== 'none') {
    await db.query(
      `insert into public.checklist_items (user_id, video_id, channel_id, stage_id, text, position, est_minutes, checked_at)
       select $1, $2, $3, $4, t.text, t.position, t.est_minutes,
              case when $5::boolean then now() else null end
         from public.checklist_templates t
        where t.stage_id = $4`,
      [channel.user_id, id, channel.id, stageId, video.checklist === 'done'],
    );
  }
  return id;
}

/**
 * One row of every control `/now` can draw, bar the swap prompt (it needs an
 * expectation from past metrics and renders the same two buttons as Waiting).
 * Titles are long on purpose: a short title passes a narrow-screen test by
 * accident.
 */
async function seedWeek(channel: { id: string; user_id: string }): Promise<void> {
  await db.query('delete from public.videos where channel_id = $1', [channel.id]);
  const long = 'with a working title long enough that it has to wrap on a phone';
  await seedVideo(channel, {
    title: `${PREFIX} tick, ${long}`,
    kind: 'packaging',
    age: '4 days 1 hour',
    checklist: 'open',
  });
  await seedVideo(channel, {
    // Rule 1: past the gate with no title — the text row.
    title: '',
    kind: 'scripting',
    age: '9 days 1 hour',
    checklist: 'open',
  });
  await seedVideo(channel, {
    title: `${PREFIX} choice, ${long}`,
    kind: 'packaging',
    age: '3 days 1 hour',
    packaged: false,
    unchosenHooks: true,
    checklist: 'done',
  });
  await seedVideo(channel, {
    title: `${PREFIX} move, ${long}`,
    kind: 'packaging',
    age: '12 days 1 hour',
    checklist: 'done',
  });
  await seedVideo(channel, {
    title: `${PREFIX} waiting, ${long}`,
    kind: 'editing',
    age: '6 days 1 hour',
    waitingOn: 'the editor, who is on holiday until Thursday',
    checklist: 'open',
  });
  await seedVideo(channel, {
    title: `${PREFIX} confirm live, ${long}`,
    kind: 'scheduled',
    age: '5 days 1 hour',
    targetInDays: -2,
  });
  await seedVideo(channel, {
    title: `${PREFIX} metrics, ${long}`,
    kind: 'published',
    age: '25 hours',
    publishedAgo: '25 hours',
  });
}

/** `/now`, hydrated and narrowed to this file's channel. */
async function openNow(page: Page): Promise<void> {
  await page.goto('/now');
  await expect(page.getByTestId('now')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('channel-chip').filter({ hasText: CHANNEL.name }).click();
}

/** The content column: `main`'s inner width once its own gutters are taken off. */
async function contentColumn(page: Page): Promise<number> {
  return page.getByTestId('app-main').evaluate((main) => {
    const style = getComputedStyle(main);
    return (
      main.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight)
    );
  });
}

async function scrollsSideways(page: Page): Promise<{ scrollWidth: number; clientWidth: number; scrollX: number }> {
  return page.evaluate(() => {
    // Asked of the document *and* tried: a hidden label parked 900px out once
    // made `scrollWidth` lie in the other direction (see `app-shell.tsx`).
    window.scrollTo(10_000, window.scrollY);
    const scrollX = window.scrollX;
    window.scrollTo(0, window.scrollY);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollX,
    };
  });
}

const menuButton = (page: Page): Locator => page.getByTestId('sidebar-menu');
const sheet = (page: Page): Locator => page.getByRole('dialog', { name: 'Menu' });

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

/* -------------------------------------------------------------------------- */
/* 1. No page scrolls sideways                                                 */
/* -------------------------------------------------------------------------- */

test('no signed-in route scrolls sideways at any of the seven widths', async ({
  page,
}) => {
  test.setTimeout(420_000);
  const channel = await ensureChannel(page);
  await seedWeek(channel);

  // Pillars, so the matrix is a real grid wider than a phone — the route that
  // scrolled the page 507px before `main` was positioned.
  for (const [index, name] of ['money', 'focus', 'health'].entries()) {
    await db.query(
      `insert into public.buckets (user_id, channel_id, axis, name, position)
       select $1, $2, 'vertical', $3::text, $4::int
        where not exists (select 1 from public.buckets
                           where channel_id = $2 and axis = 'vertical' and name = $3::text)`,
      [channel.user_id, channel.id, name, index + 1],
    );
  }
  const video = await db.query<{ id: string }>(
    `select id from public.videos where channel_id = $1 and title like $2 limit 1`,
    [channel.id, `${PREFIX} tick%`],
  );
  const videoId = video.rows[0].id;

  const routes = [
    '/now',
    '/capture',
    `/c/${CHANNEL.slug}/board`,
    `/c/${CHANNEL.slug}/ideas`,
    `/c/${CHANNEL.slug}/ideas?view=matrix`,
    '/calendar',
    `/videos/${videoId}`,
    `/videos/${videoId}?section=thumbnails`,
    `/settings/stages/${CHANNEL.slug}`,
    `/settings/checklists/${CHANNEL.slug}`,
    `/settings/buckets/${CHANNEL.slug}`,
    `/settings/channel/${CHANNEL.slug}`,
    '/c/new',
  ];

  const failures: string[] = [];
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    for (const route of routes) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      const measured = await scrollsSideways(page);
      if (measured.scrollWidth > measured.clientWidth || measured.scrollX !== 0) {
        failures.push(`${route} at ${width}px: ${JSON.stringify(measured)}`);
      }
    }
  }
  expect(failures, 'pages that scroll sideways').toEqual([]);
});

test('no sideways scroll on /now and the open sheet in the dark theme either', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const channel = await ensureChannel(page);
  await seedWeek(channel);

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await openNow(page);
    const measured = await scrollsSideways(page);
    expect(measured.scrollWidth, `/now scrolls sideways at ${width}px in dark`).toBe(
      measured.clientWidth,
    );
  }

  await page.setViewportSize(PHONE);
  await openNow(page);
  // The bar and the sheet are the sidebar's ground, in this theme's value.
  await expect(page.getByTestId('app-sidebar')).toHaveCSS(
    'background-color',
    SIDEBAR.dark,
  );
  await menuButton(page).click();
  await expect(sheet(page)).toHaveCSS('background-color', SIDEBAR.dark);
  expect((await scrollsSideways(page)).scrollX).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* 2. The sidebar collapses, and is reachable by keyboard                      */
/* -------------------------------------------------------------------------- */

test('at phone width the sidebar is a bar, and the column is the screen', async ({
  page,
}) => {
  for (const [width, least] of [
    [390, 358],
    [360, 328],
  ] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/now');
    await expect(page.getByTestId('now')).toHaveAttribute('data-ready', 'true');

    // M3 measured 102px and 72px here. 16px gutters are all that is left.
    expect(await contentColumn(page), `content column at ${width}px`).toBe(least);

    const bar = await page.getByTestId('app-sidebar').boundingBox();
    // 56px of bar and its 1px hairline.
    expect(bar).toMatchObject({ x: 0, y: 0, width, height: 57 });
    await expect(page.getByTestId('app-sidebar')).toHaveCSS(
      'background-color',
      SIDEBAR.light,
    );

    // The desktop navigation is not drawn, and not in the accessibility tree.
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await expect(menuButton(page)).toBeVisible();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(menuButton(page)).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(menuButton(page)).toHaveAccessibleName('Menu');
    // Capture is on the bar, where the thumb is, and is the same `c` host.
    await expect(page.locator('button[aria-keyshortcuts="c"]')).toBeVisible();

    // The bar stays put while the page scrolls.
    await page.mouse.wheel(0, 600);
    expect((await page.getByTestId('app-sidebar').boundingBox())?.y).toBe(0);
  }
});

test('the menu is reachable, trapped and dismissible from the keyboard', async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto('/now');
  await expect(page.getByTestId('now')).toHaveAttribute('data-ready', 'true');
  await expect(
    page.locator('button[aria-keyshortcuts="c"][data-shortcut-ready]'),
  ).toHaveCount(1);

  // Tab from the top of the document: the skip link, then the menu.
  await page.locator('body').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('skip-to-main')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menuButton(page)).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(sheet(page)).toBeVisible();
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(sheet(page)).toHaveAttribute('aria-modal', 'true');
  await expect(sheet(page)).toHaveAttribute('data-placement', 'start');

  // A sheet against the leading edge, full height, leaving backdrop to tap.
  const box = await sheet(page).boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.height).toBe(PHONE.height);
  expect(box?.width ?? 0).toBeLessThanOrEqual(PHONE.width - 48);

  // The navigation is in it, whole.
  const nav = sheet(page).getByRole('navigation', { name: 'Main' });
  for (const name of ['Now', 'Board', 'Ideas', 'Calendar', 'Settings']) {
    await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  }
  await expect(nav.getByRole('link', { name: 'Now', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(sheet(page).getByTestId('theme-toggle')).toBeVisible();
  await expect(sheet(page).getByRole('button', { name: 'Sign out' })).toBeVisible();

  // Focus is inside, and stays inside, however far Tab is pressed.
  const inside = () =>
    page.evaluate(() =>
      Boolean(document.activeElement?.closest('[role="dialog"]')),
    );
  expect(await inside()).toBe(true);
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    expect(await inside(), `focus escaped the sheet after ${i + 1} Tabs`).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await inside()).toBe(true);

  // The page underneath is quiet: `c` does not open capture over the sheet.
  await page.keyboard.press('c');
  await expect(page.getByRole('dialog', { name: 'Capture an idea' })).toHaveCount(0);

  // Escape closes it, and focus goes back to the button that opened it.
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(menuButton(page)).toBeFocused();
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');

  // A tap on the backdrop closes it.
  await menuButton(page).click();
  await expect(sheet(page)).toBeVisible();
  await page.mouse.click(PHONE.width - 10, PHONE.height / 2);
  await expect(sheet(page)).toHaveCount(0);
  // …and focus goes back to the button, as it does for Escape. It fell to
  // <body> until the M9 review: the backdrop closed the modal inside the
  // mousedown, and the mousedown's default then moved focus off the opener.
  await expect(menuButton(page)).toBeFocused();

  // Choosing a link closes it and goes there.
  await menuButton(page).click();
  await sheet(page)
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Calendar', exact: true })
    .click();
  await expect(sheet(page)).toHaveCount(0);
  await page.waitForURL('**/calendar');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // The page that arrives has its own bar; its menu button takes focus, which
  // is where the one that was used would have been (M9 review).
  await expect(menuButton(page)).toBeFocused();

  // Widening the window past the breakpoint takes the sheet away: the desktop
  // sidebar is back, with the same links, and there is one "Main" navigation.
  await menuButton(page).click();
  await expect(sheet(page)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(1);
  await expect(menuButton(page)).toBeHidden();
});

/* -------------------------------------------------------------------------- */
/* 3. /now on a phone                                                          */
/* -------------------------------------------------------------------------- */

interface Box {
  what: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Everything drawn in one row that a reader reads or a thumb presses, as boxes.
 * Nested pairs (the checkbox inside its label) are not collisions and are left
 * out by taking only the outermost interactive element.
 */
async function rowBoxes(row: Locator): Promise<{ row: Box; parts: Box[] }> {
  return row.evaluate((li) => {
    const toBox = (element: Element, what: string) => {
      const rect = element.getBoundingClientRect();
      return { what, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const interactive = Array.from(
      li.querySelectorAll<HTMLElement>('a, button, input, label'),
    ).filter(
      (element) =>
        element.getClientRects().length > 0 &&
        !element.parentElement?.closest('a, button, label'),
    );
    const text = Array.from(
      li.querySelectorAll<HTMLElement>(
        '[data-testid="now-label"], [data-testid="now-age"], [data-testid="now-est"], [data-testid="waiting-age"]',
      ),
    );
    return {
      row: toBox(li, 'row'),
      parts: [
        ...text.map((element) => toBox(element, element.dataset.testid ?? 'text')),
        ...interactive.map((element) =>
          toBox(
            element,
            `${element.tagName.toLowerCase()}[${element.dataset.testid ?? element.textContent?.trim().slice(0, 20) ?? ''}]`,
          ),
        ),
      ],
    };
  });
}

function overlaps(a: Box, b: Box): boolean {
  // Sub-pixel slack: two boxes that share an edge are touching, not overlapping.
  const slack = 0.5;
  return (
    a.x + a.width - slack > b.x &&
    b.x + b.width - slack > a.x &&
    a.y + a.height - slack > b.y &&
    b.y + b.height - slack > a.y
  );
}

test('/now rows are readable at phone width, with nothing overlapping', async ({
  page,
}) => {
  const channel = await ensureChannel(page);
  await seedWeek(channel);

  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await openNow(page);

    const rows = page.getByTestId('now-row');
    await expect(rows).toHaveCount(7);

    // Every kind of control is on screen — the point is to measure all of them.
    const inputs = await rows.evaluateAll((items) =>
      items.map((item) => (item as HTMLElement).dataset.input),
    );
    expect(new Set(inputs)).toEqual(
      new Set(['tick', 'text', 'choice', 'move', 'clear_waiting', 'url', 'metrics_pair']),
    );

    for (let index = 0; index < 7; index += 1) {
      const row = rows.nth(index);
      await row.scrollIntoViewIfNeeded();
      const { row: frame, parts } = await rowBoxes(row);
      const kind = inputs[index];

      // Inside the screen, with its gutter.
      expect(frame.x, `${kind} row left edge`).toBeGreaterThanOrEqual(16);
      expect(frame.x + frame.width, `${kind} row right edge`).toBeLessThanOrEqual(
        width - 16 + 0.5,
      );

      // Readable: the action gets most of the row, not three words a line.
      // M3's review measured the whole row at 102px.
      const label = parts.find((part) => part.what === 'now-label');
      expect(label, `${kind} row has a label`).toBeDefined();
      expect(label!.width, `${kind} label width at ${width}px`).toBeGreaterThanOrEqual(
        frame.width * 0.6,
      );

      // Nothing sits on anything else — the tick box over the text was the bug.
      for (let a = 0; a < parts.length; a += 1) {
        for (let b = a + 1; b < parts.length; b += 1) {
          expect(
            overlaps(parts[a], parts[b]),
            `${kind} row at ${width}px: ${parts[a].what} overlaps ${parts[b].what}`,
          ).toBe(false);
        }
        // And nothing hangs out of the row.
        expect(parts[a].x, `${parts[a].what} left`).toBeGreaterThanOrEqual(frame.x);
        expect(parts[a].x + parts[a].width, `${parts[a].what} right`).toBeLessThanOrEqual(
          frame.x + frame.width + 0.5,
        );
      }

      // The row's own controls are thumb-sized; the chips that are links
      // elsewhere clear WCAG 2.5.8's 24px floor.
      for (const part of parts) {
        // A field's own <label> is text, not a target — except the tick's,
        // which is the target on purpose.
        if (part.what.startsWith('label[') && !part.what.includes('now-tick-target')) continue;
        if (!/^(a|button|input|label)\[/.test(part.what)) continue;
        const floor = part.what.startsWith('a[') ? 24 : 44;
        expect(
          part.height,
          `${kind} row at ${width}px: ${part.what} is ${part.height}px tall`,
        ).toBeGreaterThanOrEqual(floor - 0.5);
      }
    }

    // iOS zooms the page when a field under 16px is focused: every field on
    // the list is 16px at this width.
    const fontSizes = await page
      .getByTestId('now')
      .locator('input:not([type="checkbox"])')
      .evaluateAll((fields) => fields.map((field) => getComputedStyle(field).fontSize));
    expect(fontSizes.length).toBeGreaterThan(0);
    for (const size of fontSizes) expect(size).toBe('16px');
  }

  // And the row still does its job at this width: a tap on the sentence beside
  // the box ticks the item — the label is the target, not the 16px box.
  const tickRow = page.locator('[data-testid="now-row"][data-input="tick"]');
  const videoId = await tickRow.getAttribute('data-video-id');
  const before = await db.query<{ n: string }>(
    'select count(*) as n from public.checklist_items where video_id = $1 and checked_at is not null',
    [videoId],
  );
  await tickRow.getByText('Tick it and the next item takes its place.').click();
  await expect
    .poll(async () => {
      const after = await db.query<{ n: string }>(
        'select count(*) as n from public.checklist_items where video_id = $1 and checked_at is not null',
        [videoId],
      );
      return Number(after.rows[0].n);
    })
    .toBe(Number(before.rows[0].n) + 1);
  expect(new URL(page.url()).pathname).toBe('/now');
});

/* -------------------------------------------------------------------------- */
/* 4. /capture with the keyboard open                                          */
/* -------------------------------------------------------------------------- */

async function capturedCount(title: string): Promise<number> {
  const result = await db.query<{ n: string }>(
    'select count(*) as n from public.videos where title = $1',
    [title],
  );
  return Number(result.rows[0].n);
}

test('/capture saves with the keyboard open, in one gesture', async ({ page }) => {
  await page.setViewportSize(PHONE_WITH_KEYBOARD);
  await page.goto('/capture');

  const field = page.getByLabel('Idea');
  await expect(field).toBeFocused();

  // One Capture button at this width — the one on the field's own line — and
  // it is inside what the keyboard leaves, without scrolling.
  const save = page.getByRole('button', { name: 'Capture', exact: true });
  await expect(save).toHaveCount(1);
  await expect(save).toHaveAttribute('data-testid', 'capture-submit-inline');
  const box = await save.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE_WITH_KEYBOARD.height);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // 16px, or iOS zooms the page on focus and the layout above is moot.
  await expect(field).toHaveCSS('font-size', '16px');

  // Type, tap: saved.
  const tapped = `${PREFIX} tapped ${Date.now().toString(36)}`;
  await field.fill(tapped);
  await save.click();
  await expect(page.getByText(`Captured “${tapped}”`)).toBeVisible();
  expect(await capturedCount(tapped)).toBe(1);
  // Cleared and focused again for the next one.
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();

  // Type, return key: saved.
  const returned = `${PREFIX} returned ${Date.now().toString(36)}`;
  await page.keyboard.type(returned);
  await page.keyboard.press('Enter');
  await expect(page.getByText(`Captured “${returned}”`)).toBeVisible();
  expect(await capturedCount(returned)).toBe(1);
});

test('the capture dialog from the phone bar also saves with the keyboard open', async ({
  page,
}) => {
  await page.setViewportSize(PHONE_WITH_KEYBOARD);
  await page.goto('/now');
  await expect(
    page.locator('button[aria-keyshortcuts="c"][data-shortcut-ready]'),
  ).toBeVisible();
  await page.locator('button[aria-keyshortcuts="c"]').click();

  const dialog = page.getByRole('dialog', { name: 'Capture an idea' });
  await expect(dialog.getByLabel('Idea')).toBeFocused();
  const save = dialog.getByRole('button', { name: 'Capture', exact: true });
  await expect(save).toHaveCount(1);
  const box = await save.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE_WITH_KEYBOARD.height);

  const title = `${PREFIX} from the bar ${Date.now().toString(36)}`;
  await dialog.getByLabel('Idea').fill(title);
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(await capturedCount(title)).toBe(1);
});

/* -------------------------------------------------------------------------- */
/* 5. The desktop is unchanged                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The sidebar's boxes, as M3 drew them. Measured on the pre-M9 tree at the
 * width where it still drew a sidebar, and identical here: wordmark at 16px
 * from the top, Capture 34px tall at 45, Now 32px tall at 99, all 199px wide
 * inside 12px of padding.
 */
test('the desktop layout is the one M3 signed off, at every desktop width', async ({
  page,
}) => {
  for (const width of [1024, 1280, 1440, 1920]) {
    const height = 900;
    await page.setViewportSize({ width, height });
    await page.goto('/now');
    await expect(page.getByTestId('now')).toHaveAttribute('data-ready', 'true');

    const box = async (locator: Locator) => {
      const found = await locator.boundingBox();
      return found && {
        x: Math.round(found.x),
        y: Math.round(found.y),
        width: Math.round(found.width),
        height: Math.round(found.height),
      };
    };

    // The strip is 224px and runs the full height of the page — at least the
    // viewport, and longer when `/now` is (the ground must not stop at the
    // fold; see `AppSidebar`).
    const strip = await box(page.getByTestId('app-sidebar'));
    expect(strip).toMatchObject({ x: 0, y: 0, width: 224 });
    expect(strip!.height).toBeGreaterThanOrEqual(height);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav).toBeVisible();
    await expect(menuButton(page)).toBeHidden();

    expect(await box(page.getByRole('link', { name: 'NerTube' }))).toEqual({
      x: 12,
      y: 16,
      width: 199,
      height: 17,
    });
    expect(await box(page.locator('button[aria-keyshortcuts="c"]'))).toEqual({
      x: 12,
      y: 45,
      width: 199,
      height: 34,
    });
    expect(await box(nav.getByRole('link', { name: 'Now', exact: true }))).toEqual({
      x: 12,
      y: 99,
      width: 199,
      height: 32,
    });
    // The account block is still pinned to the foot of the sidebar.
    const signOut = await box(nav.getByRole('button', { name: 'Sign out' }));
    expect(height - (signOut!.y + signOut!.height)).toBeLessThanOrEqual(24);

    // The signed-off gutters: 32px where work happens, 40px where prose is read.
    await expect(page.getByTestId('app-main')).toHaveCSS('padding-left', '32px');
    expect(await contentColumn(page)).toBe(width - 224 - 64);
    await page.goto('/calendar');
    await expect(page.getByTestId('app-main')).toHaveCSS('padding-left', '40px');
    expect(await contentColumn(page)).toBe(width - 224 - 80);
  }

  // Between a phone and a laptop the sidebar is already a sidebar, and the
  // gutters step half way: 24 / 32.
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/now');
  expect((await page.getByTestId('app-sidebar').boundingBox())?.width).toBe(224);
  await expect(page.getByTestId('app-main')).toHaveCSS('padding-left', '24px');
  await page.goto('/calendar');
  await expect(page.getByTestId('app-main')).toHaveCSS('padding-left', '32px');
});
