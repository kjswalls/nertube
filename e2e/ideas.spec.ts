import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

import { untilTaken } from './hydration';

/**
 * `/c/[slug]/ideas` — the idea bank, walked in a browser.
 *
 * BRIEF.md puts this at the front of the pipeline: *capture must stay cheap,
 * and the bank is where an idea waits until it earns promotion*. The board
 * deliberately caps its Idea column at ten and counts the rest, so until this
 * milestone the count was a number with nowhere to go. Everything below is
 * about the page that number now opens.
 *
 * ## What is a fixture and what is a click
 *
 * The *state* — eleven ideas with particular tags, buckets and capture times,
 * plus one video that is deliberately not an idea — is written directly as the
 * owning user, the same way `e2e/now.spec.ts` builds its week: producing it
 * through the capture form would take a minute per test and would be a test of
 * M1's capture box. Everything the page is actually about — filtering,
 * promoting, archiving, the keyboard — is done the way a person does it.
 *
 * Two verticals are inserted as fixture rows because the seed deliberately
 * ships none (`lib/defaults.ts`: verticals are the channel's own topic pillars,
 * and settings prompts for 3–5 of them in M7). The horizontals are the seeded
 * eight, untouched.
 *
 * ## Every claim that changes a row is checked in the database
 *
 * "The list no longer shows it" and "it is in Packaging" are different
 * sentences, and only the second one is still true tomorrow.
 */

const CHANNEL = { name: 'M5 Ideas', slug: 'm5-ideas' };

const TITLES = {
  desk: 'A desk tour of what earns its place',
  price: 'How I price a freelance day',
  balance: 'Reading a balance sheet in ten minutes',
  buildLog: 'The build log I keep anyway',
  packaged: 'Already past the bank',
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

async function stageIdFor(channelId: string, kind: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    'select id from public.stages where channel_id = $1 and kind = $2',
    [channelId, kind],
  );
  if (!result.rows[0]) throw new Error(`no ${kind} stage on ${CHANNEL.slug}`);
  return result.rows[0].id;
}

async function bucketIdFor(
  channelId: string,
  axis: 'vertical' | 'horizontal',
  name: string,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    'select id from public.buckets where channel_id = $1 and axis = $2 and name = $3',
    [channelId, axis, name],
  );
  if (!result.rows[0]) throw new Error(`no ${axis} called ${name}`);
  return result.rows[0].id;
}

/**
 * The two verticals. The seed ships none on purpose, and settings (M7) is where
 * a real channel gets its own; the composite FK through the pinned axis column
 * is what makes them safe to reference from a video.
 */
async function ensureVerticals(channel: {
  id: string;
  user_id: string;
}): Promise<void> {
  await db.query(
    `insert into public.buckets (user_id, channel_id, axis, name, position)
     values ($1, $2, 'vertical', 'Money', 1), ($1, $2, 'vertical', 'Craft', 2)
     on conflict (channel_id, axis, name) do nothing`,
    [channel.user_id, channel.id],
  );
}

interface SeedIdea {
  title: string;
  hook?: string;
  tags?: string[];
  vertical?: string;
  horizontal?: string;
  /** How long ago it was captured, as a Postgres interval. */
  ago: string;
  /** Anything other than `idea` makes it deliberately not a bank row. */
  kind?: string;
}

async function seedIdea(
  channel: { id: string; user_id: string },
  idea: SeedIdea,
): Promise<string> {
  const stageId = await stageIdFor(channel.id, idea.kind ?? 'idea');
  const verticalId = idea.vertical
    ? await bucketIdFor(channel.id, 'vertical', idea.vertical)
    : null;
  const horizontalId = idea.horizontal
    ? await bucketIdFor(channel.id, 'horizontal', idea.horizontal)
    : null;

  const inserted = await db.query<{ id: string }>(
    `insert into public.videos (
       user_id, channel_id, stage_id,
       created_at, stage_entered_at,
       title, one_line_hook, tags, vertical_id, horizontal_id
     ) values (
       $1, $2, $3,
       now() - $4::interval, now() - $4::interval,
       $5, $6, $7::text[], $8, $9
     ) returning id`,
    [
      channel.user_id,
      channel.id,
      stageId,
      idea.ago,
      idea.title,
      idea.hook ?? null,
      idea.tags ?? [],
      verticalId,
      horizontalId,
    ],
  );
  return inserted.rows[0].id;
}

/**
 * The bank this file works on: four ideas that differ in every filterable way,
 * plus one video that is past the bank and must never appear on the page.
 *
 * Ages carry an extra hour so a floored day count is never within a second of
 * flipping mid-run.
 */
async function seedBank(): Promise<Record<keyof typeof TITLES, string>> {
  const channel = await channelRow();
  if (!channel) throw new Error('the fixture channel is missing');
  await ensureVerticals(channel);

  return {
    desk: await seedIdea(channel, {
      title: TITLES.desk,
      hook: 'Everything that survived a year of use',
      tags: ['gear', 'desk'],
      vertical: 'Craft',
      horizontal: 'review',
      ago: '10 days 1 hour',
    }),
    price: await seedIdea(channel, {
      title: TITLES.price,
      hook: 'The number, and how I got to it',
      tags: ['money'],
      vertical: 'Money',
      horizontal: 'tutorial',
      ago: '5 days 1 hour',
    }),
    balance: await seedIdea(channel, {
      title: TITLES.balance,
      tags: ['money'],
      vertical: 'Money',
      ago: '2 days 1 hour',
    }),
    buildLog: await seedIdea(channel, {
      title: TITLES.buildLog,
      hook: 'A week of small commits',
      tags: ['gear'],
      ago: '1 day 1 hour',
    }),
    // Not an idea. It is in Packaging, and the bank is one stage.
    packaged: await seedIdea(channel, {
      title: TITLES.packaged,
      kind: 'packaging',
      ago: '3 days 1 hour',
    }),
  };
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

/** Open the bank and wait for it to be able to take a keystroke. */
async function openBank(page: Page): Promise<void> {
  await page.goto(`/c/${CHANNEL.slug}/ideas`);
  await expect(page.getByTestId('idea-bank')).toHaveAttribute(
    'data-ready',
    'true',
  );
}

const rows = (page: Page): Locator => page.getByTestId('idea-row');

const rowFor = (page: Page, title: string): Locator =>
  rows(page).filter({ hasText: title });

/** Every row's title, in the order the page has them. */
async function titles(page: Page): Promise<string[]> {
  return rows(page).getByTestId('idea-open').allInnerTexts();
}

/** The stage `kind` one video is actually in, straight from the database. */
async function kindOf(videoId: string): Promise<string | null> {
  const result = await db.query<{ kind: string | null }>(
    `select s.kind from public.videos v
       join public.stages s on s.id = v.stage_id
      where v.id = $1`,
    [videoId],
  );
  return result.rows[0]?.kind ?? null;
}

let ids: Record<keyof typeof TITLES, string>;

test.beforeEach(async ({ page }) => {
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug = $1)`,
    [CHANNEL.slug],
  );

  await signIn(page);
  if ((await channelRow()) === null) await createChannel(page);
  ids = await seedBank();
});

/* -------------------------------------------------------------------------- */
/* The list                                                                    */
/* -------------------------------------------------------------------------- */

test('the bank lists this channel’s Idea-stage videos, newest first', async ({
  page,
}) => {
  await openBank(page);

  await expect(rows(page)).toHaveCount(4);

  // Newest captured first, which is what a bank is expected to look like.
  expect(await titles(page)).toEqual([
    TITLES.buildLog,
    TITLES.balance,
    TITLES.price,
    TITLES.desk,
  ]);

  // The video in Packaging is a video, not an idea, and this page is one stage.
  await expect(rowFor(page, TITLES.packaged)).toHaveCount(0);
  expect(await kindOf(ids.packaged)).toBe('packaging');

  // The row carries what the decision needs: hook, tags, both buckets, and how
  // long it has been sitting.
  const desk = rowFor(page, TITLES.desk);
  await expect(desk.getByTestId('idea-hook')).toHaveText(
    'Everything that survived a year of use',
  );
  // The visually-hidden prefixes are part of the assertion: a row of bare
  // pills is unreadable without them, and `toHaveText` sees exactly what a
  // screen reader gets.
  await expect(desk.getByTestId('idea-tag')).toHaveText([
    'Tag: #gear',
    'Tag: #desk',
  ]);
  await expect(desk.getByTestId('idea-vertical')).toHaveText('Vertical: Craft');
  await expect(desk.getByTestId('idea-horizontal')).toHaveText(
    'Horizontal: review',
  );
  await expect(desk.getByTestId('idea-age')).toHaveText('10 days in the bank');

  // An idea with no hook and no buckets draws none of those chips rather than
  // empty ones.
  const balance = rowFor(page, TITLES.balance);
  await expect(balance.getByTestId('idea-hook')).toHaveCount(0);
  await expect(balance.getByTestId('idea-horizontal')).toHaveCount(0);
  await expect(balance.getByTestId('idea-vertical')).toHaveText(
    'Vertical: Money',
  );

  // And nothing from another channel leaks in: the seed's own two channels have
  // ideas of their own.
  const otherChannelTitles = await db.query<{ title: string }>(
    `select distinct v.title from public.videos v
       join public.channels c on c.id = v.channel_id
      where c.slug <> $1 and v.title <> ''`,
    [CHANNEL.slug],
  );
  const mine = Object.values(TITLES) as string[];
  const foreign = otherChannelTitles.rows
    .map((row) => row.title)
    // The dev stack seeds ideas of its own, and a title of ours that happened
    // to contain one of theirs would make this assertion fail for a reason that
    // has nothing to do with leaking.
    .filter((title) => !mine.some((ours) => ours.includes(title)));
  expect(foreign.length).toBeGreaterThan(0);
  for (const title of foreign.slice(0, 5)) {
    await expect(rowFor(page, title)).toHaveCount(0);
  }
});

/* -------------------------------------------------------------------------- */
/* Filters                                                                     */
/* -------------------------------------------------------------------------- */

test('each filter narrows the bank, and they combine', async ({ page }) => {
  await openBank(page);

  // By tag.
  await page.getByTestId('idea-tag-filter').selectOption('money');
  await expect(rows(page)).toHaveCount(2);
  expect(await titles(page)).toEqual([TITLES.balance, TITLES.price]);

  // By vertical, on top of the tag: same two, because both money ideas are
  // filed under Money.
  const moneyVerticalId = await bucketIdFor(
    (await channelRow())!.id,
    'vertical',
    'Money',
  );
  await page.getByTestId('idea-vertical-filter').selectOption(moneyVerticalId);
  await expect(rows(page)).toHaveCount(2);

  // By horizontal, on top of both: only one of them is a tutorial.
  const tutorialId = await bucketIdFor(
    (await channelRow())!.id,
    'horizontal',
    'tutorial',
  );
  await page.getByTestId('idea-horizontal-filter').selectOption(tutorialId);
  await expect(rows(page)).toHaveCount(1);
  await expect(rowFor(page, TITLES.price)).toBeVisible();

  // And the text search, over the title and the one-line hook, on top of all
  // three: "balance" is in the other money idea's title, so the combination is
  // empty rather than showing the row the search alone would find.
  await page.getByTestId('idea-search').fill('balance');
  await expect(rows(page)).toHaveCount(0);

  // Start again: the search alone finds it by title...
  await page.getByTestId('idea-clear-filters').click();
  await page.getByTestId('idea-search').fill('balance');
  await expect(rows(page)).toHaveCount(1);
  await expect(rowFor(page, TITLES.balance)).toBeVisible();

  // ...and by hook, which is the half of the search that is easy to forget.
  await page.getByTestId('idea-search').fill('survived a year');
  await expect(rows(page)).toHaveCount(1);
  await expect(rowFor(page, TITLES.desk)).toBeVisible();

  // Case and surrounding space are not the user's problem.
  await page.getByTestId('idea-search').fill('  DESK TOUR ');
  await expect(rows(page)).toHaveCount(1);
  await expect(rowFor(page, TITLES.desk)).toBeVisible();
});

test('an empty result says which filter emptied it', async ({ page }) => {
  await openBank(page);

  // One filter that matches nothing on its own: it is named, and the innocent
  // one next to it is not.
  await page.getByTestId('idea-tag-filter').selectOption('money');
  await page.getByTestId('idea-search').fill('kayak');
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId('idea-empty')).toContainText(
    'No idea in this bank matches “kayak”.',
  );

  // Two filters that each match something, but never the same idea. Naming one
  // of them here would be a lie — either would restore results.
  await page.getByTestId('idea-clear-filters').click();
  await page.getByTestId('idea-tag-filter').selectOption('money');
  const reviewId = await bucketIdFor(
    (await channelRow())!.id,
    'horizontal',
    'review',
  );
  await page.getByTestId('idea-horizontal-filter').selectOption(reviewId);
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByTestId('idea-empty')).toContainText(
    'Each filter finds something on its own, but no idea has the tag “money” and the horizontal “review” together.',
  );

  // And the way out is on the message itself.
  await page.getByTestId('idea-clear-filters').click();
  await expect(rows(page)).toHaveCount(4);
});

/* -------------------------------------------------------------------------- */
/* Promote                                                                     */
/* -------------------------------------------------------------------------- */

test('Promote moves the idea to Packaging and it leaves the bank', async ({
  page,
}) => {
  await openBank(page);

  expect(await kindOf(ids.balance)).toBe('idea');

  await rowFor(page, TITLES.balance).getByTestId('idea-promote').click();

  // It leaves the bank in front of you...
  await expect(rowFor(page, TITLES.balance)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(3);

  // ...and it is in Packaging in the database, which is the claim that matters.
  await expect(async () => {
    expect(await kindOf(ids.balance)).toBe('packaging');
  }).toPass({ timeout: 10_000 });

  // A reload agrees: this is not a row hidden by client state.
  await openBank(page);
  await expect(rows(page)).toHaveCount(3);
  await expect(rowFor(page, TITLES.balance)).toHaveCount(0);

  // And the board has it in its Packaging column now.
  await page.goto(`/c/${CHANNEL.slug}/board`);
  await expect(
    page
      .getByRole('region', { name: 'Packaging (TTH)', exact: true })
      .getByTestId('board-card')
      .filter({ hasText: TITLES.balance }),
  ).toHaveCount(1);
});

test('j, k and p promote the selected idea without touching the mouse', async ({
  page,
}) => {
  await openBank(page);

  // `j` selects the first row — the newest capture.
  await untilTaken(
    async () => {
      await page.keyboard.press('j');
    },
    async () => {
      await expect(rows(page).first()).toHaveAttribute(
        'data-selected',
        'true',
        { timeout: 2_000 },
      );
    },
  );
  await expect(rowFor(page, TITLES.buildLog)).toHaveAttribute(
    'data-selected',
    'true',
  );

  // `j` again, then `k`, lands back where it started.
  await page.keyboard.press('j');
  await expect(rowFor(page, TITLES.balance)).toHaveAttribute(
    'data-selected',
    'true',
  );
  await page.keyboard.press('k');
  await expect(rowFor(page, TITLES.buildLog)).toHaveAttribute(
    'data-selected',
    'true',
  );

  // `p` promotes the selected one.
  await page.keyboard.press('p');
  await expect(rowFor(page, TITLES.buildLog)).toHaveCount(0);
  await expect(async () => {
    expect(await kindOf(ids.buildLog)).toBe('packaging');
  }).toPass({ timeout: 10_000 });

  // `p` typed into the search box is a letter, not a promotion — the one
  // property `lib/shortcuts.ts` has to keep for a page with a text filter on it.
  await page.getByTestId('idea-search').fill('p');
  await expect(page.getByTestId('idea-search')).toHaveValue('p');
  expect(await kindOf(ids.balance)).toBe('idea');

  // `Enter` opens the selected idea.
  await page.getByTestId('idea-search').fill('');
  await rowFor(page, TITLES.desk).click();
  await page.keyboard.press('Enter');
  await page.waitForURL(`**/videos/${ids.desk}`);
});

/* -------------------------------------------------------------------------- */
/* Archive                                                                     */
/* -------------------------------------------------------------------------- */

test('Archive takes an idea out of the bank, and Show archived brings it back', async ({
  page,
}) => {
  await openBank(page);

  await rowFor(page, TITLES.desk).getByTestId('idea-archive').click();

  // The row stays where it was, marked and undoable: archiving is meant to be
  // cheap, and cheap is only safe when the undo is where the mistake was.
  const desk = rowFor(page, TITLES.desk);
  await expect(desk.getByTestId('idea-archived-chip')).toBeVisible();
  await expect(desk.getByTestId('idea-restore')).toBeVisible();

  await expect(async () => {
    const result = await db.query<{ archived_at: string | null }>(
      'select archived_at from public.videos where id = $1',
      [ids.desk],
    );
    expect(result.rows[0].archived_at).not.toBeNull();
  }).toPass({ timeout: 10_000 });

  // On a reload it really is out of the bank, and off the board.
  await openBank(page);
  await expect(rows(page)).toHaveCount(3);
  await expect(rowFor(page, TITLES.desk)).toHaveCount(0);

  // But it is not gone: the toggle says how many there are and brings them back.
  await page.getByTestId('idea-archived-toggle').click();
  await expect(rows(page)).toHaveCount(4);
  await expect(
    rowFor(page, TITLES.desk).getByTestId('idea-archived-chip'),
  ).toBeVisible();

  await rowFor(page, TITLES.desk).getByTestId('idea-restore').click();
  await expect(
    rowFor(page, TITLES.desk).getByTestId('idea-promote'),
  ).toBeVisible();

  await expect(async () => {
    const result = await db.query<{ archived_at: string | null }>(
      'select archived_at from public.videos where id = $1',
      [ids.desk],
    );
    expect(result.rows[0].archived_at).toBeNull();
  }).toPass({ timeout: 10_000 });
});

/* -------------------------------------------------------------------------- */
/* The board's "+K more"                                                       */
/* -------------------------------------------------------------------------- */

test('the board’s "+K more in Ideas" reaches the bank, and the bank has all of them', async ({
  page,
}) => {
  const channel = await channelRow();
  if (!channel) throw new Error('the fixture channel is missing');

  // Eleven ideas: the column caps at ten and counts the eleventh.
  for (let index = 0; index < 7; index += 1) {
    await seedIdea(channel, {
      title: `Overflow idea ${index + 1}`,
      ago: `${20 + index} days 1 hour`,
    });
  }

  await page.goto(`/c/${CHANNEL.slug}/board`);

  const idea = page.getByRole('region', { name: 'Idea', exact: true });
  await expect(idea.getByTestId('board-card')).toHaveCount(10);

  const overflow = idea.getByTestId('idea-overflow');
  await expect(overflow).toHaveText('+1 more in Ideas');
  // It is a link, not a caption with a tooltip apologising for being one.
  await expect(overflow).toHaveAttribute('href', `/c/${CHANNEL.slug}/ideas`);

  await overflow.click();
  await page.waitForURL(`**/c/${CHANNEL.slug}/ideas`);
  await expect(page.getByTestId('idea-bank')).toHaveAttribute(
    'data-ready',
    'true',
  );

  // The whole of what the board was counting, not ten of it.
  await expect(rows(page)).toHaveCount(11);
  await expect(rowFor(page, 'Overflow idea 7')).toBeVisible();

  // The sidebar says this is the page you are on — the entry M3's review filed
  // as a dead placeholder nobody could reach with a keyboard.
  const sidebar = page.getByRole('navigation', { name: 'Main' });
  await expect(
    sidebar.getByRole('link', { name: 'Ideas', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});
