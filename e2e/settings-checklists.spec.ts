import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import {
  CHANNEL_DEFAULTS,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
} from '../lib/defaults';
import { QUICK_MINUTES } from '../lib/next-action';
import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/**
 * M7 — the checklist template editor, `/settings/checklists/[slug]`.
 *
 * PLAN.md's second open question decides that templates are **snapshot-copied**
 * onto a video on first entry to a stage, and that a template edit therefore
 * applies to videos entering afterwards and never to one already there. This
 * file is that decision, driven through the real editor against the real
 * PostgREST + RLS stack, with every browser claim paired with a read of the
 * rows it is supposed to have written — or, for the one claim that matters
 * most, the rows it is supposed to have left alone.
 *
 * The four things it proves, because a reviewer will come looking for each:
 *
 * 1. **Both halves of the boundary.** A video already in Packaging, with a row
 *    ticked, is byte-for-byte unchanged by a rename, a re-estimate, a removal
 *    and an addition — and the next video to enter Packaging gets exactly the
 *    edited list. One without the other is not the feature.
 * 2. **Reorder persists**, dense 1..n, and survives a reload.
 * 3. **An estimate is a consequence.** Changing one moves the stage's total on
 *    this page and changes what `/now`'s "10 minutes or less" lists — for the
 *    next video, and not for the one that already has its copy.
 * 4. **Removal is future videos only**, and the page says so where the button
 *    was pressed.
 */

const CHANNEL = { name: 'M7 Checklists', slug: 'm7-checklists' };

/** The seeded Packaging list — the one this file edits. */
const PACKAGING = SEED_CHECKLISTS.packaging.map((row) => row.text);
const PACKAGING_MINUTES = SEED_CHECKLISTS.packaging.reduce(
  (sum, row) => sum + row.est_minutes,
  0,
);

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
  // template, so a row left behind by a failed run is not cosmetic.
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
 * the column grants applied, `auth.uid()` answering.
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

/** `move_video` as the client calls it — the path that does the copying. */
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

/** A video's rows for one stage, in the order the app sorts them. */
async function readItems(videoId: string, kind: string): Promise<ItemRow[]> {
  const stageId = await stageIdOf(kind);
  const result = await db.query<ItemRow>(
    `select id, text, position, est_minutes, checked_at::text
       from public.checklist_items
      where video_id = $1 and stage_id = $2
      order by position asc, created_at asc, id asc`,
    [videoId, stageId],
  );
  return result.rows;
}

interface TemplateRow {
  id: string;
  text: string;
  position: number;
  est_minutes: number;
}

/** The stage's template, in position order. */
async function readTemplate(kind: string): Promise<TemplateRow[]> {
  const stageId = await stageIdOf(kind);
  const result = await db.query<TemplateRow>(
    `select id, text, position, est_minutes
       from public.checklist_templates
      where stage_id = $1
      order by position asc, id asc`,
    [stageId],
  );
  return result.rows;
}

/** Tick one of a video's rows, as the client would. */
async function tick(videoId: string, itemId: string): Promise<void> {
  await asUser(async () => {
    await db.query(
      'update public.checklist_items set checked_at = now() where id = $1 and video_id = $2',
      [itemId, videoId],
    );
  });
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

async function openSettings(page: Page): Promise<void> {
  await page.goto(`/settings/checklists/${CHANNEL.slug}`);
  await expect(page.getByTestId('settings-checklists')).toHaveAttribute(
    'data-channel',
    CHANNEL.slug,
  );
}

/** The editor for one stage, found by the kind code branches on, never the name. */
const stageEditor = (page: Page, kind: string): Locator =>
  page.locator(`[data-testid="template-stage"][data-stage-kind="${kind}"]`);

const rows = (editor: Locator): Locator => editor.getByTestId('template-row');

/** Every row's text, in display order. */
async function rowTexts(editor: Locator): Promise<string[]> {
  const inputs = editor.getByTestId('template-text');
  const count = await inputs.count();
  const texts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    texts.push(await inputs.nth(index).inputValue());
  }
  return texts;
}

/** Fill a row's input and commit it the way a person does: Enter. */
async function commit(input: Locator, value: string): Promise<void> {
  await input.fill(value);
  await input.press('Enter');
}

/* -------------------------------------------------------------------------- */
/* 1. The snapshot boundary — both halves                                      */
/* -------------------------------------------------------------------------- */

test('editing a template leaves a video already in the stage untouched, and the next video to enter gets the new list', async ({
  page,
}) => {
  // A video that is already in Packaging, with its eight rows and one ticked:
  // exactly the state a template edit must never reach into.
  const before = await capture('Already in Packaging');
  await move(before, 'packaging');
  const itsRows = await readItems(before, 'packaging');
  expect(itsRows.map((row) => row.text)).toEqual(PACKAGING);
  await tick(before, itsRows[1].id);
  const snapshot = await readItems(before, 'packaging');
  expect(snapshot[1].checked_at).not.toBeNull();

  await signIn(page);
  await openSettings(page);
  const editor = stageEditor(page, 'packaging');
  await expect(rows(editor)).toHaveCount(PACKAGING.length);
  expect(await rowTexts(editor)).toEqual(PACKAGING);

  // The page says who is in the stage and what that means, before any edit.
  await expect(editor.getByTestId('template-occupied')).toHaveAttribute('data-count', '1');
  await expect(editor.getByTestId('template-occupied')).toContainText(
    'One video is in Packaging (TTH) now and keeps the list it was given',
  );

  // Rename the first row.
  const renamed = 'Generated 10–20 title candidates, not 3 — and wrote them all down';
  await commit(editor.getByTestId('template-text').nth(0), renamed);
  await expect.poll(async () => (await readTemplate('packaging'))[0].text).toBe(renamed);
  await expect(editor.getByTestId('template-save-status')).toHaveText(/^Saved$/);

  // Re-estimate it: fifteen minutes becomes five.
  await commit(editor.getByTestId('template-minutes').nth(0), '5');
  await expect.poll(async () => (await readTemplate('packaging'))[0].est_minutes).toBe(5);

  // Remove the fourth row, and read what the page says about it.
  await editor.getByTestId('template-remove').nth(3).click();
  await expect.poll(async () => (await readTemplate('packaging')).length).toBe(
    PACKAGING.length - 1,
  );
  await expect(editor.getByTestId('template-removed-note')).toContainText(
    `Removed “${PACKAGING[3]}” from the template. The video already in Packaging (TTH) keeps it; the next one to enter for the first time will not get it.`,
  );
  // The row went with the button that removed it; focus moved to the row
  // that took its place rather than falling on <body>.
  await expect(editor.getByTestId('template-text').nth(3)).toBeFocused();
  await expect(editor.getByTestId('template-text').nth(3)).toHaveValue(PACKAGING[4]);

  // Add one at the end, with its own estimate.
  const added = 'Read the title out loud to somebody who has not seen the video';
  await editor.getByTestId('template-add-text').fill(added);
  await editor.getByTestId('template-add-minutes').fill('20');
  await editor.getByTestId('template-add-submit').click();
  await expect.poll(async () => (await readTemplate('packaging')).length).toBe(
    PACKAGING.length,
  );

  const template = await readTemplate('packaging');
  const expectedTexts = [renamed, PACKAGING[1], PACKAGING[2], ...PACKAGING.slice(4), added];
  expect(template.map((row) => row.text)).toEqual(expectedTexts);
  // After the last row, not in the gap the removal left: positions are order,
  // not a count, and the deferred unique is never asked to hold a duplicate.
  expect(template.map((row) => row.position)).toEqual([1, 2, 3, 5, 6, 7, 8, 9]);
  expect(template[0].est_minutes).toBe(5);
  expect(template[template.length - 1].est_minutes).toBe(20);

  // On screen too, and still after a reload — the rows are the table's.
  expect(await rowTexts(editor)).toEqual(expectedTexts);
  await page.reload();
  await expect(rows(stageEditor(page, 'packaging'))).toHaveCount(PACKAGING.length);
  expect(await rowTexts(stageEditor(page, 'packaging'))).toEqual(expectedTexts);

  // ---- Half one: the video that was already there is exactly as it was. ----
  expect(await readItems(before, 'packaging')).toEqual(snapshot);

  // ---- Half two: the next video to enter gets the edited list, verbatim. ----
  const after = await capture('Entered after the edit');
  await move(after, 'packaging');
  const copied = await readItems(after, 'packaging');
  expect(copied.map((row) => row.text)).toEqual(expectedTexts);
  expect(copied.map((row) => row.position)).toEqual(template.map((row) => row.position));
  expect(copied.map((row) => row.est_minutes)).toEqual(
    template.map((row) => row.est_minutes),
  );
  expect(copied.every((row) => row.checked_at === null)).toBe(true);

  // And the first video's rows are still not the second's.
  expect(await readItems(before, 'packaging')).toEqual(snapshot);
});

/* -------------------------------------------------------------------------- */
/* 2. Reorder                                                                  */
/* -------------------------------------------------------------------------- */

test('reorder persists, renumbers 1..n as one statement, and survives a reload', async ({
  page,
}) => {
  await signIn(page);
  await openSettings(page);
  const editor = stageEditor(page, 'packaging');
  await expect(rows(editor)).toHaveCount(PACKAGING.length);

  // The ends have nowhere to go, and say so by being disabled rather than gone.
  await expect(editor.getByTestId('template-move-up').nth(0)).toBeDisabled();
  await expect(editor.getByTestId('template-move-down').nth(PACKAGING.length - 1)).toBeDisabled();

  // First row down one.
  await editor.getByTestId('template-move-down').nth(0).click();
  const afterDown = [PACKAGING[1], PACKAGING[0], ...PACKAGING.slice(2)];
  await expect.poll(async () => (await readTemplate('packaging')).map((r) => r.text)).toEqual(
    afterDown,
  );
  expect(await rowTexts(editor)).toEqual(afterDown);
  // Focus followed the row to the same arrow, which is still offered — after
  // the write settled, not on the text box the in-flight arrows fall through
  // to (M7's review).
  await expect(editor.getByTestId('template-save-status')).toHaveAttribute('data-state', 'saved');
  await expect(editor.getByTestId('template-move-down').nth(1)).toBeFocused();

  // The row that is now third, up one — so the two moves compose.
  await editor.getByTestId('template-move-up').nth(2).click();
  const afterUp = [PACKAGING[1], PACKAGING[2], PACKAGING[0], ...PACKAGING.slice(3)];
  await expect.poll(async () => (await readTemplate('packaging')).map((r) => r.text)).toEqual(
    afterUp,
  );
  expect(await rowTexts(editor)).toEqual(afterUp);

  // Dense, 1..n, in the new order: the whole assignment went in one statement.
  const stored = await readTemplate('packaging');
  expect(stored.map((row) => row.position)).toEqual(
    PACKAGING.map((_, index) => index + 1),
  );

  await page.reload();
  await expect(rows(stageEditor(page, 'packaging'))).toHaveCount(PACKAGING.length);
  expect(await rowTexts(stageEditor(page, 'packaging'))).toEqual(afterUp);

  /*
    The constraint the single statement exists for, shown from the other side:
    the same swap as a *sequence* of client writes is refused by the deferred
    unique at commit. This is the database's rule, not the page's — which is
    why a page that got the statement wrong could not have passed the reads
    above either.
  */
  await expect(
    asUser(async () => {
      await db.query(
        `update public.checklist_templates set position = 2
          where stage_id = $1 and position = 1`,
        [await stageIdOf('packaging')],
      );
    }),
  ).rejects.toMatchObject({ code: '23505' });
  expect((await readTemplate('packaging')).map((row) => row.text)).toEqual(afterUp);
});

/* -------------------------------------------------------------------------- */
/* 3. The estimate is a consequence                                            */
/* -------------------------------------------------------------------------- */

test('changing an estimate moves the stage total and what /now calls a ten-minute job', async ({
  page,
}) => {
  // A video that has its copy of the template already — first row 15 minutes.
  const earlier = await capture('Entered before the estimate changed');
  await move(earlier, 'packaging');
  expect((await readItems(earlier, 'packaging'))[0].est_minutes).toBe(
    SEED_CHECKLISTS.packaging[0].est_minutes,
  );
  expect(SEED_CHECKLISTS.packaging[0].est_minutes).toBeGreaterThan(QUICK_MINUTES);

  await signIn(page);
  await openSettings(page);
  const editor = stageEditor(page, 'packaging');

  const total = editor.getByTestId('template-total');
  await expect(total).toHaveAttribute('data-minutes', String(PACKAGING_MINUTES));
  const quickBefore = SEED_CHECKLISTS.packaging.filter(
    (row) => row.est_minutes <= QUICK_MINUTES,
  ).length;
  await expect(total).toHaveAttribute('data-quick', String(quickBefore));
  await expect(total).toContainText(`${quickBefore} of ${PACKAGING.length} fit ten minutes`);

  // A refused estimate is put back and explained, and the row is not written.
  await commit(editor.getByTestId('template-minutes').nth(0), '0');
  await expect(editor.getByTestId('template-minutes-error')).toBeVisible();
  await expect(editor.getByTestId('template-minutes').nth(0)).toHaveValue(
    String(SEED_CHECKLISTS.packaging[0].est_minutes),
  );
  expect((await readTemplate('packaging'))[0].est_minutes).toBe(
    SEED_CHECKLISTS.packaging[0].est_minutes,
  );

  // Fifteen becomes five: the total drops by ten and one more row fits.
  await commit(editor.getByTestId('template-minutes').nth(0), '5');
  await expect.poll(async () => (await readTemplate('packaging'))[0].est_minutes).toBe(5);
  const newTotal = PACKAGING_MINUTES - SEED_CHECKLISTS.packaging[0].est_minutes + 5;
  await expect(total).toHaveAttribute('data-minutes', String(newTotal));
  await expect(total).toHaveAttribute('data-quick', String(quickBefore + 1));
  await expect(rows(editor).nth(0)).toHaveAttribute('data-quick', 'true');

  // The video that already had its copy still says fifteen.
  expect((await readItems(earlier, 'packaging'))[0].est_minutes).toBe(
    SEED_CHECKLISTS.packaging[0].est_minutes,
  );

  // The next one to enter gets five.
  const later = await capture('Entered after the estimate changed');
  await move(later, 'packaging');
  expect((await readItems(later, 'packaging'))[0].est_minutes).toBe(5);

  // And `/now` agrees: both videos have the same next action by name, only
  // one of them is a ten-minute job.
  await page.goto('/now');
  await expect(page.getByTestId('now')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('channel-chip').filter({ hasText: CHANNEL.name }).click();

  const rowFor = (title: string) =>
    page.getByTestId('now-row').filter({ hasText: title });
  await expect(rowFor('Entered before the estimate changed')).toHaveCount(1);
  await expect(rowFor('Entered after the estimate changed')).toHaveCount(1);
  await expect(rowFor('Entered before the estimate changed')).toContainText('15 min');
  await expect(rowFor('Entered after the estimate changed')).toContainText('5 min');

  await page.getByTestId('quick-filter').click();
  await expect(rowFor('Entered before the estimate changed')).toHaveCount(0);
  await expect(rowFor('Entered after the estimate changed')).toHaveCount(1);
});

/* -------------------------------------------------------------------------- */
/* 4. A stage with no template, and a stage that is switched off              */
/* -------------------------------------------------------------------------- */

test('a stage with no template can be given one, and capture copies it like a move does', async ({
  page,
}) => {
  await signIn(page);
  await openSettings(page);

  const idea = stageEditor(page, 'idea');
  await expect(idea.getByTestId('template-empty')).toBeVisible();
  await expect(idea.getByTestId('template-total')).toHaveCount(0);

  await idea.getByTestId('template-add-text').fill('Write the one-line hook');
  await idea.getByTestId('template-add-minutes').fill('5');
  await idea.getByTestId('template-add-submit').click();
  await expect.poll(async () => (await readTemplate('idea')).length).toBe(1);
  await expect(idea.getByTestId('template-total')).toHaveAttribute('data-minutes', '5');

  // `capture_video` runs the same snapshot rule as `move_video`, so a captured
  // idea now arrives with the row.
  const videoId = await capture('Captured after the Idea template was written');
  const copied = await readItems(videoId, 'idea');
  expect(copied.map((row) => [row.text, row.position, row.est_minutes])).toEqual([
    ['Write the one-line hook', 1, 5],
  ]);

  // Filming needs a block, and the page says so instead of printing a count.
  const filming = stageEditor(page, 'filming');
  await expect(filming.getByTestId('template-total')).toContainText('none fit ten minutes');
  await expect(filming.getByTestId('template-occupied')).toContainText('needs a block');

  // A channel this user does not have is a 404, like the board's.
  const response = await page.goto('/settings/checklists/not-a-channel');
  expect(response?.status()).toBe(404);

  // And the bare route lands on a channel rather than on nothing.
  await page.goto('/settings/checklists');
  await page.waitForURL(/\/settings\/checklists\/[^/?]+$/);
  await expect(page.getByTestId('settings-checklists')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* 5. The add form's refusal is the form's, and its controls are named        */
/* -------------------------------------------------------------------------- */

test('the add form refuses zero minutes in its own words, and every control names its stage', async ({
  page,
}) => {
  await signIn(page);
  await openSettings(page);
  const editor = stageEditor(page, 'packaging');
  await expect(rows(editor)).toHaveCount(PACKAGING.length);

  // Nine add forms on one page: each control carries the stage's name, so a
  // screen reader's form list is not nine "Add"s (M7's review).
  const text = editor.getByRole('textbox', { name: 'New item for Packaging (TTH)' });
  const minutes = editor.getByRole('spinbutton', { name: 'Minutes for the new Packaging (TTH) item' });
  const add = editor.getByRole('button', { name: 'Add to Packaging (TTH)' });
  await expect(text).toBeVisible();
  await expect(minutes).toBeVisible();
  await expect(add).toBeVisible();

  // Zero minutes, submitted with Enter: the browser's own constraint check
  // would swallow this at `min` with a tooltip and no submit (the bucket add
  // forms had exactly that bug); the refusal is this form's, in a sentence,
  // and no row is written.
  await text.fill('Zero-minute probe');
  await minutes.fill('0');
  await minutes.press('Enter');
  const error = editor.getByTestId('template-add-error');
  await expect(error).toContainText('An item that takes no time is not an item');
  await expect(minutes).toHaveAttribute('aria-invalid', 'true');
  // ...and the box points at the reason, so it can be re-read on return.
  expect(await minutes.getAttribute('aria-describedby')).toBe(await error.getAttribute('id'));
  await expect(rows(editor)).toHaveCount(PACKAGING.length);
  expect((await readTemplate('packaging')).length).toBe(PACKAGING.length);

  // The Add button says the same thing.
  await add.click();
  await expect(error).toBeVisible();
  await expect(rows(editor)).toHaveCount(PACKAGING.length);

  // A row's own estimate box points at its refusal the same way.
  await commit(editor.getByTestId('template-minutes').nth(0), '0');
  const rowError = editor.getByTestId('template-minutes-error');
  await expect(rowError).toBeVisible();
  expect(await editor.getByTestId('template-minutes').nth(0).getAttribute('aria-describedby')).toBe(
    await rowError.getAttribute('id'),
  );
});

/* -------------------------------------------------------------------------- */
/* 6. A failure re-sends only what did not land, and loses nothing on screen */
/* -------------------------------------------------------------------------- */

/**
 * Server actions are POSTs to the page's own address carrying a
 * `Next-Action` header; nothing else on this page POSTs. The route below
 * counts them and can hold, drop or pass each one, which is how a batch is
 * made and how its third member is made to fail.
 */
function interceptActions(
  page: Page,
  decide: (n: number) => 'pass' | 'hold' | 'drop',
): { count: () => number; stop: () => Promise<void> } {
  let n = 0;
  const handler = async (route: import('@playwright/test').Route) => {
    const request = route.request();
    if (request.method() !== 'POST' || !request.headers()['next-action']) {
      await route.continue();
      return;
    }
    n += 1;
    const verdict = decide(n);
    if (verdict === 'drop') {
      await route.abort('failed');
      return;
    }
    if (verdict === 'hold') await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  };
  void page.route('**/settings/checklists/**', handler);
  return {
    count: () => n,
    stop: () => page.unroute('**/settings/checklists/**', handler),
  };
}

test('a batch that fails part-way re-sends only the unsent operations, and a failed edit stays on screen until it is sent', async ({
  page,
}) => {
  await signIn(page);
  await openSettings(page);

  // Scheduled is seeded empty, so the rows below are the whole template.
  const editor = stageEditor(page, 'scheduled');
  await expect(editor.getByTestId('template-empty')).toBeVisible();
  const text = editor.getByTestId('template-add-text');
  const submit = editor.getByTestId('template-add-submit');

  /*
    The first add is held on the wire, so the second and third queue behind
    it as one batch; the third's request is dropped. The batch is applied one
    operation at a time, so R2 lands and R3 does not — and the Retry must
    carry R3 alone. Re-sending the batch inserted R2 twice (the review's
    blocker).
  */
  const first = interceptActions(page, (n) => (n === 1 ? 'hold' : n === 3 ? 'drop' : 'pass'));
  await text.fill('R1');
  await submit.click();
  await text.fill('R2');
  await submit.click();
  await text.fill('R3');
  await submit.click();

  const status = editor.getByTestId('template-save-status');
  await expect(status).toHaveAttribute('data-state', 'error');
  await expect(status).toContainText('Nothing on screen has been lost');
  expect(first.count()).toBe(3);
  await first.stop();

  // Postgres has the two that landed; the screen has all three, the third
  // still marked unsaved rather than gone.
  expect((await readTemplate('scheduled')).map((r) => r.text)).toEqual(['R1', 'R2']);
  expect(await rowTexts(editor)).toEqual(['R1', 'R2', 'R3']);
  await expect(editor.locator('[data-testid="template-row"][data-unsaved="true"]')).toHaveCount(1);

  await editor.getByTestId('template-save-status-retry').click();
  await expect(status).toHaveAttribute('data-state', 'saved');
  await expect.poll(async () => (await readTemplate('scheduled')).map((r) => r.text)).toEqual([
    'R1',
    'R2',
    'R3',
  ]);
  expect(await rowTexts(editor)).toEqual(['R1', 'R2', 'R3']);
  await expect(editor.locator('[data-testid="template-row"][data-unsaved="true"]')).toHaveCount(0);
  expect((await readTemplate('scheduled')).map((r) => r.position)).toEqual([1, 2, 3]);
  // Retry's button is gone with the error; focus landed somewhere useful
  // rather than on <body> — the add box, since what was retried was an add.
  await expect(editor.getByTestId('template-add-text')).toBeFocused();

  /*
    A failed edit. The typed text stays in the box — the status line says
    nothing on screen has been lost, and that has to be true — and the next
    thing the person does carries it, so it is not silently dropped under a
    later "Saved" (the review's major).
  */
  const second = interceptActions(page, () => 'drop');
  await commit(editor.getByTestId('template-text').nth(0), 'Edited offline');
  await expect(status).toHaveAttribute('data-state', 'error');
  await expect(editor.getByTestId('template-text').nth(0)).toHaveValue('Edited offline');
  expect((await readTemplate('scheduled'))[0].text).toBe('R1');
  await second.stop();

  // Another operation, with the wire back: the failed edit goes first.
  await commit(editor.getByTestId('template-minutes').nth(1), '7');
  await expect(status).toHaveAttribute('data-state', 'saved');
  await expect.poll(async () => (await readTemplate('scheduled'))[0].text).toBe('Edited offline');
  expect((await readTemplate('scheduled'))[1].est_minutes).toBe(7);
  await expect(editor.getByTestId('template-text').nth(0)).toHaveValue('Edited offline');
});
