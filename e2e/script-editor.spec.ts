import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';

import {
  CHANNEL_DEFAULTS,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
} from '../lib/defaults';
import { SCRIPT_CONFLICT } from '../lib/script';
import { PG, SEED_EMAIL, SEED_PASSWORD } from '../scripts/dev-stack/shared';

/**
 * M10 — the script, editable in the app.
 *
 * Driven through the real application against the real stack, so that the
 * claims are about the page that ships and the Postgres that `move_video`
 * runs in:
 *
 * 1. typing saves, by itself, and survives a reload;
 * 2. a second tab's save is refused with the page's one "changed somewhere
 *    else" line, and what it typed stays on its screen;
 * 3. a failed save keeps the text and says so, and Retry sends it;
 * 4. Reset asks first, says what it will replace, replaces with **exactly**
 *    what `move_video` wrote (the two implementations compared byte for byte,
 *    on a hook written to break a naive `replaceAll`), and Undo puts it back;
 * 5. structure and end-screen target persist;
 * 6. before Scripting there is no editor, and a video moved back keeps its
 *    text read-only;
 * 7. at 390×844 on a touch device, with the keyboard up (a short viewport),
 *    the line being typed and the save state both stay on screen, the page
 *    does not scroll sideways, and the fields are 16px.
 */

const CHANNEL = { name: 'M10 Script', slug: 'm10-script' };

/** `$&`, `$1` and `$$` are what `String.replaceAll` would expand. */
const HOOK = 'Make $$$ from $& sleep — nine hours a night for $1.';

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
    throw new Error(`the dev stack has no user ${SEED_EMAIL}`);
  }
  userId = found.rows[0].id;
});

test.afterAll(async () => {
  await db?.end();
});

test.beforeEach(async () => {
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug = $1)`,
    [CHANNEL.slug],
  );
  await db.query('delete from public.channels where slug = $1', [CHANNEL.slug]);
  channelId = await createChannel();
});

/* -------------------------------------------------------------------------- */
/* Fixture: every write goes through RLS, the grants and the real functions    */
/* -------------------------------------------------------------------------- */

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

async function createChannel(): Promise<string> {
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
        CHANNEL.name,
        CHANNEL.slug,
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

async function capture(title: string): Promise<string> {
  return asUser(async () => {
    const result = await db.query<{ id: string }>(
      'select id from capture_video($1::uuid, $2::text)',
      [channelId, title],
    );
    return result.rows[0].id;
  });
}

async function move(videoId: string, kind: string): Promise<void> {
  const stage = await db.query<{ id: string }>(
    'select id from public.stages where channel_id = $1 and kind = $2',
    [channelId, kind],
  );
  await asUser(async () => {
    await db.query('select move_video($1::uuid, $2::uuid)', [videoId, stage.rows[0].id]);
  });
}

/** The gate's three fields, with `HOOK` chosen and a decoy before it. */
async function satisfyGate(videoId: string): Promise<void> {
  await asUser(async () => {
    await db.query(
      `update public.videos
          set title = 'I slept nine hours a night for a month',
              thumbnail_concept = 'Me asleep on a desk, a big 9 behind',
              hooks = $2::jsonb
        where id = $1`,
      [
        videoId,
        JSON.stringify([
          { id: 'hook-a', text: 'Not this one.', chosen: false },
          { id: 'hook-b', text: HOOK, chosen: true },
        ]),
      ],
    );
  });
}

/** A video `move_video` has just carried into Scripting, script and all. */
async function inScripting(title: string): Promise<string> {
  const videoId = await capture(title);
  await satisfyGate(videoId);
  await move(videoId, 'packaging');
  await move(videoId, 'scripting');
  return videoId;
}

/**
 * The seeded template with a hook in it, spelled out rather than through
 * `String.replace`, which would read the `$&` in `HOOK` as a pattern — the
 * very mistake the app's own build is tested for.
 */
function withHook(hook: string): string {
  return SCRIPT_TEMPLATE.split('{{hook}}').join(hook);
}

interface ScriptRow {
  script: string | null;
  script_structure: string | null;
  end_screen_target: string | null;
}

async function readRow(videoId: string): Promise<ScriptRow> {
  const result = await db.query<ScriptRow>(
    'select script, script_structure, end_screen_target from public.videos where id = $1',
    [videoId],
  );
  return result.rows[0];
}

/* -------------------------------------------------------------------------- */
/* Browser helpers                                                             */
/* -------------------------------------------------------------------------- */

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(SEED_EMAIL);
  await page.getByLabel('Password').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/now');
}

/** Open the Script tab and wait until its handlers exist. */
async function openScript(page: Page, videoId: string): Promise<void> {
  await page.goto(`/videos/${videoId}?section=script`);
  await expect(page.getByTestId('script-section')).toHaveAttribute('data-live', 'true');
}

/** Put the caret at the very end of the script and type there. */
async function typeAtEnd(page: Page, text: string): Promise<void> {
  const editor = page.getByTestId('script-editor');
  await editor.focus();
  await editor.evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(element.value.length, element.value.length);
  });
  await page.keyboard.type(text);
}

/* -------------------------------------------------------------------------- */
/* 1. Typing saves                                                             */
/* -------------------------------------------------------------------------- */

test('typing saves by itself, without a blur, and survives a reload', async ({ page }) => {
  const videoId = await inScripting('Typing saves');
  const written = (await readRow(videoId)).script;
  expect(written).toContain(HOOK);

  await signIn(page);
  await openScript(page, videoId);

  // The editor opens on exactly what `move_video` wrote.
  await expect(page.getByTestId('script-editor')).toHaveValue(written!);
  await expect(
    page.getByTestId('section-tab-script').getByTestId('section-mark'),
  ).toHaveAttribute('data-mark', 'done');

  await typeAtEnd(page, '\nThe line I wrote tonight.');

  // No blur: the pause is the save. The status says so, then says Saved.
  await expect(page.getByTestId('script-status')).toHaveAttribute('data-state', 'saved');
  await expect
    .poll(async () => (await readRow(videoId)).script)
    .toBe(`${written}\nThe line I wrote tonight.`);
  await expect(page.getByTestId('script-editor')).toBeFocused();

  // Saved means a reload does not ask, and brings the text back.
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.accept();
  });
  await page.reload();
  await expect(page.getByTestId('script-section')).toHaveAttribute('data-live', 'true');
  expect(dialogs).toEqual([]);
  await expect(page.getByTestId('script-editor')).toHaveValue(
    `${written}\nThe line I wrote tonight.`,
  );

  // Typed and reloaded straight away, inside the pause: the browser asks.
  await typeAtEnd(page, ' And one more.');
  await page.reload();
  expect(dialogs).toEqual(['beforeunload']);
});

test('the box grows with the script instead of scrolling inside itself', async ({
  page,
}) => {
  const videoId = await inScripting('Growing box');
  await signIn(page);
  await openScript(page, videoId);

  const editor = page.getByTestId('script-editor');
  const before = (await editor.boundingBox())!.height;
  await typeAtEnd(page, '\n' + Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`).join('\n'));

  const sizes = await editor.evaluate((element: HTMLTextAreaElement) => ({
    client: element.clientHeight,
    scroll: element.scrollHeight,
    font: getComputedStyle(element).fontFamily,
  }));
  // No inner scrollbar: the box is as tall as what is in it.
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1);
  expect((await editor.boundingBox())!.height).toBeGreaterThan(before);
  // The user's own writing is set in the reading face.
  expect(sizes.font).toMatch(/Newsreader/i);
});

/* -------------------------------------------------------------------------- */
/* 2. A second tab                                                             */
/* -------------------------------------------------------------------------- */

test('a second tab is refused with the changed-elsewhere line, and keeps its text', async ({
  page,
  context,
}) => {
  const videoId = await inScripting('Two tabs');
  await signIn(page);
  await openScript(page, videoId);

  const second = await context.newPage();
  await openScript(second, videoId);

  // Tab one writes first.
  await typeAtEnd(page, '\nFrom the first tab.');
  await expect.poll(async () => (await readRow(videoId)).script).toContain('From the first tab.');

  // Tab two was rendered before that, so its save is computed against a row
  // that no longer exists — refused, not written over the first tab's line.
  await typeAtEnd(second, '\nFrom the second tab.');
  const status = second.getByTestId('script-status');
  await expect(status).toHaveAttribute('data-state', 'error');
  await expect(status).toContainText(SCRIPT_CONFLICT);
  await expect(second.getByTestId('script-status-reload')).toBeVisible();

  const row = await readRow(videoId);
  expect(row.script).toContain('From the first tab.');
  expect(row.script).not.toContain('From the second tab.');
  // Nothing lost silently: what the second tab typed is still in its box.
  await expect(second.getByTestId('script-editor')).toHaveValue(/From the second tab\.$/);
});

/* -------------------------------------------------------------------------- */
/* 3. A failed save                                                            */
/* -------------------------------------------------------------------------- */

test('a save that cannot reach the server keeps the text, says so, and Retry sends it', async ({
  page,
}) => {
  const videoId = await inScripting('Offline for a moment');
  await signIn(page);
  await openScript(page, videoId);

  // Server actions are POSTs to the page's own URL; drop them.
  const drop = (route: import('@playwright/test').Route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue();
  await page.route(`**/videos/${videoId}**`, drop);

  await typeAtEnd(page, '\nWritten on a train.');
  const status = page.getByTestId('script-status');
  await expect(status).toHaveAttribute('data-state', 'error');
  await expect(page.getByTestId('script-editor')).toHaveValue(/Written on a train\.$/);
  expect((await readRow(videoId)).script).not.toContain('Written on a train.');

  await page.unroute(`**/videos/${videoId}**`, drop);
  await page.getByTestId('script-status-retry').click();
  await expect(status).toHaveAttribute('data-state', 'saved');
  await expect.poll(async () => (await readRow(videoId)).script).toContain('Written on a train.');
});

/* -------------------------------------------------------------------------- */
/* 4. Reset from template                                                      */
/* -------------------------------------------------------------------------- */

test('reset asks, says what it replaces, writes what move_video wrote, and undo restores', async ({
  page,
}) => {
  const videoId = await inScripting('Reset and undo');
  const fromMoveVideo = (await readRow(videoId)).script!;

  await signIn(page);
  await openScript(page, videoId);

  // Make it the person's own script.
  const editor = page.getByTestId('script-editor');
  await editor.fill('My own script, three evenings of it.\n\nHook: something else entirely.');
  await expect(page.getByTestId('script-status')).toHaveAttribute('data-state', 'saved');
  const mine = (await readRow(videoId)).script!;
  expect(mine).toBe('My own script, three evenings of it.\n\nHook: something else entirely.');

  // Asks first — and Keep changes nothing.
  await page.getByTestId('script-reset').click();
  const dialog = page.getByTestId('script-reset-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('script-reset-cancel')).toBeFocused();
  await expect(page.getByTestId('script-reset-what')).toContainText('11 words');
  await expect(page.getByTestId('script-reset-what')).toContainText(CHANNEL.name);
  await expect(page.getByTestId('script-reset-hook')).toContainText(HOOK);
  await page.getByTestId('script-reset-cancel').click();
  await expect(dialog).toBeHidden();
  await expect(editor).toHaveValue(mine);
  expect((await readRow(videoId)).script).toBe(mine);

  // Replace: the box and the row now hold, byte for byte, what `move_video`
  // wrote — the TypeScript build and the SQL agree, `$&` and all.
  await page.getByTestId('script-reset').click();
  await page.getByTestId('script-reset-confirm').click();
  await expect(dialog).toBeHidden();
  await expect(editor).toHaveValue(fromMoveVideo);
  await expect.poll(async () => (await readRow(videoId)).script).toBe(fromMoveVideo);
  await expect(page.getByTestId('script-reset-notice')).toHaveAttribute('data-kind', 'replaced');

  // Undo puts the person's own script back, in the box and in the row.
  await page.getByTestId('script-reset-undo').click();
  await expect(editor).toHaveValue(mine);
  await expect.poll(async () => (await readRow(videoId)).script).toBe(mine);
  await expect(page.getByTestId('script-reset-notice')).toHaveAttribute('data-kind', 'restored');
});

test('reset writes in a hook chosen after the video entered Scripting without one', async ({
  page,
}) => {
  // Skipped the gate with no hook: `move_video` wrote an empty Hook section.
  const videoId = await capture('Skipped the gate');
  await asUser(async () => {
    await db.query(
      `update public.videos
          set packaging_skipped_at = now(), packaging_skip_reason = 'Filming tomorrow'
        where id = $1`,
      [videoId],
    );
  });
  await move(videoId, 'scripting');
  const empty = (await readRow(videoId)).script!;
  expect(empty).toBe(withHook(''));

  await signIn(page);
  await openScript(page, videoId);

  // No hook yet: the dialog says the Hook section will stay empty. (The box
  // holds the template, so there is something to replace, and it asks.)
  await typeAtEnd(page, 'Notes.');
  await expect(page.getByTestId('script-status')).toHaveAttribute('data-state', 'saved');
  await page.getByTestId('script-reset').click();
  await expect(page.getByTestId('script-reset-hook')).toContainText('No hook is chosen');
  await page.getByTestId('script-reset-cancel').click();

  // Now one is chosen, and Reset — which reads the hooks as they are stored,
  // not as this page last saw them — writes it in. (The fixture's column
  // write leaves `updated_at` alone, as a hook chosen on the Packaging tab of
  // this same page would not; the version check is the next test's business.)
  await satisfyGate(videoId);
  await page.getByTestId('script-reset').click();
  await expect(page.getByTestId('script-reset-hook')).toContainText(HOOK);
  await page.getByTestId('script-reset-confirm').click();
  await expect(page.getByTestId('script-editor')).toHaveValue(
    withHook(HOOK),
  );
  await expect
    .poll(async () => (await readRow(videoId)).script)
    .toBe(withHook(HOOK));
});

test('reset on an empty script starts it without asking', async ({ page }) => {
  const videoId = await inScripting('Empty start');
  await asUser(async () => {
    await db.query('update public.videos set script = null, updated_at = now() where id = $1', [
      videoId,
    ]);
  });
  await signIn(page);
  await openScript(page, videoId);
  await expect(page.getByTestId('script-editor')).toHaveValue('');
  await expect(
    page.getByTestId('section-tab-script').getByTestId('section-mark'),
  ).toHaveCount(0);

  await page.getByTestId('script-reset').click();
  await expect(page.getByTestId('script-reset-dialog')).toHaveCount(0);
  await expect(page.getByTestId('script-reset-notice')).toHaveAttribute('data-kind', 'started');
  await expect
    .poll(async () => (await readRow(videoId)).script)
    .toBe(withHook(HOOK));
});

/* -------------------------------------------------------------------------- */
/* 5. Structure and end-screen target                                          */
/* -------------------------------------------------------------------------- */

test('structure and end-screen target persist', async ({ page }) => {
  const videoId = await inScripting('Structure and end screen');
  await signIn(page);
  await openScript(page, videoId);

  await page.getByTestId('script-structure').selectOption('three_part');
  await expect.poll(async () => (await readRow(videoId)).script_structure).toBe('three_part');

  const target = page.getByTestId('script-end-screen');
  await target.fill('  How I fixed my mornings  ');
  await target.press('Tab');
  await expect(target).toHaveValue('How I fixed my mornings');
  await expect
    .poll(async () => (await readRow(videoId)).end_screen_target)
    .toBe('How I fixed my mornings');

  await page.reload();
  await expect(page.getByTestId('script-section')).toHaveAttribute('data-live', 'true');
  await expect(page.getByTestId('script-structure')).toHaveValue('three_part');
  await expect(target).toHaveValue('How I fixed my mornings');

  // Cleared is NULL, not ''.
  await page.getByTestId('script-structure').selectOption('');
  await target.fill('');
  await target.press('Tab');
  await expect
    .poll(async () => {
      const row = await readRow(videoId);
      return [row.script_structure, row.end_screen_target];
    })
    .toEqual([null, null]);
});

/* -------------------------------------------------------------------------- */
/* 6. Where it is not editable                                                 */
/* -------------------------------------------------------------------------- */

test('before Scripting there is no editor, and a video moved back keeps its text', async ({
  page,
}) => {
  const idea = await capture('Still an idea');
  await signIn(page);
  await openReadOnly(page, idea);
  await expect(page.getByTestId('script-editor')).toHaveCount(0);
  await expect(page.getByTestId('script-empty')).toContainText('into Scripting');
  await expect(
    page.getByTestId('section-tab-script').getByTestId('section-mark'),
  ).toHaveAttribute('data-mark', 'locked');
  // The stale M3–M9 sentences are gone.
  await expect(page.getByTestId('script-section')).not.toContainText('own editor');
  await expect(page.getByTestId('script-section')).not.toContainText('written once');

  const back = await inScripting('Moved back');
  await move(back, 'packaging');
  await openReadOnly(page, back);
  await expect(page.getByTestId('script-editor')).toHaveCount(0);
  await expect(page.getByTestId('script-kept')).toContainText('back in Packaging');
  await expect(page.getByTestId('script-text')).toContainText(HOOK);
});

async function openReadOnly(page: Page, videoId: string): Promise<void> {
  await page.goto(`/videos/${videoId}?section=script`);
  await expect(page.getByTestId('script-section')).toHaveAttribute('data-editable', 'false');
}

/* -------------------------------------------------------------------------- */
/* 7. On a phone                                                               */
/* -------------------------------------------------------------------------- */

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('at 390px with the keyboard up, the typed line and the save state stay on screen', async ({
    page,
  }) => {
    const videoId = await inScripting('Written on a phone');
    await signIn(page);
    await openScript(page, videoId);

    const editor = page.getByTestId('script-editor');
    // The two fields arrive folded into one line, so the script is what a
    // phone opens on; the line says what is set and opens them.
    const toggle = page.getByTestId('script-details-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText('not set');
    await expect(page.getByTestId('script-structure')).toBeHidden();
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await editor.boundingBox())!.y).toBeLessThan(844);
    await toggle.tap();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('script-structure')).toBeVisible();

    // 16px, or iOS zooms the page when the field takes focus.
    for (const testId of ['script-editor', 'script-structure', 'script-end-screen']) {
      expect(
        await page.getByTestId(testId).evaluate((element) => getComputedStyle(element).fontSize),
        testId,
      ).toBe('16px');
    }
    // A thumb's target, on every control the tab has.
    for (const testId of ['script-reset', 'script-structure', 'script-end-screen']) {
      expect((await page.getByTestId(testId).boundingBox())!.height, testId).toBeGreaterThanOrEqual(44);
    }

    await editor.tap();
    // The on-screen keyboard takes roughly half of an 844px screen.
    await page.setViewportSize({ width: 390, height: 420 });
    await typeAtEnd(
      page,
      '\n' + Array.from({ length: 30 }, (_, i) => `Phone line ${i + 1}.`).join('\n'),
    );

    const layout = await page.evaluate(() => {
      const box = (id: string) =>
        document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
      const editor = document.querySelector('[data-testid="script-editor"]')!;
      const style = getComputedStyle(editor);
      const lineHeight = parseFloat(style.lineHeight);
      const halfLeading = (lineHeight - parseFloat(style.fontSize)) / 2;
      const status = box('script-status');
      const toolbar = box('script-toolbar');
      return {
        innerHeight: window.innerHeight,
        lineHeight,
        lastGlyphsBottom:
          box('script-editor').bottom -
          parseFloat(style.paddingBottom) -
          parseFloat(style.borderBottomWidth) -
          halfLeading,
        toolbarBottom: toolbar.bottom,
        statusTop: status.top,
        statusBottom: status.bottom,
        toolbarTop: toolbar.top,
        sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    // The last line — where the caret is — is on screen, below the toolbar.
    // The box has no scrollbar of its own, so its last line sits just above
    // its bottom padding; the glyphs are the line box less its half-leading.
    expect(layout.lastGlyphsBottom).toBeLessThanOrEqual(layout.innerHeight + 1);
    expect(layout.lastGlyphsBottom - layout.lineHeight).toBeGreaterThan(layout.toolbarBottom);
    // The save state has not scrolled away: the toolbar sits under the 57px bar.
    expect(layout.toolbarTop).toBeGreaterThanOrEqual(56);
    expect(layout.statusTop).toBeGreaterThanOrEqual(0);
    expect(layout.statusBottom).toBeLessThanOrEqual(layout.innerHeight);
    expect(layout.sideways).toBe(false);

    await expect(page.getByTestId('script-status')).toHaveAttribute('data-state', 'saved');
    await expect.poll(async () => (await readRow(videoId)).script).toContain('Phone line 30.');

    // And the rest of the tab works by touch.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId('script-structure').selectOption('story_arc');
    await expect.poll(async () => (await readRow(videoId)).script_structure).toBe('story_arc');
    await expect(toggle).toContainText('Story arc');
    await page.getByTestId('script-reset').tap();
    await expect(page.getByTestId('script-reset-dialog')).toBeVisible();
    await page.getByTestId('script-reset-confirm').tap();
    await expect.poll(async () => (await readRow(videoId)).script).not.toContain('Phone line 30.');
    await page.getByTestId('script-reset-undo').tap();
    await expect.poll(async () => (await readRow(videoId)).script).toContain('Phone line 30.');
  });
});

/* -------------------------------------------------------------------------- */
/* 8. The M10 review                                                           */
/* -------------------------------------------------------------------------- */

/** Every server-action POST from this page, with a hook to hold one back. */
function holdFirstSave(page: Page, videoId: string, ms: number) {
  let held = false;
  return page.route(`**/videos/${videoId}**`, async (route) => {
    if (route.request().method() === 'POST' && !held) {
      held = true;
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    await route.continue();
  });
}

async function chooseStage(page: Page, name: string): Promise<void> {
  await page.getByTestId('section-tab-schedule').click();
  const select = page.getByTestId('stage-select');
  // The seed's names carry a suffix ("Packaging (TTH)"); match by text.
  const value = await select.locator('option', { hasText: name }).first().getAttribute('value');
  await select.selectOption(value!);
}

test('moving back to Packaging straight after typing waits for the script to save', async ({
  page,
}) => {
  const videoId = await inScripting('Typed then moved back');
  await signIn(page);
  await openScript(page, videoId);

  // The save is slow (a long script on a phone's uplink); the move is not.
  await holdFirstSave(page, videoId, 1500);
  await typeAtEnd(page, '\nTyped just before moving back.');
  await chooseStage(page, 'Packaging');

  // The move is made after the save lands, not over it.
  await expect(page.getByTestId('stage-select-status')).toContainText('Moved to Packaging');
  const row = await db.query<{ script: string; kind: string }>(
    `select v.script, s.kind from public.videos v join public.stages s on s.id = v.stage_id
      where v.id = $1`,
    [videoId],
  );
  expect(row.rows[0].kind).toBe('packaging');
  expect(row.rows[0].script).toContain('Typed just before moving back.');

  // The tab now shows the kept script, with the line in it.
  await page.getByTestId('section-tab-script').click();
  await expect(page.getByTestId('script-text')).toContainText('Typed just before moving back.');
});

test('a move is refused while the script cannot save, and says why', async ({ page }) => {
  const videoId = await inScripting('Move while failing');
  await signIn(page);
  await openScript(page, videoId);

  const drop = (route: import('@playwright/test').Route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue();
  await page.route(`**/videos/${videoId}**`, drop);
  await typeAtEnd(page, '\nNot saved yet.');
  await expect(page.getByTestId('script-status')).toHaveAttribute('data-state', 'error');

  await chooseStage(page, 'Packaging');
  await expect(page.getByTestId('stage-select-status')).toContainText('has not saved yet');
  const kind = await db.query<{ kind: string }>(
    `select s.kind from public.videos v join public.stages s on s.id = v.stage_id where v.id = $1`,
    [videoId],
  );
  expect(kind.rows[0].kind).toBe('scripting');
  await page.unroute(`**/videos/${videoId}**`, drop);
});

test('a stale tab that moves the stage is still refused, not written over the other tab', async ({
  page,
  context,
}) => {
  const videoId = await inScripting('Stale tab moves');
  await signIn(page);
  const second = await context.newPage();
  await openScript(second, videoId);
  await openScript(page, videoId);

  await typeAtEnd(page, '\nLINE-FROM-TAB-ONE');
  await expect.poll(async () => (await readRow(videoId)).script).toContain('LINE-FROM-TAB-ONE');

  // Tab two, rendered before that save, moves the video on. The move is made.
  await chooseStage(second, 'Filming');
  await expect(second.getByTestId('stage-select-status')).toContainText('Moved to Filming');

  // Its next script save is still computed against the old row: refused.
  await second.getByTestId('section-tab-script').click();
  await typeAtEnd(second, '\nLINE-FROM-TAB-TWO');
  await expect(second.getByTestId('script-status')).toHaveAttribute('data-state', 'error');
  await expect(second.getByTestId('script-status')).toContainText(SCRIPT_CONFLICT);
  const row = await readRow(videoId);
  expect(row.script).toContain('LINE-FROM-TAB-ONE');
  expect(row.script).not.toContain('LINE-FROM-TAB-TWO');
});

test('after a conflict, Reload works on the first press and the text comes back after it', async ({
  page,
  context,
}) => {
  const videoId = await inScripting('Conflict then reload');
  await signIn(page);
  const second = await context.newPage();
  await openScript(second, videoId);
  await openScript(page, videoId);

  await typeAtEnd(page, '\nFIRST');
  await expect.poll(async () => (await readRow(videoId)).script).toContain('FIRST');

  await typeAtEnd(second, '\nSECOND');
  const status = second.getByTestId('script-status');
  await expect(status).toHaveAttribute('data-state', 'error');
  // Typing on does not clear the line or re-send the refused save.
  await second.keyboard.type(' more');
  await expect(status).toHaveAttribute('data-state', 'error');
  await expect(second.getByTestId('script-status-copy')).toBeVisible();
  await expect(second.getByTestId('script-editor')).toBeFocused();

  // One press, from the box: the page reloads (the browser asks first,
  // because the box holds text the row does not).
  second.on('dialog', (dialog) => void dialog.accept());
  const reloaded = second.waitForEvent('load');
  await second.getByTestId('script-status-reload').click();
  await reloaded;
  await expect(second.getByTestId('script-section')).toHaveAttribute('data-live', 'true');

  // The box holds the row; this tab's text is offered back.
  await expect(second.getByTestId('script-editor')).not.toHaveValue(/SECOND/);
  await expect(second.getByTestId('script-recover')).toBeVisible();
  await second.getByTestId('script-recover-use').click();
  await expect(second.getByTestId('script-editor')).toHaveValue(/SECOND more$/);
  await expect.poll(async () => (await readRow(videoId)).script).toContain('SECOND more');
  await expect(second.getByTestId('script-recover')).toHaveCount(0);
});

test('undo is retired once the box is edited after a reset', async ({ page }) => {
  const videoId = await inScripting('Undo retires');
  await signIn(page);
  await openScript(page, videoId);

  const editor = page.getByTestId('script-editor');
  await editor.fill('Mine.');
  await expect(page.getByTestId('script-status')).toHaveAttribute('data-state', 'saved');
  await page.getByTestId('script-reset').click();
  await page.getByTestId('script-reset-confirm').click();
  await expect(page.getByTestId('script-reset-undo')).toBeVisible();

  await typeAtEnd(page, '\nTwenty minutes of new writing after the reset.');
  await expect(page.getByTestId('script-reset-undo')).toHaveCount(0);
  await expect
    .poll(async () => (await readRow(videoId)).script)
    .toContain('Twenty minutes of new writing after the reset.');
});

test('the end-screen field keeps a long paste whole and says it is too long', async ({
  page,
}) => {
  const videoId = await inScripting('Long end screen');
  await signIn(page);
  await openScript(page, videoId);

  const field = page.getByTestId('script-end-screen');
  const long = 'A'.repeat(299) + 'BCDEFG';
  await field.fill(long);
  await expect(field).toHaveValue(long);
  await field.blur();
  await expect(page.getByTestId('script-status')).toHaveAttribute('data-state', 'error');
  await expect(field).toHaveValue(long);
  expect((await readRow(videoId)).end_screen_target).toBeNull();
});

test('a lone surrogate saves as what the row stores, not as a false "Saved"', async ({
  page,
}) => {
  const videoId = await inScripting('Lone surrogate');
  await signIn(page);
  await openScript(page, videoId);

  await page.getByTestId('script-editor').fill('Lone \uD83D surrogate');
  await expect(page.getByTestId('script-status')).toHaveAttribute('data-state', 'saved');
  expect((await readRow(videoId)).script).toBe('Lone � surrogate');
  // Nothing left unsaved: the box and the row agree in their stored form.
  await expect(page.getByTestId('script-status')).not.toContainText('Saves when you pause');
});

test('the save line’s buttons are 44px by touch', async ({ browser, baseURL }) => {
  const videoId = await inScripting('Touch retry');
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await signIn(page);
  await openScript(page, videoId);
  const drop = (route: import('@playwright/test').Route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue();
  await page.route(`**/videos/${videoId}**`, drop);
  await typeAtEnd(page, '\nOn a train.');
  await expect(page.getByTestId('script-status')).toHaveAttribute('data-state', 'error');
  const retry = await page.getByTestId('script-status-retry').boundingBox();
  expect(retry!.height).toBeGreaterThanOrEqual(44);
  await context.close();
});
