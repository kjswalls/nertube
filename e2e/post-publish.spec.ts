import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/**
 * The Thursday scenario: the post-publish loop, walked in a browser.
 *
 * PLAN.md's M4 line is *"Three role slots, shipped radio, swap dialog + log,
 * 24h metrics pair, always-on 'Swap thumbnail?' vs expectation, `dismissSwap`,
 * `confirmLive`, Repurposed lane toggle"* — this file is the second half of
 * that list. The thumbnail assets themselves are `e2e/thumbnails.spec.ts`.
 *
 * Five claims, each of which a reviewer will come looking for:
 *
 * 1. A click-through saved **without impressions is refused**. BRIEF.md:
 *    *never CTR alone*.
 * 2. The pair **renders together** — one control, both inputs, no way to see
 *    one without the other.
 * 3. The swap prompt **appears once metrics exist** and **turns urgent** below
 *    expectation — and renders **without a verdict** when there is nothing to
 *    compare against, rather than inventing one.
 * 4. "Keep it" **sticks across a reload**, and does not silently reappear.
 * 5. Confirming live **moves the stage and records the URL**.
 *
 * ## Two rules it follows throughout
 *
 * **Every browser claim that changes a row is paired with a read of that row.**
 * "The block said it saved" and "the database has it" are different sentences,
 * and only the second one survives a reload.
 *
 * **The fixture is SQL and the actions are clicks.** Getting a video to
 * "published 25 hours ago with no metrics" through the UI would be several
 * minutes of dragging and would test M1's board. The *state* is written
 * directly, as the owning user and in the shapes `move_video` produces;
 * everything this file is actually about is done the way a person does it.
 */

const CHANNEL = { name: 'M4 Post-publish', slug: 'm4-post-publish' };

const TITLES = {
  published: 'The one that went live yesterday',
  scheduled: 'The one going live today',
  other: 'The one that went live last month',
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

interface SeedVideo {
  title: string;
  kind: string;
  /** How long it has been in that stage, as a Postgres interval. */
  age: string;
  /** How long ago it went live, as an interval. Null = not published. */
  publishedAgo?: string;
  /** Days from today; negative is in the past. Null = no target date. */
  targetInDays?: number;
  /** Metrics already logged, as a pair — never one without the other. */
  metrics?: { impressions: number; ctr: number };
}

async function seedVideo(
  channel: { id: string; user_id: string },
  video: SeedVideo,
): Promise<string> {
  const stageId = await stageIdFor(channel.id, video.kind);

  const inserted = await db.query<{ id: string }>(
    `insert into public.videos (
       user_id, channel_id, stage_id, stage_entered_at,
       title, thumbnail_concept, hooks,
       target_publish_date, published_at,
       first24_impressions, first24_ctr, metrics_logged_at
     ) values (
       $1, $2, $3, now() - $4::interval,
       $5, 'A close-up of the thing, mid-failure',
       '[{"id":"h1","text":"The hook, as spoken","chosen":true}]'::jsonb,
       case when $6::int is null then null else (current_date + $6::int) end,
       case when $7::text is null then null else now() - $7::interval end,
       $8, $9,
       case when $8::int is null then null else now() end
     ) returning id`,
    [
      channel.user_id,
      channel.id,
      stageId,
      video.age,
      video.title,
      video.targetInDays ?? null,
      video.publishedAgo ?? null,
      video.metrics?.impressions ?? null,
      video.metrics?.ctr ?? null,
    ],
  );

  return inserted.rows[0].id;
}

async function readVideo(videoId: string) {
  const result = await db.query<{
    first24_impressions: number | null;
    first24_ctr: string | null;
    first24_views: number | null;
    new_viewers_note: string | null;
    metrics_logged_at: string | null;
    swap_dismissed_at: string | null;
    youtube_url: string | null;
    published_at: string | null;
    stage_kind: string | null;
  }>(
    `select v.first24_impressions, v.first24_ctr, v.first24_views,
            v.new_viewers_note, v.metrics_logged_at, v.swap_dismissed_at,
            v.youtube_url, v.published_at, s.kind as stage_kind
       from public.videos v
       join public.stages s on s.id = v.stage_id
      where v.id = $1`,
    [videoId],
  );
  return result.rows[0];
}

/** Is the channel's Repurposed lane switched on, as the row has it? */
async function laneEnabled(channelId: string): Promise<boolean> {
  const result = await db.query<{ is_enabled: boolean }>(
    `select is_enabled from public.stages
      where channel_id = $1 and kind = 'repurposed'`,
    [channelId],
  );
  return result.rows[0].is_enabled;
}

async function setExpectedCtr(value: number | null): Promise<void> {
  await db.query('update public.channels set expected_ctr = $2 where slug = $1', [
    CHANNEL.slug,
    value,
  ]);
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

/** The Publish section of one video, opened by URL so the server renders it. */
async function openPublish(page: Page, videoId: string): Promise<void> {
  await page.goto(`/videos/${videoId}?section=publish`);
  await expect(page.getByTestId('post-publish')).toBeVisible();
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
  await setExpectedCtr(null);

  const channel = await channelRow();
  if (!channel) throw new Error('the fixture channel is missing');

  // The lane is a per-channel flag and lives in `stages`, which this file's
  // clean-up does not touch — so it is put back deliberately.
  await db.query(
    `update public.stages set is_enabled = true
      where channel_id = $1 and kind = 'repurposed'`,
    [channel.id],
  );

  ids = {
    // Live 25 hours, nothing written down: exactly the state `/now`'s rule 2
    // is Overdue about, and the state this section exists to get out of.
    published: await seedVideo(channel, {
      title: TITLES.published,
      kind: 'published',
      age: '25 hours',
      publishedAgo: '25 hours',
    }),
    // Scheduled for today, so the date has arrived and confirming is offered.
    scheduled: await seedVideo(channel, {
      title: TITLES.scheduled,
      kind: 'scheduled',
      age: '3 days',
      targetInDays: 0,
    }),
    // A second published video with its own logged numbers, so the median
    // fallback has something to be a median *of*.
    other: await seedVideo(channel, {
      title: TITLES.other,
      kind: 'published',
      age: '30 days',
      publishedAgo: '30 days',
      metrics: { impressions: 40_000, ctr: 8 },
    }),
  };
});

/* -------------------------------------------------------------------------- */
/* 1 + 2. The pair                                                             */
/* -------------------------------------------------------------------------- */

test('impressions and click-through are one control, and one without the other is refused', async ({
  page,
}) => {
  await openPublish(page, ids.published);

  const pair = page.getByTestId('metrics-pair');
  await expect(pair).toBeVisible();

  /*
    Claim 2, asserted structurally rather than by eye: both inputs are inside
    the same control. A component that could render one without the other would
    fail this by having the CTR box somewhere else on the page.
  */
  await expect(pair.getByTestId('metrics-impressions')).toBeVisible();
  await expect(pair.getByTestId('metrics-ctr')).toBeVisible();
  await expect(
    page.getByTestId('metrics-impressions-ctr').getByTestId('metrics-ctr'),
  ).toBeVisible();
  // One pair on the page, not one per field.
  await expect(page.getByTestId('metrics-pair')).toHaveCount(1);

  // Claim 1: a click-through on its own.
  await pair.getByTestId('metrics-ctr').fill('4.2');
  await pair.getByTestId('metrics-save').click();

  await expect(page.getByTestId('metrics-error')).toContainText(
    'a click-through with no impressions is not a measurement',
  );

  // And nothing reached the row — the refusal is not cosmetic.
  const refused = await readVideo(ids.published);
  expect(refused.first24_ctr).toBeNull();
  expect(refused.first24_impressions).toBeNull();
  expect(refused.metrics_logged_at).toBeNull();

  // The pair, with the optional two alongside it.
  await pair.getByTestId('metrics-impressions').fill('12400');
  await pair.getByTestId('metrics-views').fill('520');
  await pair.getByTestId('metrics-new-viewers').fill('about half were new');
  await pair.getByTestId('metrics-save').click();

  await expect(page.getByTestId('post-publish')).toHaveAttribute(
    'data-logged',
    'true',
  );

  const saved = await readVideo(ids.published);
  expect(saved.first24_impressions).toBe(12_400);
  expect(Number(saved.first24_ctr)).toBeCloseTo(4.2, 2);
  expect(saved.first24_views).toBe(520);
  expect(saved.new_viewers_note).toBe('about half were new');
  expect(saved.metrics_logged_at).not.toBeNull();
});

/* -------------------------------------------------------------------------- */
/* 3. The prompt                                                               */
/* -------------------------------------------------------------------------- */

test('the swap prompt appears once the numbers exist, and only then', async ({
  page,
}) => {
  await openPublish(page, ids.published);

  // Nothing logged: the numbers are the question, so there is no decision yet.
  await expect(page.getByTestId('swap-prompt')).toHaveCount(0);

  await page.getByTestId('metrics-impressions').fill('12400');
  await page.getByTestId('metrics-ctr').fill('4.2');
  await page.getByTestId('metrics-save').click();

  // It renders the moment the numbers do — always, not only when the tool has
  // already decided the answer.
  await expect(page.getByTestId('swap-prompt')).toBeVisible();
  await expect(page.getByTestId('swap-prompt-numbers')).toContainText('12,400');
  await expect(page.getByTestId('swap-prompt-numbers')).toContainText('4.2%');
});

test('it turns urgent below expectation, and offers no verdict when there is nothing to compare to', async ({
  page,
}) => {
  // The channel has an expectation of its own: 6%, and this video managed 4.2.
  await setExpectedCtr(6);
  await db.query(
    `update public.videos
        set first24_impressions = 12400, first24_ctr = 4.2, metrics_logged_at = now()
      where id = $1`,
    [ids.published],
  );

  await openPublish(page, ids.published);

  const prompt = page.getByTestId('swap-prompt');
  await expect(prompt).toHaveAttribute('data-verdict', 'below');
  await expect(prompt).toHaveAttribute('data-urgent', 'true');
  await expect(page.getByTestId('swap-prompt-verdict')).toContainText(
    'points below',
  );

  // At or above the same line is the same block, quietly. Nothing is hidden.
  await setExpectedCtr(4);
  await page.reload();
  await expect(prompt).toHaveAttribute('data-verdict', 'met');
  await expect(prompt).toHaveAttribute('data-urgent', 'false');

  /*
    And with no expectation anywhere, no verdict at all.

    `expected_ctr` is cleared and the channel's only other logged video is
    removed, which leaves a median sample of one — this video compared with
    itself, which is not an expectation. PLAN.md: *none → rule skipped*;
    inventing a threshold in the one place the tool says "act fast" would be
    worse than saying nothing.
  */
  await setExpectedCtr(null);
  await db.query('delete from public.videos where id = $1', [ids.other]);
  await page.reload();
  await expect(prompt).toHaveAttribute('data-verdict', 'unknown');
  await expect(prompt).toHaveAttribute('data-urgent', 'false');
  await expect(page.getByTestId('swap-prompt-verdict')).toContainText(
    'nothing to measure this against yet',
  );
});

test('the median fallback needs a sample the video cannot decide on its own', async ({
  page,
}) => {
  await setExpectedCtr(null);
  await db.query(
    `update public.videos
        set first24_impressions = 12400, first24_ctr = 4.2, metrics_logged_at = now()
      where id = $1`,
    [ids.published],
  );

  /*
    Two logged videos is not a sample, and the arithmetic is why.

    The median of two numbers is their mean, and the sample deliberately
    includes the video being judged — so the *worse* of any two videos is
    always strictly below "expectation" and the better one is always at or
    above, whatever the numbers are. A red prompt and an Overdue `/now` row
    manufactured out of a single comparison, in the one place the product tells
    you to act fast. At this point the channel has exactly two: this one at 4.2%
    and the fixture's other at 8%.
  */
  await openPublish(page, ids.published);
  await expect(page.getByTestId('swap-prompt')).toHaveAttribute(
    'data-verdict',
    'unknown',
  );
  await expect(page.getByTestId('swap-prompt-verdict')).toContainText(
    'nothing to measure this against yet',
  );

  // A third gives a median that survives removing the subject: {4.2, 5.4, 8}
  // has a middle value of 5.4, and 4.2 is below it.
  const channel = await channelRow();
  if (!channel) throw new Error('the fixture channel is missing');
  await seedVideo(channel, {
    title: 'A third, for the sample',
    kind: 'published',
    age: '60 days',
    publishedAgo: '60 days',
    metrics: { impressions: 30_000, ctr: 5.4 },
  });

  await page.reload();
  await expect(page.getByTestId('swap-prompt')).toHaveAttribute(
    'data-verdict',
    'below',
  );
  await expect(page.getByTestId('swap-prompt-verdict')).toContainText(
    'median of its last 3 logged videos',
  );
});

test('the swap prompt stands down once the swap has been made', async ({ page }) => {
  /*
    BRIEF.md principle 8 asks the creator to look at the numbers and swap fast.
    Having done exactly that, they were met with a block that kept the red
    border, the red heading and "Act now rather than in a week" directly above
    its own sentence saying a swap had already been logged — and still offered
    "Keep it", which would have written `swap_dismissed_at` for a thumbnail
    that was not kept. `/now` has always excluded a swap logged after the
    metrics; the two surfaces are supposed to be one claim about one video.
  */
  await setExpectedCtr(6);
  await db.query(
    `update public.videos
        set first24_impressions = 9400, first24_ctr = 2.1, metrics_logged_at = now()
      where id = $1`,
    [ids.published],
  );

  await openPublish(page, ids.published);
  const prompt = page.getByTestId('swap-prompt');
  await expect(prompt).toHaveAttribute('data-urgent', 'true');
  await expect(prompt.getByTestId('swap-prompt-keep')).toBeVisible();

  /*
    A swap, logged after the metrics. Written as SQL for the same reason the
    rest of this file's state is: `e2e/thumbnails.spec.ts` is where the
    `swap_thumbnail` round trip is proved, and what this spec is about is what
    the Publish section then *says*. The shapes are the ones the function
    produces — the role moves and the log gains a row, in that order.
  */
  await db.query(
    `update public.videos
        set thumb_wild_card_path = 'seed/wild_card.png',
            thumb_safe_path = 'seed/safe.png',
            shipped_role = 'safe'
      where id = $1`,
    [ids.published],
  );
  await db.query(
    `insert into public.thumbnail_swaps (user_id, video_id, from_role, to_role, reason)
     select v.user_id, v.id, 'wild_card', 'safe', 'CTR 2.1% against an expected 6%'
       from public.videos v where v.id = $1`,
    [ids.published],
  );

  await page.reload();

  await expect(prompt).toHaveAttribute('data-verdict', 'below');
  await expect(prompt).toHaveAttribute('data-urgent', 'false');
  await expect(prompt.getByTestId('swap-prompt-already-swapped')).toBeVisible();
  await expect(page.getByTestId('swap-prompt-verdict')).not.toContainText(
    'Act now rather than in a week',
  );
  // "Keep it" is not offered for a thumbnail that was not kept.
  await expect(prompt.getByTestId('swap-prompt-keep')).toHaveCount(0);
  expect((await readVideo(ids.published)).swap_dismissed_at).toBeNull();
});

/* -------------------------------------------------------------------------- */
/* 4. Keeping it                                                               */
/* -------------------------------------------------------------------------- */

test('"keep it" sticks across a reload, and does not quietly come back', async ({
  page,
}) => {
  await setExpectedCtr(6);
  await db.query(
    `update public.videos
        set first24_impressions = 12400, first24_ctr = 4.2, metrics_logged_at = now()
      where id = $1`,
    [ids.published],
  );

  await openPublish(page, ids.published);

  const prompt = page.getByTestId('swap-prompt');
  await expect(prompt).toHaveAttribute('data-urgent', 'true');

  await prompt.getByTestId('swap-prompt-keep').click();
  await expect(prompt).toHaveAttribute('data-dismissed', 'true');

  // The row, not the screen.
  const kept = await readVideo(ids.published);
  expect(kept.swap_dismissed_at).not.toBeNull();

  await page.reload();

  /*
    Still dismissed, and still *there*. "Keep it" is a judgement about a
    thumbnail, not the dismissal of a notification: the prompt says when the
    decision was made and offers to reopen it, because the numbers it was made
    against are still on the screen above it.
  */
  await expect(prompt).toHaveAttribute('data-dismissed', 'true');
  await expect(prompt).toHaveAttribute('data-urgent', 'false');
  await expect(page.getByTestId('swap-prompt-dismissed')).toBeVisible();
  await expect(page.getByTestId('swap-prompt-keep')).toHaveCount(0);

  // And `/now` has stopped asking: rule 3 reads the same column.
  await page.goto('/now');
  await expect(page.getByTestId('now')).toHaveAttribute('data-ready', 'true');
  await expect(
    page
      .locator(`[data-testid="now-row"][data-video-id="${ids.published}"]`)
      .filter({ hasText: 'Swap thumbnail?' }),
  ).toHaveCount(0);

  // Reopening is possible, which is what stops "keep it" being a decision
  // nobody dares make.
  await openPublish(page, ids.published);
  await page.getByTestId('swap-prompt-reopen').click();
  await expect(prompt).toHaveAttribute('data-dismissed', 'false');
  const reopened = await readVideo(ids.published);
  expect(reopened.swap_dismissed_at).toBeNull();
});

/* -------------------------------------------------------------------------- */
/* 5. Confirm live                                                             */
/* -------------------------------------------------------------------------- */

test('confirming live moves the stage and records the URL', async ({ page }) => {
  await openPublish(page, ids.scheduled);

  const confirm = page.getByTestId('confirm-live');
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveAttribute('data-due', 'true');

  // It is a URL field and it means it.
  await confirm.getByTestId('confirm-live-url').fill('tomorrow, probably');
  await confirm.getByTestId('confirm-live-save').click();
  await expect(page.getByTestId('confirm-live-note')).toContainText(
    'That is not a link',
  );
  expect((await readVideo(ids.scheduled)).stage_kind).toBe('scheduled');

  await confirm
    .getByTestId('confirm-live-url')
    .fill('https://www.youtube.com/watch?v=abc123');
  await confirm.getByTestId('confirm-live-save').click();

  // The section redraws as a live video: the confirm form is gone and the
  // first-24-hours block has taken its place.
  await expect(page.getByTestId('post-publish')).toHaveAttribute(
    'data-published',
    'true',
  );
  await expect(page.getByTestId('publish-live-url')).toHaveAttribute(
    'href',
    'https://www.youtube.com/watch?v=abc123',
  );

  const live = await readVideo(ids.scheduled);
  expect(live.stage_kind).toBe('published');
  expect(live.youtube_url).toBe('https://www.youtube.com/watch?v=abc123');
  expect(live.published_at).not.toBeNull();

  /*
    `published_at` is the **target date**, not the moment the row was ticked.
    PLAN.md ranking rule 5, and the reason it matters: the 24-hour metrics
    prompt counts from here, so stamping "now" would make the whole loop late.
    The target was today, so the stamp is today at midnight UTC.
  */
  const stamped = await db.query<{ same: boolean }>(
    // Built as an explicit UTC instant rather than casting the `date`, which
    // would mean midnight in whatever timezone this database happens to be set
    // to and would make the assertion pass or fail on the container's clock.
    `select (v.published_at = ((v.target_publish_date::text || 'T00:00:00Z')::timestamptz)) as same
       from public.videos v where v.id = $1`,
    [ids.scheduled],
  );
  expect(stamped.rows[0].same).toBe(true);
});

test('a confirm the packaging gate refuses names the missing field, not `gate:`', async ({
  page,
}) => {
  /*
    The packaging fields stay editable at every stage, so a video that reached
    Scheduled and then had its concept cleared hits `move_video`'s gate the next
    time somebody confirms it live. `confirmLive` was the one caller of that RPC
    that did not translate the refusal, so what reached the screen — here and in
    `/now`'s toast — was the raw `gate:thumbnail_concept` token. Nobody can act
    on that, which is the whole reason `app/actions/moves.ts` has had wording
    for it since M1.
  */
  await db.query(
    `update public.videos set thumbnail_concept = null where id = $1`,
    [ids.scheduled],
  );

  await openPublish(page, ids.scheduled);

  const confirm = page.getByTestId('confirm-live');
  await confirm.getByTestId('confirm-live-url').fill('https://youtu.be/qwertyuiop1');
  await confirm.getByTestId('confirm-live-save').click();

  const note = page.getByTestId('confirm-live-note');
  await expect(note).toContainText('The URL is saved');
  await expect(note).toContainText('a thumbnail concept written down');
  await expect(note).not.toContainText('gate:');

  // Both halves of the sentence are true: the link landed, the move did not.
  const row = await readVideo(ids.scheduled);
  expect(row.youtube_url).toBe('https://youtu.be/qwertyuiop1');
  expect(row.stage_kind).toBe('scheduled');
});

/* -------------------------------------------------------------------------- */
/* The Repurposed lane                                                         */
/* -------------------------------------------------------------------------- */

test('the Repurposed lane can be switched off, unless it is holding something', async ({
  page,
}) => {
  const channel = await channelRow();
  if (!channel) throw new Error('the fixture channel is missing');

  await openPublish(page, ids.published);

  const lane = page.getByTestId('repurposed-lane');
  await expect(lane).toHaveAttribute('data-enabled', 'true');

  // `click`, not `uncheck`: the switch is a controlled checkbox whose state
  // follows a server round trip, so Playwright's own "did the box change"
  // check races the write.
  await lane.getByTestId('repurposed-toggle').click();
  await expect(lane).toHaveAttribute('data-enabled', 'false');
  await expect(lane.getByTestId('repurposed-toggle')).not.toBeChecked();

  // The row, polled rather than read once: the switch moves optimistically, so
  // the screen is ahead of the database by one round trip and a single read
  // here would be asking the question too early. (The optimism is not for
  // speed — a controlled checkbox that waits for the server springs back on
  // click and reads as "that did nothing". The rollback is in the component.)
  await expect.poll(() => laneEnabled(channel.id)).toBe(false);

  // Back on, then park a video in it: now it cannot be switched off, because
  // that would hide the video from the board and from /now rather than hide a
  // column.
  await lane.getByTestId('repurposed-toggle').click();
  await expect(lane).toHaveAttribute('data-enabled', 'true');
  await expect.poll(() => laneEnabled(channel.id)).toBe(true);

  const repurposed = await stageIdFor(channel.id, 'repurposed');
  await db.query(
    `update public.videos set stage_id = $2 where id = $1`,
    [ids.published, repurposed],
  );

  await openPublish(page, ids.published);
  await expect(page.getByTestId('repurposed-toggle')).toBeDisabled();
  await expect(page.getByTestId('repurposed-note')).toContainText(
    'switching the stage off would hide it',
  );
});
