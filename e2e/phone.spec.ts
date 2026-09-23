import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import { addDays, monthKey, monthOf, todayColumn } from '../lib/calendar-dates';
import {
  PG,
  SEED_EMAIL,
  SEED_PASSWORD,
  SEED_TIME_ZONE,
} from '../scripts/dev-stack/shared';
import { untilTaken } from './hydration';

/**
 * M10 — the phone, everywhere, as a touch device.
 *
 * M9 made `/now` and `/capture` good at 390px and walked the rest only far
 * enough to say "usable rather than comfortable". M10 walked every route at
 * 390×844 with `hasTouch` and `isMobile` (so `pointer: coarse` is true and
 * every press is a `tap()`), listed what was broken, and fixed it. This file
 * pins the fixes with measured numbers, one claim per test:
 *
 * 1. **No page scrolls sideways** at 320, 360 or 390, on any signed-in route.
 * 2. **Every control is 44px tall under a thumb**, on every route, except the
 *    two kinds M9 decided on: `/now`'s links to elsewhere (24px, WCAG 2.5.8)
 *    and links inside a sentence.
 * 3. **The `?` sheet opens by touch**, from the phone menu.
 * 4. **The board**: see what is in each stage and move a video on.
 * 5. **The calendar**: see what is scheduled this month and open a day.
 * 6. **The video page**: nothing the person is choosing between is cut off,
 *    the 24-hour note comes before its save, an assist panel's proposals are
 *    on screen when it opens, and Filing is one tap from the top.
 * 7. **The matrix** shows four of eight formats with its pillar column pinned.
 * 8. **The desktop is unchanged** by any of it.
 *
 * The whole week — capture to swap — by touch at 390×844 is
 * `e2e/m9-week.spec.ts`'s second test; this file does not repeat it.
 *
 * ## Dates
 *
 * Every date here is computed in the seed account's zone (`SEED_TIME_ZONE`)
 * by the application's own helper and written as a literal, never by
 * `current_date` (which is the database session's zone, not the account's),
 * and the calendar is opened at an explicit `?month=`, so a run that crosses
 * midnight in any zone draws the same month.
 */

const PHONE = { width: 390, height: 844 };
const CHANNEL = { name: 'M10 Phone', slug: 'm10-phone' };
const PREFIX = 'M10 phone —';

test.use({
  viewport: PHONE,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});

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
  await db.query(
    `delete from public.filming_days f
      where f.notes = $1
        and not exists (select 1 from public.videos v where v.filming_day_id = f.id)`,
    [`${PREFIX} shoot`],
  );
  await db?.end();
});

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).tap();
  await page.waitForURL('**/now');
}

interface Channel {
  id: string;
  user_id: string;
}

async function channelRow(): Promise<Channel | null> {
  const result = await db.query<Channel>(
    'select id, user_id from public.channels where slug = $1',
    [CHANNEL.slug],
  );
  return result.rows[0] ?? null;
}

async function ensureChannel(page: Page): Promise<Channel> {
  const existing = await channelRow();
  if (existing) return existing;
  await page.goto('/c/new');
  await page.getByLabel('Channel name').fill(CHANNEL.name);
  await page.getByRole('button', { name: 'Create channel' }).tap();
  await page.waitForURL(`**/c/${CHANNEL.slug}/board`);
  const created = await channelRow();
  if (!created) throw new Error('the fixture channel was not created');
  return created;
}

/** Today in the account's zone, and the month it is in. */
function calendarDays(): { today: string; other: string; month: string } {
  const today = todayColumn(Date.now(), SEED_TIME_ZONE);
  // A second day in the same month: tomorrow, or yesterday on the last day.
  const tomorrow = addDays(today, 1)!;
  const other = tomorrow.slice(0, 7) === today.slice(0, 7) ? tomorrow : addDays(today, -1)!;
  return { today, other, month: monthKey(monthOf(today)!) };
}

interface Seeded {
  idea: string;
  packaging: string;
  scripting: string;
  publishPrep: string;
  published: string;
  filming: string;
}

const LONG_CANDIDATE =
  'I slept nine hours a night for a month and my focus changed';
const LONG_HOOK = 'Nine hours a night for a month changed one thing, and it was not what I expected';

async function stageId(channel: Channel, kind: string): Promise<string> {
  const stage = await db.query<{ id: string }>(
    'select id from public.stages where channel_id = $1 and kind = $2',
    [channel.id, kind],
  );
  return stage.rows[0].id;
}

/**
 * A week's worth of work in one channel, written the way `move_video` would
 * have left it (the shape `e2e/responsive.spec.ts` seeds), with titles long
 * enough that a phone has to wrap them.
 */
async function seed(channel: Channel): Promise<Seeded> {
  await db.query('delete from public.videos where channel_id = $1', [channel.id]);
  const { today, other } = calendarDays();

  for (const [index, name] of ['money', 'focus', 'health'].entries()) {
    await db.query(
      `insert into public.buckets (user_id, channel_id, axis, name, position)
       select $1, $2, 'vertical', $3::text, $4::int
        where not exists (select 1 from public.buckets
                           where channel_id = $2 and axis = 'vertical' and name = $3::text)`,
      [channel.user_id, channel.id, name, index + 1],
    );
  }

  const insert = async (
    kind: string,
    title: string,
    extra: {
      target?: string;
      publishedAgo?: string;
      checklist?: boolean;
      packaged?: boolean;
      filmingDay?: string;
    } = {},
  ): Promise<string> => {
    const stage = await stageId(channel, kind);
    const packaged = extra.packaged ?? kind !== 'idea';
    const result = await db.query<{ id: string }>(
      `insert into public.videos (
         user_id, channel_id, stage_id, stage_entered_at, title,
         thumbnail_concept, hooks, title_candidates,
         target_publish_date, published_at, youtube_url, filming_day_id,
         checklist_seeded_stages
       ) values (
         $1, $2, $3, now() - interval '3 days', $4,
         $5, $6::jsonb, $7::jsonb,
         $8::date, case when $9::text is null then null else now() - $9::interval end,
         case when $9::text is null then null else 'https://youtu.be/m10phone' end,
         $10, array[$3]::uuid[]
       ) returning id`,
      [
        channel.user_id,
        channel.id,
        stage,
        title,
        packaged ? 'A close-up of the desk, half dark, one number circled' : null,
        JSON.stringify(
          packaged
            ? [{ id: 'h1', text: LONG_HOOK, chosen: true }]
            : [],
        ),
        JSON.stringify(
          kind === 'packaging'
            ? [
                { id: 't1', text: LONG_CANDIDATE, note: '', chosen: false, source: 'manual' },
                { id: 't2', text: 'Nine hours of sleep, one month', note: '', chosen: false, source: 'manual' },
              ]
            : [],
        ),
        extra.target ?? null,
        extra.publishedAgo ?? null,
        extra.filmingDay ?? null,
      ],
    );
    const id = result.rows[0].id;
    if (extra.checklist) {
      await db.query(
        `insert into public.checklist_items (user_id, video_id, channel_id, stage_id, text, position, est_minutes)
         select $1, $2, $3, $4, t.text, t.position, t.est_minutes
           from public.checklist_templates t where t.stage_id = $4`,
        [channel.user_id, id, channel.id, stage],
      );
    }
    return id;
  };

  // A filming day in this month, on a date nothing else in the fixture uses.
  const shoot = await db.query<{ id: string }>(
    `insert into public.filming_days (user_id, on_date, notes)
     values ($1, $2::date, $3)
     on conflict (user_id, on_date) do update set notes = public.filming_days.notes
     returning id`,
    [channel.user_id, other, `${PREFIX} shoot`],
  );

  return {
    idea: await insert('idea', `${PREFIX} an idea with a title long enough to wrap twice on a phone`),
    packaging: await insert(
      'packaging',
      `${PREFIX} nine hours a night for a month changed one thing about focus`,
      { checklist: true, packaged: false },
    ),
    scripting: await (async () => {
      // The Script tab, which the time-zone and script slices built and this
      // walk did not own (M10 integration): a script long enough to scroll.
      const id = await insert('scripting', `${PREFIX} the script, written on a phone`);
      await db.query('update public.videos set script = $2 where id = $1', [
        id,
        `## Hook\n${LONG_HOOK}\n\n## Body\n- one\n- two\n- three\n\n## End screen\n`,
      ]);
      return id;
    })(),
    filming: await insert('filming', `${PREFIX} a week of deep work, filmed at the desk`, {
      target: other,
      filmingDay: shoot.rows[0].id,
    }),
    publishPrep: await insert('publish_prep', `${PREFIX} stop optimising your morning routine, start sleeping`, {
      target: today,
    }),
    published: await insert('published', `${PREFIX} three numbers that tell you if a video worked`, {
      target: today,
      publishedAgo: '30 hours',
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Measuring                                                                   */
/* -------------------------------------------------------------------------- */

async function scrollsSideways(page: Page): Promise<{ scrollWidth: number; clientWidth: number; scrollX: number }> {
  return page.evaluate(() => {
    window.scrollTo(10_000, window.scrollY);
    const measured = {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollX: window.scrollX,
    };
    window.scrollTo(0, window.scrollY);
    return measured;
  });
}

/**
 * Every visible control on the page shorter than 44px, as "what WxH".
 *
 * Controls: links, buttons, fields, and a label that holds its own checkbox
 * (the label is the target then; the box inside it is not measured). Two
 * kinds are allowed below 44 and are measured against their own floor
 * instead, both M9 decisions: a link inside a sentence (WCAG 2.5.8's inline
 * exception), and `/now`'s links to somewhere else from a row (24px).
 */
async function smallControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const selector =
      'a[href], button, input:not([type=hidden]), select, textarea, [role=tab], label:has(> input[type=checkbox])';
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue;
      if (el.closest('[aria-hidden="true"]')) continue;
      // The skip link is parked off-screen until focused.
      if (el.dataset.testid === 'skip-to-main') continue;
      // A checkbox is measured through the label that holds it.
      if (el.matches('input[type=checkbox], input[type=radio]')) {
        const label = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
        if (label && label.getBoundingClientRect().height >= 43.5) continue;
      }
      const name = (el.getAttribute('aria-label') ?? el.innerText ?? el.getAttribute('name') ?? el.tagName)
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 50);
      const size = `${Math.round(box.width)}x${Math.round(box.height)}`;
      const inline =
        el.tagName === 'A' &&
        style.display === 'inline' &&
        (el.parentElement?.innerText.length ?? 0) > (el.innerText.length + 12);
      const nowLink = el.tagName === 'A' && el.closest('[data-testid="now-row"]') !== null;
      if (inline) continue;
      if (nowLink) {
        if (box.height < 23.5) out.push(`${name} ${size} (a /now link, floor 24)`);
        continue;
      }
      if (box.height < 43.5) out.push(`${el.tagName.toLowerCase()} "${name}" ${size}`);
    }
    return out;
  });
}

/**
 * Every visible field whose text is under 16px, as "what size". Below 768px
 * iOS Safari zooms the whole page when a field under 16px takes focus, which
 * is what the design's "16px below 768px" rule is for (M10 review: the script
 * template was 14px while the README said every field was 16).
 */
async function smallFonts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const selector =
      'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select';
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 16) {
        const name = el.dataset.testid ?? el.getAttribute('aria-label') ?? el.getAttribute('name') ?? el.tagName;
        out.push(`${el.tagName.toLowerCase()}[${name}] ${size}px`);
      }
    }
    return out;
  });
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await locator.boundingBox();
  if (!found) throw new Error('no box');
  return found;
}

/** The text is all there: nothing clipped by an ellipsis, a clamp or a field. */
async function notCut(locator: Locator): Promise<{ cutX: boolean; cutY: boolean }> {
  return locator.evaluate((el) => ({
    cutX: el.scrollWidth > el.clientWidth + 1,
    cutY: el.scrollHeight > el.clientHeight + 1,
  }));
}

/* -------------------------------------------------------------------------- */
/* 1 and 2. Sideways scroll and tap targets, on every route                    */
/* -------------------------------------------------------------------------- */

function routes(seeded: Seeded, month: string, day: string): string[] {
  return [
    '/now',
    '/capture',
    `/c/${CHANNEL.slug}/board`,
    `/c/${CHANNEL.slug}/ideas`,
    `/c/${CHANNEL.slug}/ideas?view=matrix`,
    `/calendar?month=${month}`,
    `/calendar?day=${day}`,
    `/videos/${seeded.idea}`,
    `/videos/${seeded.packaging}`,
    `/videos/${seeded.scripting}?section=script`,
    `/videos/${seeded.publishPrep}?section=thumbnails`,
    `/videos/${seeded.filming}?section=schedule`,
    `/videos/${seeded.published}?section=publish`,
    '/settings',
    `/settings/stages/${CHANNEL.slug}`,
    `/settings/checklists/${CHANNEL.slug}`,
    `/settings/buckets/${CHANNEL.slug}`,
    `/settings/channel/${CHANNEL.slug}`,
    '/settings/account',
    '/c/new',
  ];
}

test('no route scrolls sideways at 320, 360 or 390, by touch', async ({ page }) => {
  test.setTimeout(420_000);
  await signIn(page);
  const channel = await ensureChannel(page);
  const seeded = await seed(channel);
  const { month, other } = calendarDays();

  const failures: string[] = [];
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of routes(seeded, month, other)) {
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

test('every control is at least 44px tall under a thumb, on every route', async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);
  const channel = await ensureChannel(page);
  const seeded = await seed(channel);
  const { month, other } = calendarDays();

  const failures: string[] = [];
  for (const route of routes(seeded, month, other)) {
    await page.goto(route);
    await page.waitForLoadState('networkidle');
    for (const small of await smallControls(page)) failures.push(`${route}: ${small}`);
    for (const small of await smallFonts(page)) failures.push(`${route}: font ${small}`);
  }
  // The open menu, too: it is the way to every other page.
  await page.goto('/now');
  await page.getByTestId('sidebar-menu').tap();
  await expect(page.getByTestId('sidebar-drawer')).toBeVisible();
  for (const small of await smallControls(page)) failures.push(`menu: ${small}`);

  expect(failures, 'controls under 44px').toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* 3. The `?` sheet, by touch                                                  */
/* -------------------------------------------------------------------------- */

test('the keyboard sheet opens from the phone menu by touch, and gives focus back', async ({
  page,
}) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  await seed(channel);
  await page.goto(`/c/${CHANNEL.slug}/board`);
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');

  await page.getByTestId('sidebar-menu').tap();
  const entry = page.getByTestId('menu-shortcut-sheet');
  await expect(entry).toBeVisible();
  expect((await box(entry)).height).toBeGreaterThanOrEqual(44);
  await entry.tap();

  // One modal at a time: the menu closes, the sheet opens over the page.
  const sheet = page.getByTestId('shortcut-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('sidebar-drawer')).toHaveCount(0);
  // It lists the page's own keys — read after the menu let go of the page.
  await expect(sheet.getByText('On the board', { exact: true })).toBeVisible();

  // A touchscreen has no Escape; the close button says "Close" and is a
  // thumb's size.
  const close = sheet.getByRole('button', { name: 'Close' });
  expect((await box(close)).height).toBeGreaterThanOrEqual(44);
  await close.tap();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('sidebar-menu')).toBeFocused();
});

/* -------------------------------------------------------------------------- */
/* 4. The board: what is in each stage, and moving a video on                  */
/* -------------------------------------------------------------------------- */

test('the board: every stage is one tap away, a card reads whole, and a tap moves it', async ({
  page,
}) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  const seeded = await seed(channel);
  await page.goto(`/c/${CHANNEL.slug}/board`);
  const board = page.getByTestId('board');
  await expect(board).toHaveAttribute('data-ready', 'true');

  // Every stage, in board order, with its count.
  const jumps = page.getByTestId('stage-jump-button');
  const columns = page.getByTestId('board-column');
  await expect(jumps).toHaveCount(await columns.count());
  for (const jump of await jumps.all()) {
    expect((await box(jump)).height).toBeGreaterThanOrEqual(44);
  }

  // A column is nearly the screen: 390 − 64 = 326px, where M9's was 216.
  const prep = page.locator('[data-testid="board-column"][data-stage-name="Publish Prep"]');
  expect(Math.round((await box(prep)).width)).toBe(326);

  // Tap a stage: its column comes to the strip's left edge and is marked.
  await untilTaken(
    () => jumps.filter({ hasText: 'Publish Prep' }).tap(),
    () =>
      expect(jumps.filter({ hasText: 'Publish Prep' })).toHaveAttribute('aria-current', 'true', {
        timeout: 2_000,
      }),
  );
  await expect
    .poll(async () => Math.round((await box(prep)).x - (await box(board)).x))
    .toBe(0);
  await expect(prep).toBeInViewport({ ratio: 0.9 });

  // The card's title is all there — no three-line clamp of two words a line.
  const card = prep.locator(`[data-testid="board-card"][data-video-id="${seeded.publishPrep}"]`);
  const title = card.getByRole('link').first();
  expect(await notCut(title)).toEqual({ cutX: false, cutY: false });

  // And the arrow a thumb moves it on with is 44px and works.
  const forward = card.getByRole('button', { name: /forward/i });
  expect((await box(forward)).height).toBeGreaterThanOrEqual(44);
  await forward.tap();
  const scheduled = page.locator('[data-testid="board-column"][data-stage-name="Scheduled"]');
  await expect(
    scheduled.locator(`[data-testid="board-card"][data-video-id="${seeded.publishPrep}"]`),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const moved = await db.query<{ kind: string }>(
        `select s.kind from public.videos v join public.stages s on s.id = v.stage_id where v.id = $1`,
        [seeded.publishPrep],
      );
      return moved.rows[0].kind;
    })
    .toBe('scheduled');

  // Nothing about the page scrolls sideways while the strip does.
  const measured = await scrollsSideways(page);
  expect(measured.scrollWidth).toBe(measured.clientWidth);
});

/* -------------------------------------------------------------------------- */
/* 5. The calendar: what is on this month, and opening a day                   */
/* -------------------------------------------------------------------------- */

test('the calendar is a list of days on a phone, with whole titles, and a date opens its day', async ({
  page,
}) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  await seed(channel);
  const { month, other } = calendarDays();
  await page.goto(`/calendar?month=${month}`);

  // The header row is gone; every listed day is a full-width row.
  await expect(page.locator('[data-testid="calendar-grid"] thead')).toBeHidden();
  const day = page.locator(`[data-testid="calendar-day"][data-date="${other}"]`);
  await expect(day).toBeVisible();
  // The width of the column, less the table's own 1px edges — not a 51px
  // seventh of it.
  const row = await box(day);
  expect(row.width).toBeGreaterThan(340);

  // A day with nothing on it (and not today) is not listed.
  const empty = page.locator('[data-testid="calendar-day"][data-in-month="true"][data-events="0"]:not([data-today])');
  for (const cell of await empty.all()) await expect(cell).toBeHidden();

  // Every chip is a 44px row whose title is all there.
  const chips = page.locator('[data-testid="calendar-chip"]:visible');
  expect(await chips.count()).toBeGreaterThanOrEqual(3);
  for (const chip of await chips.all()) {
    expect((await box(chip)).height).toBeGreaterThanOrEqual(44);
    const title = chip.locator('span.font-display');
    if ((await title.count()) > 0) expect(await notCut(title)).toEqual({ cutX: false, cutY: false });
  }

  // The date opens the day, and the panel comes to the screen.
  const open = day.getByTestId('calendar-day-open');
  const openBox = await box(open);
  expect(openBox.height).toBeGreaterThanOrEqual(44);
  expect(openBox.width).toBeGreaterThanOrEqual(44);
  await open.tap();
  await page.waitForURL((url) => url.searchParams.get('day') === other);
  const panel = page.getByTestId('calendar-day-panel');
  await expect(panel).toHaveAttribute('data-date', other);
  await expect(panel).toBeInViewport();
  await expect(panel.getByTestId('calendar-filming-day-panel')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* 6. The video page                                                           */
/* -------------------------------------------------------------------------- */

test('the video page: sentences and candidates read whole, Filing is one tap away', async ({
  page,
}) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  const seeded = await seed(channel);

  // The checklist strip's sentence has a line of its own and is not cut.
  await page.goto(`/videos/${seeded.idea}`);
  const none = page.getByTestId('checklist-next');
  await expect(none).toHaveText(/has no checklist on this video\./);
  expect(await notCut(none)).toEqual({ cutX: false, cutY: false });

  await page.goto(`/videos/${seeded.packaging}`);
  const next = page.getByTestId('checklist-next');
  await expect(next).toContainText('Generated 10–20 title candidates, not 3');
  expect(await notCut(next)).toEqual({ cutX: false, cutY: false });

  // A title candidate is read in full before it is chosen: its box is the
  // row's width and holds the whole title.
  const candidate = page.getByTestId('candidate-text').first();
  await expect(candidate).toHaveValue(LONG_CANDIDATE);
  expect((await box(candidate)).width).toBeGreaterThan(300);
  expect(await notCut(candidate)).toEqual({ cutX: false, cutY: false });
  // Its buttons sit under it, still 44px.
  const choose = page.getByTestId('candidate-choose').first();
  expect((await box(choose)).y).toBeGreaterThan((await box(candidate)).y);
  expect((await box(choose)).height).toBeGreaterThanOrEqual(44);

  // Filing is one tap from the top of the tab.
  const jump = page.getByTestId('packaging-jump').getByRole('link', { name: /Filing/ });
  expect((await box(jump)).height).toBeGreaterThanOrEqual(44);
  await jump.tap();
  await expect(page.getByTestId('filing-block')).toBeInViewport();
});

test('the video page: an assist panel opens with its proposals on screen', async ({ page }) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  const seeded = await seed(channel);
  await db.query('update public.videos set brainstorm_last = null where id = $1', [seeded.packaging]);
  await page.goto(`/videos/${seeded.packaging}`);

  const pill = page.getByRole('button', { name: 'Generate 20', exact: true });
  await pill.scrollIntoViewIfNeeded();
  await untilTaken(
    () => pill.tap(),
    () => expect(page.getByTestId('brainstorm-panel')).toBeVisible({ timeout: 2_000 }),
  );
  const first = page.getByTestId('brainstorm-suggestion').first();
  await expect(first).toBeVisible();
  // M9 measured the first proposal at y 873 on an 844 screen. The panel's
  // heading now goes to the top, under the 57px bar.
  const heading = await box(page.locator('#brainstorm-heading'));
  expect(heading.y).toBeGreaterThanOrEqual(57);
  expect(heading.y).toBeLessThan(140);
  await expect(first).toBeInViewport();
});

test('the video page: the 24-hour note comes before its save', async ({ page }) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  const seeded = await seed(channel);
  await page.goto(`/videos/${seeded.published}?section=publish`);

  const pair = page.getByTestId('metrics-pair');
  const note = pair.getByTestId('metrics-new-viewers');
  const save = pair.getByTestId('metrics-save');
  await expect(note).toBeVisible();
  const views = await box(pair.getByTestId('metrics-views'));
  const noteBox = await box(note);
  const saveBox = await box(save);
  // Top to bottom: the numbers, the note, then the button that logs them.
  expect(noteBox.y).toBeGreaterThan(views.y);
  expect(saveBox.y).toBeGreaterThan(noteBox.y + noteBox.height - 1);
  expect(saveBox.height).toBeGreaterThanOrEqual(44);

  // And it still logs, by touch, with the note.
  await pair.getByTestId('metrics-impressions').fill('4200');
  await pair.getByTestId('metrics-ctr').fill('5.1');
  await pair.getByTestId('metrics-views').fill('610');
  await note.fill('About half were new.');
  await save.tap();
  await expect
    .poll(async () => {
      const row = await db.query<{ impressions: number | null; note: string | null }>(
        'select first24_impressions as impressions, new_viewers_note as note from public.videos where id = $1',
        [seeded.published],
      );
      return row.rows[0];
    })
    .toEqual({ impressions: 4200, note: 'About half were new.' });
});

/* -------------------------------------------------------------------------- */
/* 7. The matrix                                                               */
/* -------------------------------------------------------------------------- */

test('the matrix shows four formats at once with the pillar column pinned', async ({ page }) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  await seed(channel);
  await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix`);

  const grid = page.getByTestId('matrix-grid');
  await expect(grid).toBeVisible();
  const columns = page.getByTestId('matrix-column');
  let whole = 0;
  for (const column of await columns.all()) {
    const found = await box(column);
    if (found.x >= 0 && found.x + found.width <= PHONE.width) whole += 1;
  }
  // M9 measured two of eight.
  expect(whole).toBeGreaterThanOrEqual(4);

  // Scroll the grid all the way: the pillar names stay where they were.
  const pillar = page.getByTestId('matrix-row').first();
  const before = await box(pillar);
  await grid.evaluate((table) => {
    const scroller = table.parentElement!;
    scroller.scrollLeft = scroller.scrollWidth;
  });
  const after = await box(pillar);
  expect(Math.round(after.x)).toBe(Math.round(before.x));
});

/* -------------------------------------------------------------------------- */
/* 9. The M10 review                                                           */
/* -------------------------------------------------------------------------- */

/** The toast's controls and its box, measured. */
async function toastMeasure(page: Page) {
  const toast = page.getByTestId('toast').last();
  await expect(toast).toBeVisible();
  const controls = await toast.evaluate((el) =>
    Array.from(el.querySelectorAll<HTMLElement>('a[href], button')).map((control) => {
      const rect = control.getBoundingClientRect();
      return `${(control.innerText || control.getAttribute('aria-label') || '').trim()} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
    }),
  );
  const small = controls.filter((c) => Number(c.split('x').pop()) < 44);
  const outer = await box(toast);
  const message = await box(toast.locator('p').first());
  return { small, outer, message };
}

test('a toast is usable by thumb: its sentence has a line, its controls are 44px', async ({
  page,
}) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  const seeded = await seed(channel);

  for (const size of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);

    // The gate's refusal on the board: the one toast that is the only way on.
    await seed(channel);
    await page.goto(`/c/${CHANNEL.slug}/board`);
    await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
    await page.locator('[data-testid="stage-jump-button"][data-stage-name^="Packaging"]').tap();
    const card = page
      .getByTestId('board-card')
      .filter({ hasText: 'nine hours a night for a month changed one thing' });
    await card.locator('[data-move="forward"]').tap();
    const refusal = await toastMeasure(page);
    expect(refusal.small, `refusal toast at ${size.width}`).toEqual([]);
    expect(refusal.outer.y + refusal.outer.height).toBeLessThanOrEqual(size.height);
    // The sentence is not squeezed beside the links: it has the toast's width.
    expect(refusal.message.width).toBeGreaterThan(refusal.outer.width - 40);
    await page.getByTestId('toast-dismiss').last().tap();

    // A confirmation: promoting an idea from the bank.
    await page.goto(`/c/${CHANNEL.slug}/ideas`);
    await page.getByTestId('idea-promote').first().tap();
    const promoted = await toastMeasure(page);
    expect(promoted.small, `promote toast at ${size.width}`).toEqual([]);
  }
  expect(seeded.idea).toBeTruthy();
});

test('the swap prompt’s actions are 44px by touch', async ({ page }) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  const seeded = await seed(channel);
  await db.query(
    `update public.videos
        set first24_impressions = 8200, first24_ctr = 2.4, first24_views = 190,
            metrics_logged_at = now()
      where id = $1`,
    [seeded.published],
  );
  for (const size of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(`/videos/${seeded.published}?section=publish`);
    for (const id of ['swap-prompt-open', 'swap-prompt-keep']) {
      const found = await box(page.getByTestId(id));
      expect(found.height, `${id} at ${size.width}`).toBeGreaterThanOrEqual(44);
    }
  }
});

test('twenty candidates fold on a phone, and the concept is one tap away', async ({ page }) => {
  await signIn(page);
  const channel = await ensureChannel(page);
  const seeded = await seed(channel);
  const twenty = Array.from({ length: 20 }, (_, i) => ({
    id: `c${i}`,
    text: `Candidate ${i + 1}: a title long enough to wrap onto a second line here`,
    note: 'Widens past the topic, so it reaches people who have never heard of the idea',
    chosen: false,
    source: 'manual',
  }));
  await db.query('update public.videos set title_candidates = $2::jsonb where id = $1', [
    seeded.packaging,
    JSON.stringify(twenty),
  ]);

  await page.goto(`/videos/${seeded.packaging}`);
  const rows = page.getByTestId('candidate-row');
  await expect(rows).toHaveCount(20);
  await expect(page.locator('[data-testid="candidate-row"]:visible')).toHaveCount(5);

  // The note reads whole: it wraps rather than scrolling inside one line.
  const note = page.getByTestId('candidate-note').first();
  const cut = await notCut(note);
  expect(cut.cutX).toBe(false);

  // The concept is under the folded list, not five screens down, and a tap
  // on the jump row reaches it.
  const concept = await box(page.getByTestId('thumbnail-concept'));
  const list = await box(page.getByTestId('candidate-list'));
  expect(concept.y - list.y).toBeLessThan(2000);
  await page.getByRole('link', { name: 'Concept ↓' }).tap();
  await expect(page.getByTestId('thumbnail-concept')).toBeInViewport();

  // Every row is still one tap away.
  await page.getByTestId('candidate-show-all').tap();
  await expect(page.locator('[data-testid="candidate-row"]:visible')).toHaveCount(20);
});

test.describe('a phone held sideways', () => {
  test.use({ viewport: { width: 844, height: 390 } });

  test('every control is 44px and every field 16px under a thumb in landscape', async ({ page }) => {
    test.setTimeout(300_000);
    await signIn(page);
    const channel = await ensureChannel(page);
    const seeded = await seed(channel);
    const { month, other } = calendarDays();
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

    const failures: string[] = [];
    for (const route of routes(seeded, month, other)) {
      await page.goto(route);
      await page.waitForLoadState('networkidle');
      for (const small of await smallControls(page)) failures.push(`${route}: ${small}`);
      for (const small of await smallFonts(page)) failures.push(`${route}: font ${small}`);
    }
    expect(failures, 'controls under 44px, or fields under 16px, in landscape').toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 8. The desktop, unchanged                                                   */
/* -------------------------------------------------------------------------- */

test.describe('at desktop widths', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1280, height: 900 } });

  test('none of the phone layouts leaks onto a desktop', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(SEED_EMAIL);
    await page.getByLabel('Password').fill(SEED_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/now');
    const channel = await ensureChannel(page);
    const seeded = await seed(channel);
    const { month } = calendarDays();

    for (const width of [1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });

      // The board: 216px columns, no stage row.
      await page.goto(`/c/${CHANNEL.slug}/board`);
      await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
      await expect(page.getByTestId('stage-jump')).toBeHidden();
      expect(Math.round((await box(page.getByTestId('board-column').first())).width)).toBe(216);

      // The calendar: a seven-column table, no date buttons.
      await page.goto(`/calendar?month=${month}`);
      await expect(page.locator('[data-testid="calendar-grid"] thead')).toBeVisible();
      await expect(page.getByTestId('calendar-day-open').first()).toBeHidden();
      const cells = page.locator('[data-testid="calendar-day"]');
      const first = await box(cells.nth(0));
      const second = await box(cells.nth(1));
      expect(Math.round(second.y)).toBe(Math.round(first.y));
      expect(first.height).toBeGreaterThanOrEqual(112);

      // The video page: no jump row, and the candidate row keeps its buttons
      // beside the text.
      await page.goto(`/videos/${seeded.packaging}`);
      await expect(page.getByTestId('packaging-jump')).toBeHidden();
      const candidate = await box(page.getByTestId('candidate-text').first());
      const choose = await box(page.getByTestId('candidate-choose').first());
      expect(choose.x).toBeGreaterThan(candidate.x + candidate.width - 1);

      // The matrix: the 172px pillar corner.
      await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix`);
      const corner = page.locator('[data-testid="matrix-grid"] thead td').first();
      expect(Math.round((await box(corner)).width)).toBeGreaterThanOrEqual(150);
    }
  });
});
