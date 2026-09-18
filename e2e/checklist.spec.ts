import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import {
  CHANNEL_DEFAULTS,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
} from '../lib/defaults';
import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/**
 * M3 — the stage checklist.
 *
 * PLAN.md's second open question decides that checklists are **snapshot-copied**
 * from the channel's templates on first entry to a stage, and that everything
 * after that is a plain row edit. This file drives that decision through the
 * real application against the real PostgREST + RLS stack — no stubs, every
 * write through the server actions in `app/actions/checklist.ts` — and pairs
 * every browser assertion with a read of the rows it is supposed to have
 * written.
 *
 * The two assertions that are the point of the file:
 *
 * 1. **A custom item is the next action immediately.** Not "is in the list":
 *    the row lands at `min(position) - 1` and the strip names it. That is the
 *    whole feature (PLAN.md open question 3).
 * 2. **A failed tick puts the tick back.** The tick is optimistic, so the
 *    interesting case is the one where the write loses — and the test watches
 *    the row *while the write is in flight* to prove the optimistic half
 *    happened at all, then watches it go back. A rollback test that never saw
 *    the optimistic state would pass just as well against a checkbox that does
 *    nothing.
 */

const CHANNEL = { name: 'M3 Checklists', slug: 'm3-checklists' };

/** The seeded Packaging list — the one this file counts against. */
const PACKAGING = SEED_CHECKLISTS.packaging.map((row) => row.text);

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

let db: pg.Client;
let userId: string;
let channelId: string;

test.beforeAll(async () => {
  db = new pg.Client({
    host: PG.host,
    port: PG.port,
    user: PG.user,
    password: PG.password === '' ? undefined : PG.password,
    database: PG.database,
  });
  await db.connect();

  const found = await db.query<{ id: string }>(
    'select id from auth.users where lower(email) = lower($1)',
    [SEED_EMAIL],
  );
  if (found.rows.length === 0) {
    throw new Error(
      `the dev stack has no user ${SEED_EMAIL}; is it the stack this suite started?`,
    );
  }
  userId = found.rows[0].id;
});

test.afterAll(async () => {
  await db?.end();
});

test.beforeEach(async () => {
  // Rebuilt per test: these specs assert the exact contents and positions of a
  // list, so a row left behind by a failed run is not a cosmetic problem.
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug = $1)`,
    [CHANNEL.slug],
  );
  await db.query('delete from public.channels where slug = $1', [CHANNEL.slug]);
  channelId = await createChannel(CHANNEL.name, CHANNEL.slug);
});

/**
 * Run `fn` as the signed-in user, the way a PostgREST request runs it: RLS on,
 * the column grants applied, `auth.uid()` answering. A fixture built with
 * superuser INSERTs could produce rows the app itself can never reach.
 */
async function asUser<T>(fn: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({
        sub: userId,
        role: 'authenticated',
        aud: 'authenticated',
        email: SEED_EMAIL,
      }),
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
        JSON.stringify(
          SEED_BUCKETS.map((bucket) => ({ ...bucket, monthly_quota: null })),
        ),
      ],
    );
    return result.rows[0].id;
  });
}

/** `capture_video` — the only client path to a new video, always into Idea. */
async function capture(title: string): Promise<string> {
  return asUser(async () => {
    const result = await db.query<{ id: string }>(
      'select id from capture_video($1::uuid, $2::text)',
      [channelId, title],
    );
    return result.rows[0].id;
  });
}

async function stageIdOf(kind: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    'select id from public.stages where channel_id = $1 and kind = $2',
    [channelId, kind],
  );
  return result.rows[0].id;
}

/** `move_video` as the client calls it. */
async function move(videoId: string, kind: string): Promise<void> {
  const stageId = await stageIdOf(kind);
  await asUser(async () => {
    await db.query('select move_video($1::uuid, $2::uuid)', [videoId, stageId]);
  });
}

interface ItemRow {
  id: string;
  text: string;
  position: number;
  est_minutes: number | null;
  checked_at: string | null;
}

/** The stage's rows, in the order the app sorts them. */
async function readItems(videoId: string, kind: string): Promise<ItemRow[]> {
  const stageId = await stageIdOf(kind);
  const result = await db.query<ItemRow>(
    `select id, text, position, est_minutes, checked_at
       from public.checklist_items
      where video_id = $1 and stage_id = $2
      order by position asc, created_at asc, id asc`,
    [videoId, stageId],
  );
  return result.rows;
}

/**
 * Fill the three fields the TTH gate reads, as the client may.
 *
 * `move_video` refuses any stage after Packaging without them, and two of these
 * tests move a video on to Scripting. They are plain column writes — the gate
 * itself is the function's, and this is not a way around it.
 */
async function satisfyGate(videoId: string): Promise<void> {
  await asUser(async () => {
    await db.query(
      `update public.videos
          set title = 'A title that sells the result',
              thumbnail_concept = 'Face left, three props, big yellow 3',
              hooks = $2::jsonb
        where id = $1`,
      [
        videoId,
        JSON.stringify([
          { id: 'hook-1', text: 'Most people give up in week three.', chosen: true },
        ]),
      ],
    );
  });
}

/** A video already sitting in Packaging with its eight snapshot rows. */
async function inPackaging(title: string): Promise<string> {
  const videoId = await capture(title);
  await move(videoId, 'packaging');
  return videoId;
}

/* -------------------------------------------------------------------------- */
/* Browser helpers                                                             */
/* -------------------------------------------------------------------------- */

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // `/` is PLAN.md's front door and, as of M3, it lands on `/now` rather than
  // on a board. This spec works on a board, so it goes to one the way a user
  // would — the sidebar's Board link, which points at the first channel, the
  // very one `/` used to redirect to. The post-condition is unchanged: after
  // this helper the page is on a board.
  await page.waitForURL('**/now');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Board', exact: true })
    .click();
  await page.waitForURL(/\/c\/[^/]+\/board$/);
}

const ratio = (page: Page): Locator => page.getByTestId('checklist-ratio');
const status = (page: Page): Locator => page.getByTestId('checklist-save-status');
/** The text of every row, without the minutes and the evidence beside it. */
function rowTexts(page: Page): Promise<string[]> {
  return page.locator('[data-testid="checklist-item"] label span').allInnerTexts();
}

/** Open the panel. The strip starts folded, and the ratio is readable folded. */
async function openList(page: Page): Promise<void> {
  const expander = page.getByTestId('checklist-expander');
  await expect(expander).toBeVisible();
  if ((await expander.getAttribute('aria-expanded')) !== 'true') {
    await expander.click();
  }
  await expect(page.getByTestId('checklist-add-input')).toBeVisible();
}

/** Every assertion about the database is made after the page says it saved. */
async function expectSaved(page: Page): Promise<void> {
  await expect(status(page)).toHaveText(/^Saved$/);
}

/* -------------------------------------------------------------------------- */
/* 1. Snapshot on entry                                                        */
/* -------------------------------------------------------------------------- */

test('entering a stage fills its list from the template, and a stage with no template shows no ratio', async ({
  page,
}) => {
  const videoId = await capture('Snapshot on entry');

  // `capture_video` runs the same snapshot rule, and the Idea stage is seeded
  // with no template — so this is the zero case, and it must not read as "done".
  expect(await readItems(videoId, 'idea')).toHaveLength(0);

  await signIn(page);
  await page.goto(`/videos/${videoId}`);

  await expect(page.getByTestId('checklist-none')).toBeVisible();
  await expect(ratio(page)).toHaveCount(0);
  await expect(page.getByTestId('checklist-next')).toContainText(
    'has no checklist on this video',
  );

  // Moved through the page's own control, so the snapshot is proved on the path
  // a person actually takes rather than on a direct call to the function.
  await page.getByTestId('section-tab-schedule').click();
  await page
    .getByTestId('stage-select')
    .selectOption({ label: 'Packaging (TTH)' });
  await expect(page.getByTestId('stage-select-status')).toContainText(
    'Packaging (TTH)',
  );

  await expect(ratio(page)).toHaveText(`0/${PACKAGING.length}`);
  await openList(page);
  expect(await rowTexts(page)).toEqual(PACKAGING);

  // The strip names the first row of the template as the next action, with the
  // estimate that row was seeded with.
  await expect(page.getByTestId('checklist-next')).toContainText(PACKAGING[0]);
  await expect(page.getByTestId('checklist-next-minutes')).toHaveText(
    `${SEED_CHECKLISTS.packaging[0].est_minutes}m`,
  );

  const stored = await readItems(videoId, 'packaging');
  expect(stored.map((row) => row.text)).toEqual(PACKAGING);
  expect(stored.map((row) => row.position)).toEqual(
    PACKAGING.map((_, index) => index + 1),
  );
  expect(stored.every((row) => row.checked_at === null)).toBe(true);
});

/* -------------------------------------------------------------------------- */
/* 2. A tick is a row                                                          */
/* -------------------------------------------------------------------------- */

test('a tick writes checked_at and survives a reload', async ({ page }) => {
  const videoId = await inPackaging('Tick and reload');

  await signIn(page);
  await page.goto(`/videos/${videoId}`);
  await openList(page);

  // By its accessible name, which is the item's own text and nothing else.
  await page.getByRole('checkbox', { name: PACKAGING[1] }).check();
  await expectSaved(page);
  await expect(ratio(page)).toHaveText(`1/${PACKAGING.length}`);

  const stored = await readItems(videoId, 'packaging');
  const ticked = stored.filter((row) => row.checked_at !== null);
  expect(ticked.map((row) => row.text)).toEqual([PACKAGING[1]]);

  await page.reload();
  await expect(ratio(page)).toHaveText(`1/${PACKAGING.length}`);
  await openList(page);
  await expect(page.getByRole('checkbox', { name: PACKAGING[1] })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: PACKAGING[0] })).not.toBeChecked();

  // And back off again: the tick is a value, not a one-way door.
  await page.getByRole('checkbox', { name: PACKAGING[1] }).uncheck();
  await expectSaved(page);
  await expect(ratio(page)).toHaveText(`0/${PACKAGING.length}`);
  expect(
    (await readItems(videoId, 'packaging')).every((row) => row.checked_at === null),
  ).toBe(true);
});

/* -------------------------------------------------------------------------- */
/* 3. A custom item is the next action                                         */
/* -------------------------------------------------------------------------- */

test('a custom item lands at the top and becomes the next action', async ({
  page,
}) => {
  const videoId = await inPackaging('Custom item');
  const custom = 'Ask Jo which of the two thumbnails reads at tile size';

  await signIn(page);
  await page.goto(`/videos/${videoId}`);
  await openList(page);

  await page.getByTestId('checklist-add-input').fill(custom);
  await page.getByTestId('checklist-add-submit').click();
  await expectSaved(page);

  // Top of the list on screen…
  expect(await rowTexts(page)).toEqual([custom, ...PACKAGING]);
  // …and the thing the strip says to do next, which is the point of it.
  await expect(page.getByTestId('checklist-next')).toContainText(custom);
  await expect(ratio(page)).toHaveText(`0/${PACKAGING.length + 1}`);

  const stored = await readItems(videoId, 'packaging');
  expect(stored[0].text).toBe(custom);
  // `min(position) - 1`: the seeded rows start at 1, so the custom row is 0.
  expect(stored[0].position).toBe(0);
  // No estimate was typed, and NULL is what the app reads as ten minutes.
  expect(stored[0].est_minutes).toBeNull();
  await expect(page.getByTestId('checklist-next-minutes')).toHaveText('10m');

  // A second one goes above the first, not beside it.
  const second = 'Re-shoot the desk clip with the lamp on';
  await page.getByTestId('checklist-add-input').fill(second);
  await page.getByTestId('checklist-add-input').press('Enter');
  await expectSaved(page);
  expect(await rowTexts(page)).toEqual([second, custom, ...PACKAGING]);
  expect((await readItems(videoId, 'packaging'))[0].position).toBe(-1);

  // And it can be taken off again.
  await page
    .getByRole('button', { name: `Delete “${second}”` })
    .click();
  await expectSaved(page);
  expect(await rowTexts(page)).toEqual([custom, ...PACKAGING]);
  expect(
    (await readItems(videoId, 'packaging')).some((row) => row.text === second),
  ).toBe(false);
});

/* -------------------------------------------------------------------------- */
/* 4. Reset                                                                    */
/* -------------------------------------------------------------------------- */

test('reset puts the template back and drops the ticks and the custom items', async ({
  page,
}) => {
  const videoId = await inPackaging('Reset me');

  await signIn(page);
  await page.goto(`/videos/${videoId}`);
  await openList(page);

  await page.getByTestId('checklist-add-input').fill('Something only this video needs');
  await page.getByTestId('checklist-add-submit').click();
  await expectSaved(page);
  await page.getByRole('checkbox', { name: PACKAGING[2] }).check();
  await expectSaved(page);
  await expect(ratio(page)).toHaveText(`1/${PACKAGING.length + 1}`);

  // It asks first: this throws away work, so it is two deliberate clicks.
  await page.getByTestId('checklist-reset').click();
  await expect(page.getByTestId('checklist-reset-warning')).toBeVisible();
  await page.getByTestId('checklist-reset-cancel').click();
  await expect(ratio(page)).toHaveText(`1/${PACKAGING.length + 1}`);

  await page.getByTestId('checklist-reset').click();
  await page.getByTestId('checklist-reset-confirm').click();
  await expectSaved(page);

  await expect(ratio(page)).toHaveText(`0/${PACKAGING.length}`);
  expect(await rowTexts(page)).toEqual(PACKAGING);

  const stored = await readItems(videoId, 'packaging');
  expect(stored.map((row) => row.text)).toEqual(PACKAGING);
  expect(stored.map((row) => row.position)).toEqual(
    PACKAGING.map((_, index) => index + 1),
  );
  expect(stored.every((row) => row.checked_at === null)).toBe(true);
  // The estimates come back with the rows — a reset list is the template, not
  // a list of nameless ten-minute jobs.
  expect(stored.map((row) => row.est_minutes)).toEqual(
    SEED_CHECKLISTS.packaging.map((row) => row.est_minutes),
  );

  // The reset is scoped to the stage the video is in. Nothing else was touched:
  // the Idea stage's (empty) list is still the Idea stage's list.
  expect(await readItems(videoId, 'idea')).toHaveLength(0);
});

/**
 * A custom item added while a reset is in flight is not lost.
 *
 * A reset replaces the whole list with the server's template rows, and it used
 * to replace it with those *only* — so a row still owed by the queue was thrown
 * away. The add then landed in the database, at position 0, as the next action
 * — the entire point of the feature — and its own reconcile found no temp row
 * to replace, so the real row was never put back on screen. The page showed
 * neither it nor an error, and the strip is keyed by `stage_id`, which does not
 * change on a reset, so the revalidation did not re-seed it either. The add box
 * is documented as deliberately never disabled during a write, so this path is
 * offered to the user on purpose.
 */
test('a custom item added while a reset is in flight survives the reset', async ({
  page,
}) => {
  const videoId = await inPackaging('Reset race');
  const custom = 'CALL THE SPONSOR BACK';

  await signIn(page);
  await page.goto(`/videos/${videoId}`);
  await openList(page);

  await page.route(
    (url) => url.pathname === `/videos/${videoId}`,
    async (route) => {
      if (route.request().method() === 'POST') {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      await route.continue();
    },
  );

  await page.getByTestId('checklist-reset').click();
  await page.getByTestId('checklist-reset-confirm').click();
  await expect(status(page)).toHaveText(/Saving…/);

  // While the reset is on the wire.
  await page.getByTestId('checklist-add-input').fill(custom);
  await page.getByTestId('checklist-add-submit').click();

  await expectSaved(page);

  // On screen, at the top, and named as the next thing to do.
  expect(await rowTexts(page)).toEqual([custom, ...PACKAGING]);
  await expect(page.getByTestId('checklist-next')).toContainText(custom);
  await expect(ratio(page)).toHaveText(`0/${PACKAGING.length + 1}`);

  // And the screen and the database agree, which is what went wrong before.
  const stored = await readItems(videoId, 'packaging');
  expect(stored.map((row) => row.text)).toEqual([custom, ...PACKAGING]);
  expect(stored[0].position).toBe(0);
});

/* -------------------------------------------------------------------------- */
/* 5. A failed tick rolls back                                                 */
/* -------------------------------------------------------------------------- */

test('a tick that the database refuses goes back, and says so', async ({
  page,
}) => {
  const videoId = await inPackaging('Rollback');
  const stored = await readItems(videoId, 'packaging');
  const doomed = stored[1];

  await signIn(page);
  await page.goto(`/videos/${videoId}`);
  await openList(page);

  // The row is deleted *underneath* the open page — another tab, or the reset
  // button on another device. The page has no way to know.
  await db.query('delete from public.checklist_items where id = $1', [doomed.id]);

  // Held open so the optimistic half is observable. Without this the assertion
  // below could pass against a checkbox that never ticked at all.
  await page.route(
    (url) => url.pathname === `/videos/${videoId}`,
    async (route) => {
      if (route.request().method() === 'POST') {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      await route.continue();
    },
  );

  const checkbox = page.getByRole('checkbox', { name: doomed.text });
  await checkbox.check();

  /*
    Optimistic: it is ticked, and the ratio counts it, while the write is out.

    The "Saving…" assertion comes first because it is the one with a deadline —
    the window it names closes when the held-open POST answers, and the other
    two are true for as long as it is open *and* afterwards if the rollback
    never happens. Asserted last, a slow machine could spend the whole window on
    the other two and then fail on a line that was true when it started.
  */
  await expect(status(page)).toHaveText(/Saving…/);
  await expect(checkbox).toBeChecked();
  await expect(ratio(page)).toHaveText(`1/${PACKAGING.length}`);

  // And then the truth arrives: the row goes back, and the line says why.
  await expect(status(page)).toContainText('not there any more');
  await expect(checkbox).not.toBeChecked();
  await expect(ratio(page)).toHaveText(`0/${PACKAGING.length}`);
  await expect(status(page)).toHaveAttribute('data-state', 'error');

  // Nothing else was ticked on the way past.
  expect(
    (await readItems(videoId, 'packaging')).every((row) => row.checked_at === null),
  ).toBe(true);
});

/**
 * A failure is never followed by "Saved".
 *
 * The queue used to *drain* on a failure: the error state and the follow-up
 * `{kind:"saving"}` landed in the same React batch, so the failure was never
 * rendered, and the batch behind it then succeeded and wrote "Saved". The
 * checklist had already rolled the failed tick back and then discarded its
 * record of it, so there was no message, no Retry and no trace — reachable with
 * two ordinary clicks, on the one interaction this product has that happens ten
 * times in a row.
 */
test('a failed tick with another queued behind it ends on the failure, not on "Saved"', async ({
  page,
}) => {
  const videoId = await inPackaging('Queued behind a failure');
  const stored = await readItems(videoId, 'packaging');
  const doomed = stored[1];
  const innocent = stored[2];

  await signIn(page);
  await page.goto(`/videos/${videoId}`);
  await openList(page);

  await db.query('delete from public.checklist_items where id = $1', [doomed.id]);

  // Held open long enough that the second click lands while the first is still
  // on the wire, which is the state that produces the queue.
  await page.route(
    (url) => url.pathname === `/videos/${videoId}`,
    async (route) => {
      if (route.request().method() === 'POST') {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      await route.continue();
    },
  );

  const first = page.getByRole('checkbox', { name: doomed.text });
  const second = page.getByRole('checkbox', { name: innocent.text });

  await first.check();
  await expect(status(page)).toHaveText(/Saving…/);
  await second.check();

  // The failure is what is on screen when the dust settles, and it stays.
  await expect(status(page)).toHaveAttribute('data-state', 'error');
  await expect(status(page)).toContainText('not there any more');
  await page.waitForTimeout(1_500);
  await expect(status(page)).toHaveAttribute('data-state', 'error');
  await expect(status(page)).not.toHaveText(/^Saved$/);

  // Both rows are back where they were: the second was parked, not sent.
  await expect(first).not.toBeChecked();
  await expect(second).not.toBeChecked();
  await expect(ratio(page)).toHaveText(`0/${PACKAGING.length}`);
  expect(
    (await readItems(videoId, 'packaging')).every((row) => row.checked_at === null),
  ).toBe(true);

  // And the work that was rolled back is offered back, rather than discarded.
  await expect(page.getByTestId('checklist-save-status-retry')).toBeVisible();
});

/**
 * An aborted request is a failure like any other.
 *
 * `runOp` turns a *refusal* into a value, but a dropped connection rejects, and
 * the exception used to sail past every rollback in `use-checklist.ts` and out
 * into the queue's own catch. The result was the one outcome that module says
 * it must not have: the checkbox stayed ticked and the ratio counted it while
 * the database held nothing, the message shown was the text editor's ("Nothing
 * you typed has been lost"), which is false for a tick that has just been
 * discarded, and Retry returned early on an empty list and did nothing at all.
 */
test('an offline tick is rolled back, says so, and Retry actually re-sends it', async ({
  page,
}) => {
  const videoId = await inPackaging('Offline tick');
  const stored = await readItems(videoId, 'packaging');
  const target = stored[0];

  await signIn(page);
  await page.goto(`/videos/${videoId}`);
  await openList(page);

  let offline = true;
  await page.route(
    (url) => url.pathname === `/videos/${videoId}`,
    async (route) => {
      if (offline && route.request().method() === 'POST') {
        await route.abort('failed');
        return;
      }
      await route.continue();
    },
  );

  const checkbox = page.getByRole('checkbox', { name: target.text });
  // click(), not check(): check() asserts the box ends up ticked, and the
  // rollback under test here can land before that assertion runs. The tick
  // reverting is the behaviour, so asserting it stuck would be asserting the
  // bug. The real expectations are the four lines below.
  await checkbox.click();

  await expect(status(page)).toHaveAttribute('data-state', 'error');
  // The checklist's own sentence, not the field editor's.
  await expect(status(page)).toContainText('that change was undone');
  await expect(status(page)).not.toContainText('Nothing you typed');
  await expect(checkbox).not.toBeChecked();
  await expect(ratio(page)).toHaveText(`0/${PACKAGING.length}`);
  expect(
    (await readItems(videoId, 'packaging')).every((row) => row.checked_at === null),
  ).toBe(true);

  /* -- back online, and Retry is a real offer ----------------------------- */

  offline = false;
  await page.getByTestId('checklist-save-status-retry').click();

  await expectSaved(page);
  await expect(checkbox).toBeChecked();
  await expect(ratio(page)).toHaveText(`1/${PACKAGING.length}`);

  const after = await readItems(videoId, 'packaging');
  expect(after.filter((row) => row.checked_at !== null).map((row) => row.id)).toEqual([
    target.id,
  ]);
});

/* -------------------------------------------------------------------------- */
/* 6. The card says the same thing                                             */
/* -------------------------------------------------------------------------- */

test('the board card shows the current stage ratio, and nothing at all without a list', async ({
  page,
}) => {
  const idea = await capture('Still an idea');
  const working = await inPackaging('Being packaged');

  await signIn(page);
  await page.goto(`/videos/${working}`);
  await openList(page);
  await page.getByRole('checkbox', { name: PACKAGING[0] }).check();
  await expectSaved(page);
  await page.getByRole('checkbox', { name: PACKAGING[1] }).check();
  await expectSaved(page);
  await expect(ratio(page)).toHaveText(`2/${PACKAGING.length}`);

  await page.goto(`/c/${CHANNEL.slug}/board`);

  const workingCard = page.locator(`[data-video-id="${working}"]`);
  const badge = workingCard.getByTestId('card-checklist');
  // `toContainText`, not `toHaveText`: the badge carries an "Checklist: " prefix
  // for a screen reader that a sighted reader never sees.
  await expect(badge).toContainText(`2/${PACKAGING.length}`);
  await expect(badge).toHaveAttribute('data-done', '2');
  await expect(badge).toHaveAttribute('data-total', String(PACKAGING.length));

  // The Idea column's card has no list to count, and M1 removed exactly this
  // "0/0" from this slot because it reads as "nothing to do".
  const ideaCard = page.locator(`[data-video-id="${idea}"]`);
  await expect(ideaCard).toBeVisible();
  await expect(ideaCard.getByTestId('card-checklist')).toHaveCount(0);

  // The ratio follows the video, not the video's history: moving it on gives it
  // the next stage's list, and the card counts that one.
  await satisfyGate(working);
  await move(working, 'scripting');
  await page.reload();
  await expect(workingCard.getByTestId('card-checklist')).toContainText(
    `0/${SEED_CHECKLISTS.scripting.length}`,
  );
});

/* -------------------------------------------------------------------------- */
/* 7. Evidence, and the tick it does not make                                  */
/* -------------------------------------------------------------------------- */

test('a row the app can measure carries the count, and still waits to be ticked', async ({
  page,
}) => {
  const videoId = await inPackaging('Evidence');

  // A title past the 55-character guidance, three candidates, two hooks: three
  // rows of this list ask about exactly those numbers.
  const longTitle =
    'The very long working title that runs past the fifty-five character guidance';
  await asUser(async () => {
    await db.query(
      `update public.videos
          set title = $2, title_candidates = $3::jsonb, hooks = $4::jsonb
        where id = $1`,
      [
        videoId,
        longTitle,
        JSON.stringify([
          { id: 'c1', text: 'One', source: 'manual' },
          { id: 'c2', text: 'Two', source: 'manual' },
          { id: 'c3', text: 'Three', source: 'manual' },
        ]),
        JSON.stringify([
          { id: 'h1', text: 'First hook' },
          { id: 'h2', text: 'Second hook' },
        ]),
      ],
    );
  });

  await signIn(page);
  await page.goto(`/videos/${videoId}`);
  await openList(page);

  const row = (text: string): Locator =>
    page.locator('[data-testid="checklist-item"]', { hasText: text });

  await expect(
    row(PACKAGING[0]).getByTestId('checklist-evidence'),
  ).toHaveText('3 written');

  const titleEvidence = row(PACKAGING[3]).getByTestId('checklist-evidence');
  await expect(titleEvidence).toHaveText(`${longTitle.length}/55`);
  // The one rule actually being broken is the only thing wearing a colour.
  await expect(titleEvidence).toHaveAttribute('data-over-limit', 'true');
  await expect(
    row(PACKAGING[0]).getByTestId('checklist-evidence'),
  ).toHaveAttribute('data-over-limit', 'false');

  await expect(
    row(PACKAGING[7]).getByTestId('checklist-evidence'),
  ).toHaveText('2/3 written');

  // Three rows can be measured; the other five say nothing rather than guess.
  await expect(page.getByTestId('checklist-evidence')).toHaveCount(3);

  // And none of it ticks anything: a count is evidence, the tick is judgement.
  await expect(ratio(page)).toHaveText(`0/${PACKAGING.length}`);
  expect(
    (await readItems(videoId, 'packaging')).every((r) => r.checked_at === null),
  ).toBe(true);
});

/* -------------------------------------------------------------------------- */
/* 8. The stage is never taken from the caller                                 */
/* -------------------------------------------------------------------------- */

test('an add lands in the stage the video is actually in, and the page catches up', async ({
  page,
}) => {
  const videoId = await inPackaging('Moved underneath');
  const scripting = SEED_CHECKLISTS.scripting.map((row) => row.text);
  const custom = 'Something for whichever stage this really is';

  await signIn(page);
  await page.goto(`/videos/${videoId}`);
  await openList(page);
  await expect(ratio(page)).toHaveText(`0/${PACKAGING.length}`);

  // The video moves somewhere else — another tab, the board, a phone — while
  // this page sits open holding the Packaging list.
  await satisfyGate(videoId);
  await move(videoId, 'scripting');

  await page.getByTestId('checklist-add-input').fill(custom);
  await page.getByTestId('checklist-add-submit').click();

  /*
    The action reads `videos.stage_id` itself rather than trusting the page, so
    the row is filed in Scripting — and its revalidation re-renders this route,
    whose strip is keyed by the stage. The page therefore lands on the list the
    video really has, with the new item at the top of it. What must not happen,
    and does not, is the row being filed against a stage the video has left,
    where no read would ever return it again.
  */
  await expect(ratio(page)).toHaveText(`0/${scripting.length + 1}`);
  await openList(page);
  expect(await rowTexts(page)).toEqual([custom, ...scripting]);

  const stored = await readItems(videoId, 'scripting');
  expect(stored[0].text).toBe(custom);
  expect(stored[0].position).toBe(0);
  expect(
    (await readItems(videoId, 'packaging')).some((row) => row.text === custom),
  ).toBe(false);
});
