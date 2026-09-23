import { mkdirSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';
import { Client } from 'pg';

import {
  CHANNEL_DEFAULTS,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
} from '../lib/defaults';
import { todayColumn } from '../lib/calendar-dates';
import { PG, SEED_EMAIL, SEED_PASSWORD, SEED_TIME_ZONE } from '../scripts/dev-stack/shared';
import { untilTaken } from './hydration';
import { makePng } from './png';

/**
 * M9 acceptance — PLAN.md:200, *"whole-week walkthrough on a phone and a
 * laptop"*.
 *
 * One idea, carried the whole way through the product by the controls a person
 * would use, twice: once at 1440×900 with a mouse and the keyboard, and once
 * at 390×844 as a touch device (`hasTouch`, `isMobile`, so `pointer: coarse`
 * is really true and every press is a tap). Nothing is moved by SQL once the
 * walk starts. The fixture sets up only what a real week would already have
 * lying around: three topic pillars, two other videos waiting on a camera in
 * another channel, and two earlier published videos whose click-through is the
 * bar the swap prompt measures against.
 *
 * The steps are BRIEF.md's pipeline in order — capture, file it in the matrix,
 * promote, package (title, thumbnail concept, hook), through the gate,
 * schedule a filming day from the board's badge, script it, edit it, publish
 * it, log the first 24 hours, swap a thumbnail — and each one saves a
 * screenshot under `test-results/m9-week/` so the walk can be looked at, not
 * only asserted. What each step was *like* is written up in
 * `docs/MILESTONES.md` ("M9 — Integration"); this file is what makes that
 * account repeatable.
 *
 * Two things the walk does that a person would not, and why:
 * - "The first 24 hours" are logged from the video's Publish section on the
 *   same day it went live, because nothing here can advance a clock. `/now`'s
 *   rule 2 (24h passed, nothing logged) is `lib/next-action.test.ts`'s to
 *   prove; the metrics form is the same component either way.
 * - The two other Filming videos belong to a second fixture channel, so the
 *   badge's "3 in Filming" is reached by this walk's own video arriving — the
 *   moment principle 4 is about.
 */

const SHOTS = 'test-results/m9-week';
const PIN = { wild: makePng(4, 2, [220, 40, 40]), moderate: makePng(6, 3, [40, 160, 90]), safe: makePng(8, 4, [40, 60, 220]) };

let db: Client;
let userId: string;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  db = new Client({ ...PG });
  await db.connect();
  const found = await db.query<{ id: string }>(
    'select id from auth.users where lower(email) = lower($1)',
    [SEED_EMAIL],
  );
  if (found.rows.length === 0) {
    throw new Error(`the dev stack has no user ${SEED_EMAIL}; is it the stack this suite started?`);
  }
  userId = found.rows[0].id;
  await cleanUp();
});

test.afterAll(async () => {
  await cleanUp();
  await db?.end();
});

async function cleanUp(): Promise<void> {
  await db.query(
    `update public.videos set filming_day_id = null
      where channel_id in (select id from public.channels where slug like 'm9-week%')`,
  );
  await db.query(
    `delete from public.filming_days f
      where f.user_id = $1
        and not exists (select 1 from public.videos v where v.filming_day_id = f.id)
        and f.notes = 'm9-week'`,
    [userId],
  );
  await db.query(
    `delete from storage.objects
      where bucket_id = 'thumbnails'
        and split_part(name, '/', 2) in (
          select v.id::text from public.videos v
            join public.channels c on c.id = v.channel_id
           where c.slug like 'm9-week%')`,
  );
  await db.query(
    `delete from public.thumbnail_swaps
      where video_id in (select v.id from public.videos v join public.channels c
                          on c.id = v.channel_id where c.slug like 'm9-week%')`,
  );
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug like 'm9-week%')`,
  );
  await db.query("delete from public.channels where slug like 'm9-week%'");
}

/** Run `fn` the way a PostgREST request runs it: that role, those claims. */
async function asUser<T>(fn: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated', email: SEED_EMAIL }),
    ]);
    await db.query('set local role authenticated');
    const result = await fn();
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback').catch(() => {});
    throw error;
  }
}

async function createChannel(name: string, slug: string): Promise<string> {
  const stages = SEED_STAGES.map((stage) => ({
    name: stage.name,
    kind: stage.kind,
    position: stage.position,
    templates: SEED_CHECKLISTS[stage.kind].map((item, index) => ({
      text: item.text,
      position: index + 1,
      est_minutes: item.est_minutes,
    })),
  }));
  return asUser(async () => {
    const result = await db.query<{ id: string }>(
      `select id from create_channel($1::text, $2::text, $3::text, $4::int, $5::int,
                                     $6::numeric, $7::text, $8::jsonb, $9::jsonb)`,
      [
        name,
        slug,
        SCRIPT_TEMPLATE,
        CHANNEL_DEFAULTS.wip_threshold,
        CHANNEL_DEFAULTS.stale_days,
        CHANNEL_DEFAULTS.expected_ctr,
        CHANNEL_DEFAULTS.voice_guide,
        JSON.stringify(stages),
        JSON.stringify(SEED_BUCKETS.map((bucket) => ({ ...bucket, monthly_quota: null }))),
      ],
    );
    return result.rows[0].id;
  });
}

async function stageId(channelId: string, kind: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    'select id from public.stages where channel_id = $1 and kind = $2',
    [channelId, kind],
  );
  return result.rows[0].id;
}

async function captureBySql(channelId: string, title: string): Promise<string> {
  return asUser(async () => {
    const result = await db.query<{ id: string }>(
      'select id from capture_video($1::uuid, $2::text)',
      [channelId, title],
    );
    return result.rows[0].id;
  });
}

interface Week {
  channel: { id: string; name: string; slug: string };
  title: string;
}

/**
 * What a real Monday already has: pillars named, two videos from the other
 * channel waiting on a camera, two earlier videos with a click-through on
 * record (and their own swap question already answered).
 */
async function setUpWeek(label: 'laptop' | 'phone'): Promise<Week> {
  const name = label === 'laptop' ? 'M9 Week Laptop' : 'M9 Week Phone';
  const slug = `m9-week-${label}`;
  const id = await createChannel(name, slug);

  for (const [index, pillar] of ['Sleep', 'Money', 'Tools'].entries()) {
    await db.query(
      `insert into public.buckets (user_id, channel_id, axis, name, position)
       values ($1, $2, 'vertical', $3, $4)`,
      [userId, id, pillar, index + 1],
    );
  }

  const otherId = await createChannel(`M9 Week Other ${label}`, `m9-week-other-${label}`);
  const otherFilming = await stageId(otherId, 'filming');
  for (const title of ['Other: desk tour', 'Other: kettle review']) {
    const video = await captureBySql(otherId, title);
    await db.query(
      `update public.videos set title = $2, thumbnail_concept = 'x',
              hooks = '[{"id":"h","text":"h","chosen":true}]'::jsonb where id = $1`,
      [video, title],
    );
    await asUser(async () => {
      await db.query('select * from move_video($1::uuid, $2::uuid)', [video, otherFilming]);
    });
  }

  const published = await stageId(id, 'published');
  for (const [index, ctr] of [5.4, 5.0].entries()) {
    const video = await captureBySql(id, `Earlier video ${index + 1}`);
    await db.query(
      `update public.videos
          set stage_id = $2,
              thumbnail_concept = 'An earlier concept.',
              hooks = '[{"id":"h","text":"An earlier hook.","chosen":true}]'::jsonb,
              published_at = now() - ($3 || ' days')::interval,
              first24_impressions = 11000,
              first24_ctr = $4,
              metrics_logged_at = now() - ($3 || ' days')::interval,
              swap_dismissed_at = now() - ($3 || ' days')::interval
        where id = $1`,
      [video, published, String(20 + index * 7), ctr],
    );
  }

  return {
    channel: { id, name, slug },
    title: label === 'laptop' ? 'I slept 9 hours for 30 days' : 'I tracked every coffee for a month',
  };
}

async function videoRow(id: string) {
  const result = await db.query<{
    kind: string;
    title: string;
    vertical: string | null;
    horizontal: string | null;
    thumbnail_concept: string | null;
    chosen_hooks: number;
    script: string | null;
    filming_day_id: string | null;
    shipped_role: string | null;
    youtube_url: string | null;
    first24_ctr: string | null;
    first24_impressions: number | null;
    candidates: number;
  }>(
    `select s.kind, v.title,
            (select name from public.buckets b where b.id = v.vertical_id) as vertical,
            (select name from public.buckets b where b.id = v.horizontal_id) as horizontal,
            v.thumbnail_concept,
            (select count(*)::int from jsonb_array_elements(v.hooks) h where (h->>'chosen')::boolean) as chosen_hooks,
            v.script, v.filming_day_id, v.shipped_role, v.youtube_url,
            v.first24_ctr, v.first24_impressions,
            jsonb_array_length(v.title_candidates)::int as candidates
       from public.videos v join public.stages s on s.id = v.stage_id
      where v.id = $1`,
    [id],
  );
  return result.rows[0];
}

/* -------------------------------------------------------------------------- */
/* How a person presses things                                                 */
/* -------------------------------------------------------------------------- */

type Device = 'laptop' | 'phone';

/** A tap on the phone, a click on the laptop. */
async function press(device: Device, target: Locator): Promise<void> {
  if (device === 'phone') await target.tap();
  else await target.click();
}

async function shot(page: Page, device: Device, step: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${device}-${step}.png`, fullPage: false });
}

/** No sideways scroll on the page at this width, on this step. */
async function noSidewaysScroll(page: Page): Promise<void> {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, 'the page scrolls sideways').toBeLessThanOrEqual(client);
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}

/** Open the video page and wait until its controls are live. */
async function openVideo(page: Page, id: string, section?: string): Promise<void> {
  await page.goto(`/videos/${id}${section ? `?section=${section}` : ''}`);
  await expect(page.getByTestId(`section-tab-${section ?? 'packaging'}`)).toBeVisible();
}

const nowRow = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="now-row"][data-video-id="${id}"]`);

/**
 * Work one video's rows on `/now` until it offers something other than a tick.
 *
 * The laptop does it the way PLAN.md's Monday scenario describes — select the
 * row, press `x` — and the phone taps the sentence (the tick is a label that
 * wraps the box and the words, M9). Returns how many ticks it took, which is
 * the honest measure of a stage on this page.
 */
async function tickThrough(page: Page, device: Device, id: string): Promise<number> {
  let ticks = 0;
  for (;;) {
    const row = nowRow(page, id);
    await expect(row).toBeVisible();
    const input = await row.getAttribute('data-input');
    if (input !== 'tick') return ticks;
    const label = (await row.getByTestId('now-label').innerText()).trim();

    if (device === 'laptop') {
      await untilTaken(
        async () => {
          if ((await row.getAttribute('data-selected')) !== 'true') {
            await row.focus();
            await page.keyboard.press('j');
          }
        },
        async () => expect(row).toHaveAttribute('data-selected', 'true', { timeout: 1_500 }),
      );
      await page.keyboard.press('x');
    } else {
      await row.getByTestId('now-tick-target').tap();
    }

    await expect(async () => {
      const current = nowRow(page, id);
      const still =
        (await current.count()) > 0 &&
        (await current.getAttribute('data-input')) === 'tick' &&
        (await current.getByTestId('now-label').innerText()).trim() === label;
      expect(still, `the tick on “${label}” did not land`).toBe(false);
    }).toPass({ timeout: 15_000 });
    ticks += 1;
    if (ticks > 20) throw new Error('more than twenty ticks in one stage');
  }
}

/** Press `/now`'s Move row for this video and wait for the stage to change. */
async function moveFromNow(page: Page, device: Device, id: string, toKind: string): Promise<void> {
  const row = nowRow(page, id);
  await expect(row).toHaveAttribute('data-input', 'move');
  await press(device, row.getByTestId('now-move'));
  await expect.poll(async () => (await videoRow(id)).kind).toBe(toKind);
  // The row re-ranks in place once the page hears back; until then it still
  // offers the move it just made.
  await expect(async () => {
    const current = nowRow(page, id);
    const stale =
      (await current.count()) > 0 && (await current.getAttribute('data-input')) === 'move';
    expect(stale, 'the row still offers the move it made').toBe(false);
  }).toPass({ timeout: 15_000 });
}

/** Narrow `/now` to one channel, the way the chips are meant to be used. */
async function onlyChannel(page: Page, device: Device, name: string): Promise<void> {
  const chip = page.getByTestId('channel-chip').filter({ hasText: name });
  await untilTaken(
    async () => {
      if ((await chip.getAttribute('aria-pressed')) !== 'true') await press(device, chip);
    },
    async () => expect(chip).toHaveAttribute('aria-pressed', 'true', { timeout: 1_500 }),
  );
}

/* -------------------------------------------------------------------------- */
/* The week                                                                    */
/* -------------------------------------------------------------------------- */

async function walkTheWeek(page: Page, device: Device): Promise<void> {
  const week = await setUpWeek(device);
  const { channel } = week;
  await signIn(page);

  /* ------------------------------------------------ Monday: capture ---- */
  await test.step('capture an idea', async () => {
    await page.goto(`/c/${channel.slug}/board`);
    await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
    const open = page.locator('[data-shortcut-ready="true"]').first();
    await expect(open).toBeAttached();
    if (device === 'laptop') {
      await page.keyboard.press('c');
    } else {
      await open.tap();
    }
    const dialog = page.getByRole('dialog', { name: 'Capture an idea' });
    await expect(dialog).toBeVisible();
    await page.keyboard.type(week.title);
    await shot(page, device, '01-capture');
    if (device === 'laptop') {
      await page.keyboard.press('Enter');
    } else {
      await dialog.getByTestId('capture-submit-inline').tap();
    }
    await expect(dialog).toHaveCount(0);
  });

  const captured = await db.query<{ id: string }>(
    'select id from public.videos where channel_id = $1 and title = $2',
    [channel.id, week.title],
  );
  expect(captured.rows).toHaveLength(1);
  const id = captured.rows[0].id;
  expect((await videoRow(id)).kind).toBe('idea');

  /* ---------------------------------------------- file it in the matrix ---- */
  await test.step('file it in the matrix', async () => {
    // The matrix cannot file an idea that already exists (its empty cells
    // capture new ones); filing is on the video page. So: the bank, the idea,
    // its two buckets, then back to the matrix to see it land.
    await page.goto(`/c/${channel.slug}/ideas`);
    const row = page.locator(`[data-testid="idea-row"][data-video-id="${id}"]`);
    await expect(row).toBeVisible();
    await press(device, row.getByTestId('idea-open'));
    await page.waitForURL(`**/videos/${id}**`);
    await expect(page.getByTestId('filing-block')).toBeAttached();
    await page.getByTestId('filing-block').scrollIntoViewIfNeeded();
    await untilTaken(
      () => page.getByTestId('video-vertical').selectOption({ label: 'Sleep' }).then(() => {}),
      async () => expect.poll(async () => (await videoRow(id)).vertical, { timeout: 3_000 }).toBe('Sleep'),
    );
    await page.getByTestId('video-horizontal').selectOption({ label: 'self-experiment' });
    await expect.poll(async () => (await videoRow(id)).horizontal).toBe('self-experiment');
    await shot(page, device, '02-filed');

    await page.goto(`/c/${channel.slug}/ideas?view=matrix`);
    await expect(page.getByTestId('matrix-grid')).toBeVisible();
    await noSidewaysScroll(page);
    const filed = page.getByTestId('matrix-grid').locator(`a[href*="${id}"], [data-video-id="${id}"]`);
    const cell = page.getByTestId('matrix-cell').filter({ hasText: '1' });
    await expect(filed.or(cell).first()).toBeVisible();
    await shot(page, device, '03-matrix');
  });

  /* ------------------------------------------------------- promote ---- */
  await test.step('promote it', async () => {
    await page.goto(`/c/${channel.slug}/ideas`);
    const row = page.locator(`[data-testid="idea-row"][data-video-id="${id}"]`);
    await expect(row).toBeVisible();
    if (device === 'laptop') {
      await untilTaken(
        async () => {
          if ((await row.getAttribute('data-selected')) !== 'true') {
            await row.focus();
            await page.keyboard.press('j');
          }
        },
        async () => expect(row).toHaveAttribute('data-selected', 'true', { timeout: 1_500 }),
      );
      await page.keyboard.press('p');
    } else {
      await row.getByTestId('idea-promote').tap();
    }
    await expect.poll(async () => (await videoRow(id)).kind).toBe('packaging');
    // Gone from the bank once the page hears back.
    await expect(row).toHaveCount(0);
    await shot(page, device, '04-promoted');
  });

  /* ------------------------------------------------------- package ---- */
  await test.step('package it: title, thumbnail concept, hook', async () => {
    await openVideo(page, id);
    await expect(page.getByTestId('gate-indicator')).toBeVisible();

    // Title candidates from the assist (the fake provider: no key here).
    const pill = page.locator('[data-testid="assist-pill"][data-assist="Generate 20"]');
    await untilTaken(
      async () => {
        if ((await page.getByTestId('brainstorm-panel').count()) === 0) await press(device, pill);
      },
      async () => expect(page.getByTestId('brainstorm-panel')).toBeVisible({ timeout: 2_000 }),
    );
    await expect(page.getByTestId('brainstorm-suggestion').first()).toBeVisible();
    await shot(page, device, '05-brainstorm');
    await press(device, page.getByTestId('brainstorm-add-all'));
    await expect.poll(async () => (await videoRow(id)).candidates).toBeGreaterThanOrEqual(10);
    await press(device, page.getByTestId('brainstorm-close'));

    // Choose one: it becomes the working title.
    const firstCandidate = page.getByTestId('candidate-row').first();
    await press(device, firstCandidate.getByTestId('candidate-choose'));
    await expect.poll(async () => (await videoRow(id)).title).not.toBe(week.title);

    const concept = page.getByTestId('thumbnail-concept');
    await concept.fill('Me asleep at 9pm, phone face down, the clock reading 21:04 in red.');
    await concept.blur();
    await expect.poll(async () => (await videoRow(id)).thumbnail_concept).toContain('21:04');

    for (const hook of [
      'Nine hours a night for a month changed one number I did not expect.',
      'I went to bed at nine for thirty days. My calendar hated it.',
      'Sleep is the cheapest upgrade I have tested. Here is the bill.',
    ]) {
      await page.getByTestId('hook-input').fill(hook);
      await page.getByTestId('hook-input').press('Enter');
    }
    await expect(page.getByTestId('hook-row')).toHaveCount(3);
    await press(device, page.getByTestId('hook-row').nth(0).getByTestId('hook-choose'));
    await expect.poll(async () => (await videoRow(id)).chosen_hooks).toBe(1);
    await expect(page.getByTestId('gate-indicator')).toHaveAttribute('data-gate', 'ready');
    await noSidewaysScroll(page);
    await shot(page, device, '06-packaged');
  });

  /* ------------------------------------------- through the gate ---- */
  await test.step('move it through the gate', async () => {
    await page.goto(`/c/${channel.slug}/board`);
    await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
    const card = page.locator(`[data-testid="board-card"][data-video-id="${id}"]`);
    await expect(card).toBeVisible();
    if (device === 'laptop') {
      await card.click();
      await page.keyboard.press(']');
    } else {
      await card.locator('button[data-move="forward"]').tap();
    }
    await expect.poll(async () => (await videoRow(id)).kind).toBe('scripting');
    await shot(page, device, '07-gate');
  });

  /* ---------------------------------------------------- script ---- */
  await test.step('script it', async () => {
    await openVideo(page, id, 'script');
    await expect(page.getByTestId('script-editor')).toHaveValue(/Nine hours a night/);
    await shot(page, device, '08-script');

    await page.goto('/now');
    await onlyChannel(page, device, channel.name);
    const ticks = await tickThrough(page, device, id);
    expect(ticks).toBe(SEED_CHECKLISTS.scripting.length);
    await shot(page, device, '09-now-scripting-done');
    await moveFromNow(page, device, id, 'filming');
  });

  /* --------------------------------- schedule a filming day from the badge ---- */
  await test.step('schedule a filming day from the board badge', async () => {
    await page.goto(`/c/${channel.slug}/board`);
    await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
    const badge = page.getByTestId('filming-badge');
    await expect(badge).toBeVisible();
    // On a phone the strip opens at the first column with work in it, so the
    // badge is on screen without a swipe (M9).
    await expect(badge).toBeInViewport();
    await shot(page, device, '10-badge');
    await untilTaken(
      async () => {
        if ((await page.getByTestId('schedule-day-dialog').count()) === 0) await press(device, badge);
      },
      async () => expect(page.getByTestId('schedule-day-dialog')).toBeVisible({ timeout: 2_000 }),
    );
    const dialog = page.getByTestId('schedule-day-dialog');
    // Only this week's three: leftovers from anywhere else stay off the day.
    const ours = new Set<string>([id]);
    const other = await db.query<{ id: string }>(
      `select v.id from public.videos v join public.channels c on c.id = v.channel_id
        where c.slug = $1`,
      [`m9-week-other-${device}`],
    );
    for (const row of other.rows) ours.add(row.id);
    const boxes = dialog.getByTestId('filming-candidate');
    for (let index = 0; index < (await boxes.count()); index += 1) {
      const box = boxes.nth(index);
      const want = ours.has((await box.getAttribute('data-video-id')) ?? '');
      if ((await box.isChecked()) !== want) await press(device, box);
    }
    // Far enough out that no other spec's day is on it (one day per date).
    const shoot = new Date(Date.now() + (device === 'laptop' ? 211 : 212) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await dialog.getByTestId('filming-day-date').fill(shoot);
    await dialog.getByTestId('filming-day-notes-new').fill('m9-week');
    await shot(page, device, '11-schedule-day');
    await press(device, dialog.getByTestId('schedule-day-submit'));
    await expect.poll(async () => (await videoRow(id)).filming_day_id).not.toBeNull();
    await shot(page, device, '12-day-booked');
  });

  /* ---------------------------------------- film and edit it ---- */
  await test.step('film it and edit it', async () => {
    await page.goto('/now');
    await onlyChannel(page, device, channel.name);
    expect(await tickThrough(page, device, id)).toBe(SEED_CHECKLISTS.filming.length);
    await moveFromNow(page, device, id, 'editing');
    expect(await tickThrough(page, device, id)).toBe(SEED_CHECKLISTS.editing.length);
    await shot(page, device, '13-edited');
    await moveFromNow(page, device, id, 'publish_prep');
  });

  /* ------------------------------ publish prep: three variants, a date ---- */
  await test.step('prepare it: three thumbnails and a date', async () => {
    await openVideo(page, id, 'thumbnails');
    const slot = (role: string) => page.locator(`[data-testid="variant-slot"][data-role="${role}"]`);
    for (const [role, buffer] of [
      ['wild_card', PIN.wild],
      ['moderate', PIN.moderate],
      ['safe', PIN.safe],
    ] as const) {
      await slot(role).getByTestId('variant-file').setInputFiles({
        name: `${role}.png`,
        mimeType: 'image/png',
        buffer,
      });
      await expect(slot(role).getByTestId('variant-status')).toHaveText(/saved$/);
    }
    await press(device, slot('wild_card').getByTestId('variant-ship'));
    await expect.poll(async () => (await videoRow(id)).shipped_role).toBe('wild_card');
    await expect(slot('wild_card').getByTestId('variant-live-badge')).toBeVisible();
    await noSidewaysScroll(page);
    await shot(page, device, '14-thumbnails');

    await openVideo(page, id, 'schedule');
    // Today in the seed account's zone (M10), not the machine's.
    const today = todayColumn(Date.now(), SEED_TIME_ZONE);
    const date = page.getByTestId('target-date');
    await untilTaken(
      async () => {
        // Cleared first so a repeat is a change: a fill swallowed before
        // hydration leaves the value in the box and the draft empty.
        await date.fill('');
        await date.fill(today);
        await date.blur();
      },
      async () =>
        expect
          .poll(
            async () =>
              (
                await db.query<{ d: string | null }>(
                  "select to_char(target_publish_date, 'YYYY-MM-DD') as d from public.videos where id = $1",
                  [id],
                )
              ).rows[0].d,
            { timeout: 3_000 },
          )
          .toBe(today),
    );

    await page.goto('/now');
    await onlyChannel(page, device, channel.name);
    expect(await tickThrough(page, device, id)).toBe(SEED_CHECKLISTS.publish_prep.length);
    await moveFromNow(page, device, id, 'scheduled');
  });

  /* --------------------------------------------------- publish ---- */
  await test.step('publish it', async () => {
    await page.goto('/now');
    await onlyChannel(page, device, channel.name);
    const row = nowRow(page, id);
    await expect(row).toHaveAttribute('data-input', 'url');
    await row.getByTestId('now-text').fill('https://www.youtube.com/watch?v=m9week' + device);
    await shot(page, device, '15-confirm-live');
    await press(device, row.getByTestId('now-text-save'));
    await expect.poll(async () => (await videoRow(id)).kind).toBe('published');
  });

  /* ---------------------------------------- the first 24 hours ---- */
  await test.step('log the first 24 hours', async () => {
    await openVideo(page, id, 'publish');
    const pair = page.getByTestId('metrics-pair');
    await expect(pair).toBeVisible();
    await pair.getByTestId('metrics-impressions').fill('8200');
    await pair.getByTestId('metrics-ctr').fill('2.4');
    await pair.getByTestId('metrics-views').fill('190');
    await shot(page, device, '16-metrics');
    await press(device, pair.getByTestId('metrics-save'));
    await expect(page.getByTestId('metrics-logged-at')).toContainText('Logged');
    await expect(page.getByTestId('swap-prompt')).toHaveAttribute('data-verdict', 'below');
    await noSidewaysScroll(page);
    await shot(page, device, '17-swap-prompt');
  });

  /* --------------------------------------------- swap a thumbnail ---- */
  await test.step('swap a thumbnail', async () => {
    await page.goto('/now');
    await onlyChannel(page, device, channel.name);
    const row = nowRow(page, id);
    await expect(row).toHaveAttribute('data-input', 'swap');
    await press(device, row.getByTestId('now-swap-open'));
    await expect(page.getByTestId('thumbnails-section')).toBeVisible();
    const moderate = page.locator('[data-testid="variant-slot"][data-role="moderate"]');
    await untilTaken(
      async () => {
        if ((await page.getByTestId('swap-dialog').count()) === 0) {
          await press(device, moderate.getByTestId('variant-ship'));
        }
      },
      async () => expect(page.getByTestId('swap-dialog')).toBeVisible({ timeout: 2_000 }),
    );
    const dialog = page.getByTestId('swap-dialog');
    await dialog.getByTestId('swap-reason-input').fill('2.4% against a 5% median: the wild card does not read at tile size.');
    await shot(page, device, '18-swap-dialog');
    await press(device, dialog.getByTestId('swap-confirm'));
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await videoRow(id)).shipped_role).toBe('moderate');
    await expect(moderate.getByTestId('variant-live-badge')).toBeVisible();
    await shot(page, device, '19-swapped');

    await page.goto('/now');
    await onlyChannel(page, device, channel.name);
    // Answered by acting: no swap row any more.
    await expect(nowRow(page, id).filter({ has: page.locator('[data-input="swap"]') })).toHaveCount(0);
    await expect(nowRow(page, id)).not.toHaveAttribute('data-input', 'swap');
  });

  const end = await videoRow(id);
  expect(end.kind).toBe('published');
  expect(end.youtube_url).toContain('m9week');
  expect(Number(end.first24_ctr)).toBe(2.4);
  expect(end.first24_impressions).toBe(8200);
}

test.describe('the week, on a laptop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('capture to swap, with a mouse and the keyboard', async ({ page }) => {
    test.setTimeout(300_000);
    await walkTheWeek(page, 'laptop');
  });
});

test.describe('the week, on a phone', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  test('capture to swap, by touch', async ({ page }) => {
    test.setTimeout(300_000);
    // `pointer: coarse` is really true here, which no other spec can say.
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await walkTheWeek(page, 'phone');
  });
});
