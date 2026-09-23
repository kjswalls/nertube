import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { PG } from '../scripts/dev-stack/shared';

import { untilTaken } from './hydration';

/**
 * M9 — a brand-new account, walked from the login form to a first channel, a
 * first bucket and a first video, with no dead end on the way.
 *
 * Every other spec in this suite starts from the seeded account (two channels,
 * four ideas) or builds its own fixture in SQL, which is why eight milestones
 * of building never looked at what a new user sees. This one starts from an
 * account with **nothing** — no channel, no video, no bucket, no filming day —
 * and only ever uses the app to change that. The only SQL here is creating the
 * user (there is no sign-up screen by design) and, for the error-state case,
 * making one read fail for this account alone and then putting it back.
 *
 * What it holds the app to (the M9 brief): every empty view says what it is
 * for, why it is empty, and the one thing to do next, *one click away*; and
 * every error has one presentation with a way forward.
 */

const EMAIL = 'empty-states@nertube.test';
const PASSWORD = 'empty-states-password';
const CHANNEL = { name: 'First Light', slug: 'first-light' };
const IDEA = 'Why my first video took nine weeks';

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
  await removeUser();
  // The same insert the harness's own seed makes (`scripts/dev-stack/seed.mts`):
  // bcrypt, confirmed, and nothing else — no channel, no row of any kind.
  await db.query(
    `insert into auth.users (email, encrypted_password, email_confirmed_at, aud, role)
     values (lower($1), crypt($2, gen_salt('bf')), now(), 'authenticated', 'authenticated')`,
    [EMAIL, PASSWORD],
  );
});

test.afterAll(async () => {
  // A failed run must not leave the failing read behind for this user.
  await failReadsFor(null).catch(() => {});
  await removeUser().catch(() => {});
  await db?.end();
});

/**
 * Make every read of `channels` fail — for this spec's account only.
 *
 * `channels` because a policy is evaluated per row, so the table has to hold a
 * row of this account's for the read to fail at all (its `thumbnail_swaps`,
 * the first choice, has none, and the page loaded happily).
 *
 * A restrictive RLS policy whose `CASE` raises for exactly one user id: every
 * other account (the seeded one, which the rest of the suite signs in as,
 * possibly at the same moment on a shared stack) evaluates the `else true`
 * branch and never reaches the exception. `CASE` is the one construct whose
 * evaluation order Postgres guarantees, which is why it is not an `OR`.
 * `null` removes it.
 */
async function failReadsFor(userId: string | null): Promise<void> {
  await db.query('drop policy if exists e2e_empty_states_fail on public.channels');
  if (userId === null) {
    await db.query('drop function if exists public.e2e_empty_states_fail()');
    return;
  }
  await db.query(`
    create or replace function public.e2e_empty_states_fail() returns boolean
    language plpgsql volatile as $$
    begin
      raise exception 'e2e: a read that did not come back';
    end $$`);
  await db.query(
    `create policy e2e_empty_states_fail on public.channels
       as restrictive for select to authenticated
       using (case when auth.uid() = '${userId}'::uuid
                   then public.e2e_empty_states_fail() else true end)`,
  );
}

/** Every row this account made goes with it: `user_id` cascades everywhere. */
async function removeUser(): Promise<void> {
  await db.query('delete from auth.users where lower(email) = lower($1)', [EMAIL]);
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** The shell has hydrated: the capture button's effect has run. */
async function hydrated(page: Page): Promise<void> {
  await expect(
    page.locator('button[aria-keyshortcuts="c"][data-shortcut-ready="true"]'),
  ).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('before a channel exists, every door leads to creating one', async ({ page }) => {
  await signIn(page);

  // `/` sends a channel-less account to the one thing it can do.
  await page.waitForURL('**/c/new');
  await expect(page.getByTestId('new-channel-heading')).toHaveText('Start with a channel');
  await expect(page.getByTestId('new-channel-intro')).toContainText(
    'Everything in NerTube belongs to a channel',
  );

  // The sidebar's two channel-shaped rows cannot go anywhere yet, and say why
  // rather than being absent.
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('button', { name: 'Board', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );

  // Now has nothing to rank, so it goes where `/` goes.
  await page.goto('/now');
  await page.waitForURL('**/c/new');

  // The calendar is reachable, empty, and hands over the next step.
  await page.goto('/calendar');
  const empty = page.getByTestId('calendar-empty');
  await expect(empty).toContainText('Nothing is going out');
  await expect(empty.getByRole('link', { name: 'Create your first channel' })).toHaveAttribute(
    'href',
    '/c/new',
  );

  // A channel address that does not exist is a 404 in the app's own frame,
  // with the way forward on it.
  const missing = await page.goto('/c/nothing-here/board');
  expect(missing?.status()).toBe(404);
  const panel = page.getByTestId('channel-not-found');
  await expect(panel.getByRole('heading', { level: 1 })).toHaveText(
    'There is no channel at this address',
  );
  await panel.getByRole('link', { name: 'Create your first channel' }).click();
  await page.waitForURL('**/c/new');
});

test('a first channel lands on a board that says how anything gets onto it', async ({
  page,
}) => {
  await signIn(page);
  await page.waitForURL('**/c/new');

  await page.getByLabel('Channel name').fill(CHANNEL.name);
  await page.getByRole('button', { name: 'Create channel' }).click();
  await page.waitForURL(`**/c/${CHANNEL.slug}/board`);
  await hydrated(page);

  // Nine columns, drawn — they are the answer to "what is this page" — each an
  // empty slot rather than nine copies of a sentence.
  await expect(page.getByTestId('board-column')).toHaveCount(9);
  await expect(page.getByTestId('column-empty')).toHaveCount(9);
  await expect(page.getByText('Nothing here yet.')).toHaveCount(0);

  const empty = page.getByTestId('board-empty');
  await expect(empty.getByRole('heading')).toHaveText(`${CHANNEL.name}’s board is empty`);
  await expect(empty).toContainText('Every video moves left to right');

  // The one thing to do is one click, and it is the capture box itself.
  await empty.getByTestId('board-empty-capture').click();
  const dialog = page.getByRole('dialog', { name: 'Capture an idea' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Idea').fill(IDEA);
  await dialog.getByLabel('Idea').press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('toast')).toContainText(`Captured “${IDEA}” in ${CHANNEL.name}.`);

  // The empty state is gone, the card is in Idea, and focus is on it — the link
  // that opened the box went with the empty state, so focus had to go
  // somewhere on purpose.
  await expect(page.getByTestId('board-empty')).toHaveCount(0);
  const card = page.locator('[data-testid="board-card"]', { hasText: IDEA });
  await expect(card).toBeVisible();
  await expect(card).toBeFocused();

  // Near-empty: one column holds something, the other eight are quiet slots.
  await expect(page.getByTestId('column-empty')).toHaveCount(8);
});

test('Now and the bank say why they are empty, and the first idea becomes the first video', async ({
  page,
}) => {
  await signIn(page);
  // With a channel, `/` is Now.
  await page.waitForURL('**/now');
  await hydrated(page);

  // One idea, nothing in production: Now says so and points at the bank,
  // instead of "Nothing is waiting on you".
  const empty = page.getByTestId('now-empty');
  await expect(empty.getByRole('heading')).toHaveText('Nothing is in production yet');
  await expect(empty).toContainText('You have one idea in the bank.');
  await empty.getByTestId('now-empty-bank').click();
  await page.waitForURL(`**/c/${CHANNEL.slug}/ideas`);
  await hydrated(page);

  // Near-empty bank: one idea, and Promote one click away on its row.
  const row = page.locator('[data-testid="idea-row"]', { hasText: IDEA });
  await expect(row).toBeVisible();
  await row.getByTestId('idea-promote').click();
  await expect(page.getByTestId('toast')).toContainText('Packaging');

  // Emptied by promotion, the bank says the work moved on — not "nothing
  // captured" — and still offers the next capture.
  await page.reload();
  await hydrated(page);
  const bank = page.getByTestId('idea-empty');
  await expect(bank.getByRole('heading')).toHaveText('Everything in the bank has moved on');
  await expect(bank.getByTestId('idea-empty-capture')).toBeVisible();
  await expect(page.getByTestId('idea-search')).toHaveCount(0);

  // And Now has its first row: the video's first Packaging step.
  await page.goto('/now');
  await hydrated(page);
  await expect(page.getByTestId('now-empty')).toHaveCount(0);
  await expect(page.locator('[data-testid="now-row"]', { hasText: IDEA })).toHaveCount(1);
});

test('the matrix leads to a first pillar, and the pillar is a row on the way back', async ({
  page,
}) => {
  await signIn(page);
  await page.waitForURL('**/now');

  await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix`);
  await hydrated(page);
  const panel = page.getByTestId('matrix-needs-buckets');
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText('No topic pillars yet');
  await panel.getByTestId('add-buckets').click();
  await page.waitForURL(`**/settings/buckets/${CHANNEL.slug}`);
  await hydrated(page);
  await expect(page.getByTestId('bucket-axis-empty').first()).toContainText('No pillars yet');

  const form = page.getByTestId('add-bucket-vertical');
  await form.getByTestId('add-bucket-name').fill('first videos');
  await form.getByTestId('add-bucket-submit').click();
  await expect(
    page.locator('[data-testid="bucket-row"][data-bucket-name="first videos"]'),
  ).toBeVisible();

  // One bucket is enough for a grid: one row, crossed with the eight formats,
  // every cell of it an invitation.
  await page.goto(`/c/${CHANNEL.slug}/ideas?view=matrix`);
  await expect(page.getByTestId('matrix-grid')).toBeVisible();
  await expect(page.getByTestId('matrix-row')).toHaveCount(1);
  await expect(page.locator('[data-testid="matrix-cell"][data-empty="true"]')).toHaveCount(8);
});

test('a month with nothing in it, a missing video, and a missing channel each have a way out', async ({
  page,
}) => {
  await signIn(page);
  await page.waitForURL('**/now');

  // Nothing has a date yet: the calendar says what puts something here, and
  // links to the board.
  await page.goto('/calendar');
  const month = page.getByTestId('calendar-empty');
  await expect(month).toContainText('No video has a target publish date yet');
  await expect(month.getByRole('link', { name: 'Open the board' })).toHaveAttribute(
    'href',
    `/c/${CHANNEL.slug}/board`,
  );

  // A video id that was never issued: a 404 in the app's frame, which cannot
  // say whether it exists elsewhere, and a way back.
  const video = await page.goto('/videos/00000000-0000-4000-8000-000000000000');
  expect(video?.status()).toBe(404);
  const gone = page.getByTestId('video-not-found');
  await expect(gone.getByRole('heading', { level: 1 })).toHaveText('This video isn’t here');
  await expect(page.getByTestId('app-sidebar')).toBeVisible();
  await gone.getByRole('link', { name: 'Go to Now' }).click();
  await page.waitForURL('**/now');

  // A mistyped channel: the real one is one click away, at the same place.
  const channel = await page.goto('/c/frist-light/ideas');
  expect(channel?.status()).toBe(404);
  const wrong = page.getByTestId('channel-not-found');
  await wrong.getByRole('link', { name: `Open ${CHANNEL.name}` }).click();
  await page.waitForURL(`**/c/${CHANNEL.slug}/board`);

  // Settings for a channel that is not there: the same page, pointing at the
  // same screen of the real one.
  const settings = await page.goto('/settings/stages/frist-light');
  expect(settings?.status()).toBe(404);
  await expect(
    page.getByTestId('channel-not-found').getByRole('link', { name: `Open ${CHANNEL.name}` }),
  ).toHaveAttribute('href', `/settings/stages/${CHANNEL.slug}`);

  // Any other address: the generic one, still in the frame.
  const nowhere = await page.goto('/nowhere-at-all');
  expect(nowhere?.status()).toBe(404);
  await expect(page.getByTestId('not-found').getByRole('heading', { level: 1 })).toHaveText(
    'Nothing lives at this address',
  );
});

test('a page whose read fails says so, and Try again recovers it', async ({ page }) => {
  await signIn(page);
  await page.waitForURL('**/now');
  await hydrated(page);

  /*
    A real failed read, not a mocked one: `/now`'s first read is the
    account's channels, and with the policy above PostgREST answers it with an
    error — which is what a dropped database connection looks like to the
    page (`lib/now-data.ts` throws either way). Removed in `finally`, and
    again in `afterAll`.
  */
  const found = await db.query<{ id: string }>(
    'select id from auth.users where lower(email) = lower($1)',
    [EMAIL],
  );
  await failReadsFor(found.rows[0].id);
  try {
    await page.goto('/now');
    const error = page.getByTestId('route-error');
    await expect(error.getByRole('heading', { level: 1 })).toHaveText('This page didn’t load');
    await expect(error).toContainText('Nothing you had already saved is affected.');
    await expect(error.getByRole('link', { name: 'Go to Now' })).toHaveAttribute('href', '/now');
  } finally {
    await failReadsFor(null);
  }

  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('route-error')).toHaveCount(0);
  await expect(page.locator('[data-testid="now-row"]', { hasText: IDEA })).toHaveCount(1);
});

test('a session that ends mid-edit says so, keeps the text, and saves after signing in again', async ({
  page,
  context,
}) => {
  await signIn(page);
  await page.waitForURL('**/now');
  const found = await db.query<{ id: string }>(
    `select v.id from public.videos v join auth.users u on u.id = v.user_id
      where lower(u.email) = lower($1) and v.title = $2`,
    [EMAIL, IDEA],
  );
  const videoId = found.rows[0].id;

  await page.goto(`/videos/${videoId}?section=schedule`);
  await hydrated(page);

  // The session goes — signed out in another tab, a revoked refresh token.
  await context.clearCookies();

  const notes = page.getByLabel('Notes', { exact: true });
  const typed = 'Written after the session had gone';
  await untilTaken(
    async () => {
      await notes.fill(typed);
      await notes.blur();
    },
    () =>
      expect(page.getByTestId('notes-status')).toContainText(
        'You have been signed out, so this is not saved.',
        { timeout: 5_000 },
      ),
  );

  // Before M9 this said "Could not reach the server … try again", which was
  // false, and trying again could never work.
  await expect(page.getByTestId('notes-status')).not.toContainText('Could not reach');
  await expect(notes).toHaveValue(typed);

  // The way forward keeps this tab (and its text) where it is.
  const signInLink = page.getByTestId('notes-status-sign-in');
  await expect(signInLink).toHaveAttribute('target', '_blank');
  const [tab] = await Promise.all([context.waitForEvent('page'), signInLink.click()]);
  await tab.getByLabel('Email').fill(EMAIL);
  await tab.getByLabel('Password').fill(PASSWORD);
  await tab.getByRole('button', { name: 'Sign in' }).click();
  await tab.waitForURL(`**/videos/${videoId}**`);
  await tab.close();

  // Back here, the same text saves.
  await notes.focus();
  await notes.blur();
  await expect(page.getByTestId('notes-status')).toHaveText('Saved');
  const saved = await db.query<{ notes: string | null }>(
    'select notes from public.videos where id = $1',
    [videoId],
  );
  expect(saved.rows[0].notes).toBe(typed);
});
