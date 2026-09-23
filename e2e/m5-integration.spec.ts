import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/**
 * M5's seams, walked in a browser.
 *
 * `e2e/ideas.spec.ts` covers the bank on its own and `e2e/matrix.spec.ts`
 * covers the grid on its own. This file is about the places the two touch, and
 * about PLAN.md's M5 acceptance line — *"matrix renders, promote lands in
 * Packaging"* — walked end to end in one session:
 *
 * 1. **The sidebar's Ideas entry** is a real navigation target with the bank's
 *    own number on it, operable from the keyboard. M3's review filed that row
 *    as unreachable by keyboard and explained only by a tooltip; this is the
 *    assertion that says it is not any more.
 * 2. **A filtered bank is an address.** The filters live in the query string,
 *    so a narrowed bank survives a reload and can be sent to somebody.
 * 3. **The cell and the bank cannot disagree.** The matrix counts every stage
 *    and the bank lists the Idea stage, which is a difference of scope, not of
 *    membership — so the cell says how many of its videos are still in the
 *    bank and links to exactly those, and this checks all three numbers against
 *    the database.
 * 4. **The acceptance walk.** Grid → empty cell → prefilled capture → the row
 *    it wrote → promote → Packaging, each step read back from Postgres.
 *
 * The fixture is SQL (pillars cannot be created in the product until M7) and
 * every action is a click or a keystroke.
 */

const CHANNEL = { name: 'M5 Integration', slug: 'm5-integration' };

/** The two pillars the fixture gives the channel, in position order. */
const PILLARS = ['money', 'craft'] as const;

const TITLES = {
  sinking: 'Sinking funds, properly',
  index: 'Index funds, slowly',
  spreadsheet: 'The budget spreadsheet itself',
  payCheque: 'My first pay cheque, on camera',
  appReview: 'This budgeting app, honestly',
  craftTutorial: 'Sharpening a plane iron',
  unfiled: 'A money thought with no format',
  shelved: 'An abandoned money tutorial',
} as const;

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

async function bucketId(
  channelId: string,
  axis: 'vertical' | 'horizontal',
  name: string,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    'select id from public.buckets where channel_id = $1 and axis = $2 and name = $3',
    [channelId, axis, name],
  );
  if (!result.rows[0]) throw new Error(`no ${axis} bucket "${name}" on that channel`);
  return result.rows[0].id;
}

async function stageIdFor(channelId: string, kind: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    'select id from public.stages where channel_id = $1 and kind = $2',
    [channelId, kind],
  );
  if (!result.rows[0]) throw new Error(`no ${kind} stage on that channel`);
  return result.rows[0].id;
}

/** The stage `kind` one video is actually in, straight from the database. */
async function kindOf(title: string): Promise<string | null> {
  const result = await db.query<{ kind: string | null }>(
    `select s.kind from public.videos v
       join public.stages s on s.id = v.stage_id
      where v.title = $1 and v.channel_id = $2`,
    [title, channel.id],
  );
  return result.rows[0]?.kind ?? null;
}

interface SeedVideo {
  title: string;
  vertical?: string;
  horizontal?: string;
  /** Stage kind. Defaults to `idea`, which is what a capture produces. */
  kind?: string;
  publishedAgo?: string;
  archived?: boolean;
}

async function seedVideos(
  target: { id: string; user_id: string },
  videos: readonly SeedVideo[],
): Promise<void> {
  for (const video of videos) {
    const stageId = await stageIdFor(target.id, video.kind ?? 'idea');
    await db.query(
      `insert into public.videos (
         user_id, channel_id, stage_id, title,
         vertical_id, horizontal_id, published_at, archived_at
       ) values (
         $1, $2, $3, $4,
         case when $5::text is null then null else
           (select id from public.buckets
             where channel_id = $2 and axis = 'vertical' and name = $5) end,
         case when $6::text is null then null else
           (select id from public.buckets
             where channel_id = $2 and axis = 'horizontal' and name = $6) end,
         case when $7::text is null then null else now() - $7::interval end,
         case when $8::boolean then now() else null end
       )`,
      [
        target.user_id,
        target.id,
        stageId,
        video.title,
        video.vertical ?? null,
        video.horizontal ?? null,
        video.publishedAgo ?? null,
        video.archived ?? false,
      ],
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Browser helpers                                                             */
/* -------------------------------------------------------------------------- */

async function signIn(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}

async function createChannel(page: Page): Promise<void> {
  await page.goto('/c/new');
  await page.getByLabel('Channel name').fill(CHANNEL.name);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.waitForURL(`**/c/${CHANNEL.slug}/board`);
}

/** The whole tree has hydrated: the app's own signal, used across this suite. */
async function hydrated(page: Page): Promise<void> {
  await expect(
    page.locator('button[aria-keyshortcuts="c"][data-shortcut-ready="true"]'),
  ).toBeVisible();
}

/** Open the bank and wait for it to be able to take a keystroke. */
async function openBank(page: Page, query = ''): Promise<void> {
  await page.goto(`/c/${CHANNEL.slug}/ideas${query}`);
  await expect(page.getByTestId('idea-bank')).toHaveAttribute(
    'data-ready',
    'true',
  );
}

const rows = (page: Page) => page.getByTestId('idea-row');

async function titles(page: Page): Promise<string[]> {
  return rows(page).getByTestId('idea-open').allInnerTexts();
}

function cell(page: Page, vertical: string, horizontal: string) {
  return page.locator(
    `[data-testid="matrix-cell"][data-vertical="${vertical}"][data-horizontal="${horizontal}"]`,
  );
}

/* -------------------------------------------------------------------------- */
/* Setup                                                                       */
/* -------------------------------------------------------------------------- */

let channel: { id: string; user_id: string };

test.beforeEach(async ({ page }) => {
  await signIn(page);
  if ((await channelRow()) === null) await createChannel(page);

  const found = await channelRow();
  if (!found) throw new Error('the fixture channel is missing');
  channel = found;

  // Start from nothing every time: the acceptance walk adds a row and promotes
  // another, and a count assertion that depended on test order is worthless.
  await db.query('delete from public.videos where channel_id = $1', [channel.id]);
  await db.query(
    "delete from public.buckets where channel_id = $1 and axis = 'vertical'",
    [channel.id],
  );

  for (const [index, name] of PILLARS.entries()) {
    await db.query(
      `insert into public.buckets (user_id, channel_id, axis, name, position)
       values ($1, $2, 'vertical', $3, $4)`,
      [channel.user_id, channel.id, name, index + 1],
    );
  }

  /*
    money · tutorial is the cell the seams are tested on, and it holds one of
    everything: two ideas, one video that has moved on, one that has shipped,
    and one that was shelved. The cell's count, the number still in the bank and
    the number published are therefore three different numbers — which is the
    only situation in which "the two pages agree" means anything.
  */
  await seedVideos(channel, [
    { title: TITLES.sinking, vertical: 'money', horizontal: 'tutorial' },
    { title: TITLES.index, vertical: 'money', horizontal: 'tutorial' },
    {
      title: TITLES.spreadsheet,
      vertical: 'money',
      horizontal: 'tutorial',
      kind: 'packaging',
    },
    {
      title: TITLES.payCheque,
      vertical: 'money',
      horizontal: 'tutorial',
      kind: 'published',
      publishedAgo: '20 days',
    },
    {
      title: TITLES.shelved,
      vertical: 'money',
      horizontal: 'tutorial',
      archived: true,
    },
    { title: TITLES.appReview, vertical: 'money', horizontal: 'review' },
    { title: TITLES.craftTutorial, vertical: 'craft', horizontal: 'tutorial' },
    { title: TITLES.unfiled, vertical: 'money' },
  ]);
});

/* -------------------------------------------------------------------------- */
/* 1. The sidebar entry M3's review filed as unreachable                       */
/* -------------------------------------------------------------------------- */

test('the sidebar’s Ideas entry is a keyboard-operable link carrying the bank’s own count', async ({
  page,
}) => {
  await page.goto(`/c/${CHANNEL.slug}/board`);

  const sidebar = page.getByTestId('app-sidebar');
  const link = sidebar.getByRole('link', { name: 'Ideas', exact: true });

  // A link, not an `aria-disabled` button with an explanation in a tooltip.
  await expect(link).toHaveAttribute('href', `/c/${CHANNEL.slug}/ideas`);

  /*
    The count is the live bank: five idea-stage rows that are not archived.
    Asked of the database the way `lib/ideas-data.ts` claims to ask it, so the
    badge is checked against the definition and not against itself.
  */
  const expected = await db.query<{ n: string }>(
    `select count(*)::text as n from public.videos v
       join public.stages s on s.id = v.stage_id
      where v.channel_id = $1 and s.kind = 'idea' and v.archived_at is null`,
    [channel.id],
  );
  expect(expected.rows[0].n).toBe('5');
  await expect(sidebar.getByTestId('sidebar-ideas-count')).toHaveAttribute(
    'data-count',
    '5',
  );

  // The chip is `aria-hidden`, so the link is still called "Ideas" and the
  // number reaches a screen reader as the link's description instead.
  await expect(link).toHaveAttribute('title', /5 ideas/);

  // Reachable and operable from the keyboard, which is the whole of the M3
  // finding: focus it and press Enter.
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForURL(`**/c/${CHANNEL.slug}/ideas`);

  // And the page it opened counts the same five.
  await expect(page.getByTestId('idea-bank')).toHaveAttribute('data-ready', 'true');
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByTestId('idea-summary')).toContainText('5 of 5');

  // On the bank, the row is the current page — the third signal, after the
  // marker bar and the surface, and the one assistive technology reads.
  await expect(
    page.getByTestId('app-sidebar').getByRole('link', { name: 'Ideas', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});

/* -------------------------------------------------------------------------- */
/* 2. A filtered bank is an address                                            */
/* -------------------------------------------------------------------------- */

test('the bank’s filters live in the URL, so a narrowed bank survives a reload', async ({
  page,
}) => {
  await openBank(page);
  await expect(rows(page)).toHaveCount(5);

  const money = await bucketId(channel.id, 'vertical', 'money');

  // Narrow it the way a person does.
  await page.getByTestId('idea-vertical-filter').selectOption(money);
  await expect(rows(page)).toHaveCount(4);

  // The address bar followed, without a navigation.
  await expect(page).toHaveURL(new RegExp(`vertical=${money}`));

  // Reload: the filter is still on, because it was in the URL and not in a
  // component's memory.
  await page.reload();
  await expect(page.getByTestId('idea-bank')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('idea-vertical-filter')).toHaveValue(money);
  await expect(rows(page)).toHaveCount(4);

  // Search combines with it, and clearing everything empties the query string
  // again — an unfiltered bank is a bare URL, so a URL with anything on it is
  // a URL that is filtering.
  await page.getByTestId('idea-search').fill('sinking');
  await expect(rows(page)).toHaveCount(1);
  await expect(page).toHaveURL(/q=sinking/);

  await page.getByTestId('idea-search').fill('');
  await page.getByTestId('idea-vertical-filter').selectOption('');
  await expect(rows(page)).toHaveCount(5);
  await expect(page).toHaveURL(`/c/${CHANNEL.slug}/ideas`);

  // A link somebody was sent: two filters at once, applied on arrival.
  const tutorial = await bucketId(channel.id, 'horizontal', 'tutorial');
  await openBank(page, `?vertical=${money}&horizontal=${tutorial}`);
  expect((await titles(page)).sort()).toEqual([TITLES.index, TITLES.sinking].sort());

  // A bucket id this channel does not have is dropped rather than becoming a
  // filter that matches nothing and cannot explain itself.
  await openBank(page, '?vertical=99999999-9999-4999-8999-999999999999');
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByTestId('idea-vertical-filter')).toHaveValue('');
});

/* -------------------------------------------------------------------------- */
/* 3. The cell and the bank cannot disagree                                    */
/* -------------------------------------------------------------------------- */

test('a cell says how much of it is still in the bank, and links to exactly those rows', async ({
  page,
}) => {
  const money = await bucketId(channel.id, 'vertical', 'money');
  const tutorial = await bucketId(channel.id, 'horizontal', 'tutorial');

  // The three numbers, asked of the database the way each page claims to ask.
  const onGrid = await db.query(
    `select 1 from public.videos
      where channel_id = $1 and vertical_id = $2 and horizontal_id = $3
        and archived_at is null`,
    [channel.id, money, tutorial],
  );
  const inBank = await db.query<{ title: string }>(
    `select v.title from public.videos v
       join public.stages s on s.id = v.stage_id
      where v.channel_id = $1 and v.vertical_id = $2 and v.horizontal_id = $3
        and v.archived_at is null and s.kind = 'idea'
      order by v.title`,
    [channel.id, money, tutorial],
  );
  expect(onGrid.rowCount).toBe(4);
  expect(inBank.rowCount).toBe(2);

  await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix`);

  const target = cell(page, 'money', 'tutorial');
  await expect(target).toHaveAttribute('data-count', '4');
  await target.click();

  const panel = page.getByTestId('matrix-cell-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-count', '4');

  // The cell's number is larger than the bank's, on purpose — so the panel says
  // the bank's number itself rather than leaving it to look like a bug.
  const bankLink = panel.getByTestId('cell-bank-link');
  await expect(bankLink).toHaveAttribute('data-in-bank', '2');
  await expect(bankLink).toHaveAttribute(
    'href',
    `/c/${CHANNEL.slug}/ideas?vertical=${money}&horizontal=${tutorial}`,
  );

  // And following it lands on exactly those two rows.
  await bankLink.click();
  await expect(page.getByTestId('idea-bank')).toHaveAttribute('data-ready', 'true');
  expect((await titles(page)).sort()).toEqual(
    inBank.rows.map((row) => row.title).sort(),
  );

  // A cell whose videos have all left the bank says so instead of offering a
  // link to an empty list. `craft · tutorial` is not that cell, so make one:
  // move its only idea on, and the panel changes its sentence.
  await db.query(
    `update public.videos set stage_id = $1 where channel_id = $2 and title = $3`,
    [await stageIdFor(channel.id, 'published'), channel.id, TITLES.craftTutorial],
  );
  const craft = await bucketId(channel.id, 'vertical', 'craft');
  await page.goto(
    `/c/${CHANNEL.slug}/ideas?view=matrix&cell=${craft}%3A${tutorial}`,
  );
  const craftPanel = page.getByTestId('matrix-cell-panel');
  await expect(craftPanel).toHaveAttribute('data-count', '1');
  await expect(craftPanel.getByTestId('cell-bank-none')).toBeVisible();
  await expect(craftPanel.getByTestId('cell-bank-link')).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* 4. PLAN.md's M5 acceptance, walked                                          */
/* -------------------------------------------------------------------------- */

test('the matrix renders, an empty cell prefills capture, and promote lands in Packaging', async ({
  page,
}) => {
  /* --- the matrix renders --------------------------------------------- */

  await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix`);
  await hydrated(page);

  const grid = page.getByTestId('matrix-grid');
  await expect(grid).toBeVisible();
  await expect(grid).toHaveAttribute('data-verticals', '2');
  await expect(grid).toHaveAttribute('data-horizontals', '8');
  await expect(page.getByTestId('matrix-cell')).toHaveCount(16);

  // One switch, two views, and the switch is two real links.
  const backToList = page
    .getByTestId('ideas-view-switch')
    .getByRole('link', { name: 'List' });
  await expect(backToList).toHaveAttribute('href', `/c/${CHANNEL.slug}/ideas`);

  /* --- an empty cell prefills capture ---------------------------------- */

  const craft = await bucketId(channel.id, 'vertical', 'craft');
  const interview = await bucketId(channel.id, 'horizontal', 'interview');

  const empty = cell(page, 'craft', 'interview');
  await expect(empty).toHaveAttribute('data-empty', 'true');
  const href = await empty.getAttribute('href');
  expect(href).toContain(`vertical=${craft}`);
  expect(href).toContain(`horizontal=${interview}`);

  await empty.click();
  const dialog = page.getByTestId('matrix-capture');
  await expect(dialog).toBeVisible();

  const captured = 'The interview I keep not asking for';
  await dialog.getByRole('textbox', { name: 'Idea' }).fill(captured);
  await dialog.getByRole('textbox', { name: 'Idea' }).press('Enter');

  // The row it wrote really carries both buckets, and it is in the Idea stage:
  // `capture_video` is the only path a client has to create a video at all.
  await expect
    .poll(async () => {
      const result = await db.query<{
        vertical_id: string | null;
        horizontal_id: string | null;
      }>(
        'select vertical_id, horizontal_id from public.videos where title = $1 and channel_id = $2',
        [captured, channel.id],
      );
      return result.rows[0] ?? null;
    })
    .toEqual({ vertical_id: craft, horizontal_id: interview });
  expect(await kindOf(captured)).toBe('idea');

  // The grid it came from now counts it.
  await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix`);
  await expect(cell(page, 'craft', 'interview')).toHaveAttribute('data-count', '1');

  /* --- promote lands in Packaging -------------------------------------- */

  await openBank(page);
  await hydrated(page);

  // Through the keyboard, which is the shortcut PLAN.md names for this: `j`
  // selects, `p` promotes, both registered through `lib/shortcuts.ts`.
  await page.keyboard.press('j');
  const selected = rows(page).first();
  await expect(selected).toHaveAttribute('data-selected', 'true');
  const promotedTitle = (await selected.getByTestId('idea-open').innerText()).trim();

  expect(await kindOf(promotedTitle)).toBe('idea');
  await page.keyboard.press('p');

  // The database is the claim, not the disappearing row.
  await expect.poll(() => kindOf(promotedTitle)).toBe('packaging');

  // And the bank has one fewer, without a reload being needed to notice.
  await expect(rows(page).filter({ hasText: promotedTitle })).toHaveCount(0);
});
