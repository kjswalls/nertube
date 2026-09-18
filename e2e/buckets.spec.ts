import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';
import { untilTaken } from './hydration';

/**
 * Filing an idea: one vertical, one horizontal, and its tags.
 *
 * M5's assignment slice, walked in a browser against the real stack. Six
 * claims, one per thing that could be quietly wrong:
 *
 * 1. **One of each axis persists.** Picked on `/videos/[id]`, read back out of
 *    Postgres — "Saved" on a status line is not evidence that a column holds a
 *    uuid.
 * 2. **The picker cannot express an invalid choice.** Its options are this
 *    channel's buckets *on that axis* and nothing else: no format in the pillar
 *    menu, and nothing belonging to the other channel, which has a pillar of
 *    its own with a name that would be obvious if it leaked.
 * 3. **Clearing works**, and clears one axis without touching the other.
 * 4. **Capture's fast path is untouched.** `c`, type, Enter — with no pickers
 *    on screen, nothing fetched, and a row whose bucket columns are null.
 *    Shift+Enter is where the buckets are, and what it files really lands.
 * 5. **The tag editor adds, removes and suggests** — and the suggestions are
 *    the vocabulary this channel already uses.
 * 6. **Changing channel is not offered anywhere**, because a video's buckets
 *    belong to its channel. (The database's half of that is
 *    `supabase/tests/55_bucket_assignment.test.sql`.)
 *
 * The two rules the rest of this suite follows hold here too: the *fixture* is
 * SQL, because `lib/defaults.ts` seeds no verticals on purpose and the bucket
 * editor is M7; everything the feature is actually about is done by clicking.
 */

/** The channel under test, and one next to it whose buckets must never leak. */
const CHANNEL = { name: 'M5 Assign', slug: 'm5-assign' };
const OTHER = { name: 'M5 Assign Elsewhere', slug: 'm5-assign-elsewhere' };

/** This channel's pillars, in position order. */
const PILLARS = ['money', 'focus'] as const;
/** The other channel's only pillar. If it ever shows up here, claim 2 is false. */
const FOREIGN_PILLAR = 'someone elses pillar';

/** The tags the channel already uses, so the editor has something to suggest. */
const VOCABULARY = ['index funds', 'deep work'];

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

async function stageIdFor(channelId: string, kind: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    'select id from public.stages where channel_id = $1 and kind = $2',
    [channelId, kind],
  );
  if (!result.rows[0]) throw new Error(`no ${kind} stage on that channel`);
  return result.rows[0].id;
}

async function addPillar(
  channel: ChannelRow,
  name: string,
  position: number,
): Promise<void> {
  await db.query(
    `insert into public.buckets (user_id, channel_id, axis, name, position)
     values ($1, $2, 'vertical', $3, $4)`,
    [channel.user_id, channel.id, name, position],
  );
}

/** One idea, straight into the channel's Idea stage — what a capture produces. */
async function seedIdea(
  channel: ChannelRow,
  title: string,
  tags: readonly string[] = [],
): Promise<string> {
  const stageId = await stageIdFor(channel.id, 'idea');
  const result = await db.query<{ id: string }>(
    `insert into public.videos (user_id, channel_id, stage_id, title, tags)
     values ($1, $2, $3, $4, $5::text[]) returning id`,
    [channel.user_id, channel.id, stageId, title, tags],
  );
  return result.rows[0].id;
}

interface FiledRow {
  vertical: string | null;
  horizontal: string | null;
  tags: string[];
}

/** What the row actually holds, with the bucket ids resolved to their names. */
async function filed(videoId: string): Promise<FiledRow> {
  const result = await db.query<FiledRow>(
    `select bv.name as vertical, bh.name as horizontal, v.tags
       from public.videos v
       left join public.buckets bv on bv.id = v.vertical_id
       left join public.buckets bh on bh.id = v.horizontal_id
      where v.id = $1`,
    [videoId],
  );
  if (!result.rows[0]) throw new Error(`no video ${videoId}`);
  return result.rows[0];
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

async function createChannel(
  page: Page,
  channel: { name: string; slug: string },
): Promise<void> {
  await page.goto('/c/new');
  await page.getByLabel('Channel name').fill(channel.name);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.waitForURL(`**/c/${channel.slug}/board`);
}

/**
 * The app's own signal that the tree has hydrated: the sidebar's Capture button
 * gets `data-shortcut-ready` when its `c` binding is live. Every spec in this
 * suite waits on the same attribute.
 */
async function hydrated(page: Page): Promise<void> {
  await expect(
    page.locator('button[aria-keyshortcuts="c"][data-shortcut-ready="true"]'),
  ).toBeVisible();
}

/** The words in a `<select>`, in order. */
function optionLabels(page: Page, testId: string): Promise<string[]> {
  return page
    .getByTestId(testId)
    .locator('option')
    .allTextContents();
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

  // Start from nothing: these tests count options and assert suggestions, and
  // a run that inherited the last run's rows would be measuring litter.
  for (const target of [channel, other]) {
    await db.query('delete from public.videos where channel_id = $1', [target.id]);
    await db.query(
      "delete from public.buckets where channel_id = $1 and axis = 'vertical'",
      [target.id],
    );
  }

  for (const [index, name] of PILLARS.entries()) {
    await addPillar(channel, name, index + 1);
  }
  await addPillar(other, FOREIGN_PILLAR, 1);
});

/* -------------------------------------------------------------------------- */
/* 1 + 2 + 3 — the video page                                                  */
/* -------------------------------------------------------------------------- */

test('the filing block offers this channel’s buckets, one per axis, and what it saves is what the row holds', async ({
  page,
}) => {
  const videoId = await seedIdea(channel, 'A thing to file');
  await page.goto(`/videos/${videoId}`);
  await hydrated(page);

  /* Claim 2, before anything is picked: the menus are this channel's buckets,
     split by axis. The pillar menu holds the two pillars and the empty option;
     it does not hold a format, and it does not hold the other channel's pillar
     — which is named so that a leak would be unmistakable. */
  expect(await optionLabels(page, 'video-vertical')).toEqual([
    '— not filed —',
    'money',
    'focus',
  ]);

  const formats = await optionLabels(page, 'video-horizontal');
  // The eight seeded formats from BRIEF.md, plus the empty option.
  expect(formats).toContain('tutorial');
  expect(formats).toContain('interview');
  expect(formats).not.toContain('money');
  expect(formats).not.toContain(FOREIGN_PILLAR);
  expect(formats).toHaveLength(9);

  // Neither menu takes more than one value: a `<select>` without `multiple`.
  await expect(page.getByTestId('video-vertical')).not.toHaveAttribute('multiple', /.*/);
  await expect(page.getByTestId('video-horizontal')).not.toHaveAttribute('multiple', /.*/);

  // Claim 1. The first interaction goes through the hydration retry — all five
  // sections are mounted, so the window in which a control has no handler yet
  // is real. Picking again is idempotent.
  await untilTaken(
    async () => {
      await page.getByTestId('video-vertical').selectOption({ label: 'money' });
    },
    () => expect(page.getByTestId('bucket-row-status')).toHaveAttribute('data-state', 'saved'),
  );

  await page.getByTestId('video-horizontal').selectOption({ label: 'tutorial' });
  await expect(page.getByTestId('bucket-row-status')).toHaveAttribute('data-state', 'saved');

  await expect
    .poll(() => filed(videoId).then((row) => [row.vertical, row.horizontal]))
    .toEqual(['money', 'tutorial']);

  // It survives a reload, which is the only proof that the page is rendering
  // the column rather than its own memory of the click.
  await page.reload();
  await hydrated(page);
  await expect(page.getByTestId('video-vertical')).toHaveValue(
    await bucketId(channel.id, 'vertical', 'money'),
  );

  // Claim 3: clearing one axis leaves the other alone.
  await untilTaken(
    async () => {
      await page.getByTestId('video-vertical').selectOption({ label: '— not filed —' });
    },
    () => expect(page.getByTestId('bucket-row-status')).toHaveAttribute('data-state', 'saved'),
  );

  await expect
    .poll(() => filed(videoId).then((row) => [row.vertical, row.horizontal]))
    .toEqual([null, 'tutorial']);
});

async function bucketId(
  channelId: string,
  axis: 'vertical' | 'horizontal',
  name: string,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    'select id from public.buckets where channel_id = $1 and axis = $2 and name = $3',
    [channelId, axis, name],
  );
  if (!result.rows[0]) throw new Error(`no ${axis} bucket "${name}"`);
  return result.rows[0].id;
}

test('a bucket the database refuses is explained, and the row is left alone', async ({
  page,
}) => {
  const videoId = await seedIdea(channel, 'Filed against a bucket that goes away');
  await page.goto(`/videos/${videoId}`);
  await hydrated(page);

  /* The page is now holding an option the database is about to stop having.
     This is the stale-tab case the composite foreign key exists for, staged
     deliberately: the menu still offers `focus`, and picking it sends an id
     that no longer names a row. */
  await db.query(
    "delete from public.buckets where channel_id = $1 and axis = 'vertical' and name = 'focus'",
    [channel.id],
  );

  await untilTaken(
    async () => {
      await page.getByTestId('video-vertical').selectOption({ label: 'focus' });
    },
    () => expect(page.getByTestId('bucket-row-status')).toHaveAttribute('data-state', 'error'),
  );

  // Not `videos_vertical_id_channel_id_vertical_axis_fkey`: what happened, and
  // what to do about it.
  await expect(page.getByTestId('bucket-row-status')).toContainText('topic pillar');
  await expect(page.getByTestId('bucket-row-status')).toContainText('reload');

  // A refusal is a conflict, not something a Retry could fix: the page is
  // holding buckets the channel has moved past.
  await expect(page.getByTestId('bucket-row-status-reload')).toBeVisible();

  // And nothing was written.
  expect(await filed(videoId)).toMatchObject({ vertical: null, horizontal: null });
});

/* -------------------------------------------------------------------------- */
/* 5 — the tag editor                                                          */
/* -------------------------------------------------------------------------- */

test('tags can be added, removed and taken from what the channel already uses', async ({
  page,
}) => {
  // Two other videos hold the channel's vocabulary; this one starts with one
  // tag of its own, so removal has something to remove.
  await seedIdea(channel, 'An older idea', VOCABULARY);
  await seedIdea(channel, 'Another older idea', ['deep work']);
  const videoId = await seedIdea(channel, 'The one being tagged', ['keep me']);

  await page.goto(`/videos/${videoId}`);
  await hydrated(page);

  await expect(page.getByTestId('tag-chip')).toHaveCount(1);
  await expect(page.getByTestId('tag-chip').first()).toHaveAttribute('data-tag', 'keep me');

  // Suggested: what the channel uses and this video does not. `keep me` is on
  // this video, so it is not offered back.
  const suggestions = page.getByTestId('tag-suggestion');
  await expect(suggestions).toHaveCount(2);
  await expect(suggestions.first()).toHaveAttribute('data-tag', 'deep work');

  // Add by typing.
  await untilTaken(
    async () => {
      const input = page.getByTestId('tag-input');
      if ((await input.inputValue()) === '') await input.fill('sunday build');
      await input.press('Enter');
    },
    () => expect(page.getByTestId('tag-chip')).toHaveCount(2),
  );
  await expect(page.getByTestId('tag-status')).toHaveAttribute('data-state', 'saved');

  // Add by clicking a suggestion — the whole point of showing them.
  await page.getByTestId('tag-suggestion').filter({ hasText: 'index funds' }).click();
  await expect(page.getByTestId('tag-chip')).toHaveCount(3);
  await expect(page.getByTestId('tag-status')).toHaveAttribute('data-state', 'saved');

  await expect
    .poll(() => filed(videoId).then((row) => row.tags))
    .toEqual(['keep me', 'sunday build', 'index funds']);

  // A tag already on the video is refused in the browser, with a reason, and
  // costs no round trip.
  await page.getByTestId('tag-input').fill('index funds');
  await page.getByTestId('tag-add').click();
  await expect(page.getByTestId('tag-refusal')).toBeVisible();
  await expect(page.getByTestId('tag-chip')).toHaveCount(3);

  // Remove.
  await page
    .getByTestId('tag-chip')
    .filter({ hasText: 'keep me' })
    .getByTestId('tag-remove')
    .click();
  await expect(page.getByTestId('tag-chip')).toHaveCount(2);

  await expect
    .poll(() => filed(videoId).then((row) => row.tags))
    .toEqual(['sunday build', 'index funds']);

  // And it is the row that is being drawn, not the page's memory of it.
  await page.reload();
  await hydrated(page);
  await expect(page.getByTestId('tag-chip')).toHaveCount(2);
});

/* -------------------------------------------------------------------------- */
/* 4 — capture                                                                 */
/* -------------------------------------------------------------------------- */

test('capture’s fast path is one field, and the buckets live behind the disclosure', async ({
  page,
}) => {
  await page.goto(`/c/${CHANNEL.slug}/board`);
  await hydrated(page);

  const fast = `Fast path ${Date.now().toString(36)}`;

  await untilTaken(
    async () => {
      if (await page.getByRole('dialog').isVisible().catch(() => false)) return;
      await page.keyboard.press('c');
    },
    () => expect(page.getByRole('dialog')).toBeVisible(),
  );

  // Nothing about buckets is on screen, and nothing has been asked of the
  // server for them: the pickers are not merely hidden, they are unmounted.
  await expect(page.getByTestId('capture-buckets')).toHaveCount(0);

  // Scoped to the dialog: the board behind it has a column called Idea too.
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Idea' }).fill(fast);
  await dialog.getByRole('textbox', { name: 'Idea' }).press('Enter');
  await expect(page.getByRole('dialog')).toBeHidden();

  await expect
    .poll(async () => {
      const result = await db.query<{ id: string }>(
        'select id from public.videos where title = $1 and channel_id = $2',
        [fast, channel.id],
      );
      return result.rows.length;
    })
    .toBe(1);

  const fastRow = await db.query<{ vertical_id: string | null; horizontal_id: string | null }>(
    'select vertical_id, horizontal_id from public.videos where title = $1',
    [fast],
  );
  expect(fastRow.rows[0]).toEqual({ vertical_id: null, horizontal_id: null });

  /* Now the disclosure. Shift+Enter in the title field is PLAN.md's own
     gesture for it, and the pickers arrive with it — then what they file has
     to reach the row. */
  const filedTitle = `Filed at capture ${Date.now().toString(36)}`;

  await untilTaken(
    async () => {
      if (await page.getByRole('dialog').isVisible().catch(() => false)) return;
      await page.keyboard.press('c');
    },
    () => expect(page.getByRole('dialog')).toBeVisible(),
  );

  const reopened = page.getByRole('dialog');
  await reopened.getByRole('textbox', { name: 'Idea' }).fill(filedTitle);
  await reopened.getByRole('textbox', { name: 'Idea' }).press('Shift+Enter');

  await expect(page.getByTestId('capture-buckets')).toBeVisible();
  // The options arrive from the server after the fields do; the status line
  // says which state it is in rather than leaving an empty menu to be read as
  // "this channel has no pillars".
  await expect(page.getByTestId('capture-buckets-status')).toHaveAttribute(
    'data-status',
    'ready',
  );

  // Same guarantee as the video page: this channel's buckets, split by axis.
  expect(await optionLabels(page, 'capture-vertical')).toEqual([
    '— not filed —',
    'money',
    'focus',
  ]);
  expect(await optionLabels(page, 'capture-horizontal')).not.toContain(FOREIGN_PILLAR);

  await page.getByTestId('capture-vertical').selectOption({ label: 'focus' });
  await page.getByTestId('capture-horizontal').selectOption({ label: 'listicle' });
  await reopened.getByRole('button', { name: 'Capture', exact: true }).click();

  await expect(page.getByRole('dialog')).toBeHidden();

  await expect
    .poll(async () => {
      const result = await db.query<{ id: string }>(
        'select id from public.videos where title = $1',
        [filedTitle],
      );
      return result.rows.length;
    })
    .toBe(1);

  const captured = await db.query<{ id: string }>(
    'select id from public.videos where title = $1',
    [filedTitle],
  );
  expect(await filed(captured.rows[0].id)).toMatchObject({
    vertical: 'focus',
    horizontal: 'listicle',
  });
});

test('retargeting the capture to another channel reloads the menus and clears the choice', async ({
  page,
}) => {
  await page.goto(`/c/${CHANNEL.slug}/board`);
  await hydrated(page);

  await untilTaken(
    async () => {
      if (await page.getByRole('dialog').isVisible().catch(() => false)) return;
      await page.keyboard.press('c');
    },
    () => expect(page.getByRole('dialog')).toBeVisible(),
  );

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Idea' }).press('Shift+Enter');
  await expect(page.getByTestId('capture-buckets-status')).toHaveAttribute(
    'data-status',
    'ready',
  );

  await page.getByTestId('capture-vertical').selectOption({ label: 'focus' });
  await expect(page.getByTestId('capture-vertical')).not.toHaveValue('');

  // Aim it at the other channel by clicking its chip — what `1..9` does too.
  await dialog.locator('label', { hasText: OTHER.name }).click();

  await expect(page.getByTestId('capture-buckets-status')).toHaveAttribute(
    'data-status',
    'ready',
  );

  /* The choice is gone and the menu is the other channel's. A bucket belongs to
     its channel — `videos` binds each slot through a three-column key — so
     carrying `focus` across would post an id this channel does not have. */
  await expect(page.getByTestId('capture-vertical')).toHaveValue('');
  expect(await optionLabels(page, 'capture-vertical')).toEqual([
    '— not filed —',
    FOREIGN_PILLAR,
  ]);
});

/* -------------------------------------------------------------------------- */
/* 6 — a video's channel is not a field                                        */
/* -------------------------------------------------------------------------- */

test('nothing on the video page offers to move a video to another channel', async ({
  page,
}) => {
  const videoId = await seedIdea(channel, 'Stays where it was captured');
  await page.goto(`/videos/${videoId}`);
  await hydrated(page);

  // The channel is a link back to its board, not a control. If a channel
  // switcher ever appears on this page, the buckets would have to be cleared
  // with it — see supabase/tests/55_bucket_assignment.test.sql, which shows the
  // database refusing exactly that move.
  await expect(
    page.getByRole('link', { name: `← ${CHANNEL.name} board` }),
  ).toBeVisible();

  const selects = page.locator('main select');
  const names = await selects.evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLSelectElement).name || node.getAttribute('data-testid') || ''),
  );
  expect(names.join(' ')).not.toContain('channel');

  // And the Schedule section's stage select only offers this channel's stages.
  // The sections are links, not `role="tab"` — see
  // `components/video-sections/section-nav.tsx` — so this is the URL they point
  // at, which is also what a pasted link opens.
  await page.goto(`/videos/${videoId}?section=schedule`);
  await hydrated(page);
  const stageOptions = await page
    .getByTestId('stage-select')
    .locator('option')
    .allTextContents();
  expect(stageOptions).toContain('Idea');
  expect(stageOptions.join(' ')).not.toContain(OTHER.name);
});
