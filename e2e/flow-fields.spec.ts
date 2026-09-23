import { expect, test, type Locator, type Page } from '@playwright/test';
import pg from 'pg';

import {
  CHANNEL_DEFAULTS,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
} from '../lib/defaults';
import { apiKey } from '../scripts/dev-stack/jwt';
import { untilTaken } from './hydration';
import {
  API_KEY_EXP,
  API_KEY_IAT,
  GATEWAY_URL,
  PG,
  SEED_EMAIL,
  SEED_PASSWORD,
} from '../scripts/dev-stack/shared';

const ANON_KEY = apiKey('anon', API_KEY_IAT, API_KEY_EXP);

/**
 * M2 — the flow half of the video detail page.
 *
 * Target publish date, the final YouTube URL, notes, `waiting_on`, archive and
 * the stage select, driven in a real browser against the real PostgREST + RLS
 * stack (`scripts/dev-stack`). Nothing is stubbed: a save is a server action
 * writing a column through the anon key and the user's own JWT, and the stage
 * select's refusal comes out of plpgsql.
 *
 * ## What each test is actually for
 *
 * - **The date** is the board's primary sort key, so "set it" and "clear it"
 *   are two different claims and both are checked on the card as well as in the
 *   field. `nulls last` is where an unplanned video belongs, and a field that
 *   can only ever be filled in cannot put one back.
 * - **Archive** must take the card off the board *without deleting the row*.
 *   The row is therefore checked in SQL, not just on screen — "the card is
 *   gone" is equally true of a delete.
 * - **The stage select** is the third door onto one gate. The test refuses the
 *   same move twice — once by dragging on the board, once from the select — and
 *   asserts the second refusal contains the sentence the first one produced,
 *   character for character, rather than asserting a string this file made up.
 *   That is the only way the two can be shown not to have drifted.
 * - **`waiting_on`** is one of the three stored inputs `/now` will read in M3,
 *   so it is checked where it is stored (`videos.waiting_on` and the
 *   `waiting_since` it is paired with), not only where it is displayed.
 *
 * ## The fixture
 *
 * One throwaway channel, built through the same `create_channel` /
 * `capture_video` / `move_video` functions the app calls, over a connection
 * with `set local role authenticated` and `request.jwt.claims` set — so RLS and
 * the column grants apply exactly as they do to a request. A seed written with
 * superuser INSERTs could produce a row the app itself can never reach, and
 * would then prove nothing about the gate.
 *
 * | Video          | Column     | State                                        |
 * |----------------|------------|----------------------------------------------|
 * | Gate blocked   | Packaging  | a title and nothing else — the gate fixture  |
 * | Date target    | Idea       | nothing set; the date and URL fixture        |
 * | Archive me     | Scripting  | packaging complete; the archive fixture      |
 * | Waiting test   | Idea       | nothing set; the `waiting_on` fixture        |
 * | Already out    | Published  | `published_at` stamped by `move_video`       |
 */

const CHANNEL = { name: 'M2 Flow', slug: 'm2-flow' };

const stageName = (kind: string): string => {
  const stage = SEED_STAGES.find((candidate) => candidate.kind === kind);
  if (!stage) throw new Error(`no seeded stage of kind ${kind}`);
  return stage.name;
};

const IDEA = stageName('idea');
const PACKAGING = stageName('packaging');
const SCRIPTING = stageName('scripting');

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

let db: pg.Client;
let userId: string;

/** Title → id, rebuilt for every test. */
let videos: Map<string, string>;

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
  videos = await resetFixture();
});

/** Run `fn` as the signed-in user, the way a PostgREST request runs. */
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
        JSON.stringify(SEED_BUCKETS.map((b) => ({ ...b, monthly_quota: null }))),
      ],
    );
    return result.rows[0].id;
  });
}

async function capture(channelId: string, title: string): Promise<string> {
  return asUser(async () => {
    const result = await db.query<{ id: string }>(
      'select id from capture_video($1::uuid, $2::text)',
      [channelId, title],
    );
    return result.rows[0].id;
  });
}

/** Fill the three gate fields, as a client legitimately can. */
async function completePackaging(videoId: string): Promise<void> {
  await asUser(async () => {
    await db.query(
      `update public.videos
          set thumbnail_concept = 'Face left, three props on the desk',
              hooks = $2::jsonb,
              updated_at = now()
        where id = $1`,
      [
        videoId,
        JSON.stringify([{ id: 'h1', text: 'The first ten seconds', chosen: true }]),
      ],
    );
  });
}

async function moveTo(
  videoId: string,
  channelId: string,
  kind: string,
): Promise<void> {
  await asUser(async () => {
    await db.query(
      `select move_video($1::uuid,
                         (select id from public.stages
                           where channel_id = $2::uuid and kind = $3::text))`,
      [videoId, channelId, kind],
    );
  });
}

async function resetFixture(): Promise<Map<string, string>> {
  // Videos first: videos -> stages is `on delete no action`, so clearing the
  // rows before the channel cascade keeps the delete order out of the picture.
  await db.query(
    `delete from public.videos
      where channel_id in (select id from public.channels where slug = $1)`,
    [CHANNEL.slug],
  );
  await db.query('delete from public.channels where slug = $1', [CHANNEL.slug]);

  const channelId = await createChannel();
  const byTitle = new Map<string, string>();

  const blocked = await capture(channelId, 'Gate blocked');
  await moveTo(blocked, channelId, 'packaging');
  byTitle.set('Gate blocked', blocked);

  byTitle.set('Date target', await capture(channelId, 'Date target'));
  byTitle.set('Waiting test', await capture(channelId, 'Waiting test'));

  const archive = await capture(channelId, 'Archive me');
  await completePackaging(archive);
  await moveTo(archive, channelId, 'scripting');
  byTitle.set('Archive me', archive);

  // The other side of the URL branch. `move_video` stamps `published_at` on
  // first entry to a Published stage, and that stamp is the only thing that
  // knows this video is actually out.
  const live = await capture(channelId, 'Already out');
  await completePackaging(live);
  await moveTo(live, channelId, 'published');
  byTitle.set('Already out', live);

  return byTitle;
}

/** The stored row, read with full privilege — this is the claim, not the UI. */
async function row(title: string): Promise<{
  target_publish_date: string | null;
  waiting_on: string | null;
  waiting_since: string | null;
  archived_at: string | null;
  youtube_url: string | null;
  notes: string | null;
  stage_kind: string | null;
} | null> {
  const result = await db.query(
    // `target_publish_date` is cast to text: node-pg hands a `date` back as a
    // JS Date in the *runner's* zone, which is a different value from the
    // calendar day the column holds. The column is a day, so it is read as one.
    `select v.target_publish_date::text as target_publish_date,
            v.waiting_on, v.waiting_since, v.archived_at,
            v.youtube_url, v.notes, s.kind as stage_kind
       from public.videos v
       join public.stages s on s.id = v.stage_id
      where v.id = $1`,
    [videos.get(title)],
  );
  return result.rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Browser helpers                                                             */
/* -------------------------------------------------------------------------- */

async function signIn(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 1000 });
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

/**
 * Open a video's detail page at the flow block and wait for it to be there.
 *
 * M3 put the page into sections, and the flow fields are the Schedule one, so
 * the URL names it. That is the section routing's own promise being used
 * exactly as a user would paste it — not a workaround for it: `?section=` is
 * parsed on the server, so this navigation lands with the block already
 * rendered rather than switching to it after hydration.
 */
async function openVideo(page: Page, title: string): Promise<void> {
  await page.goto(`/videos/${videos.get(title)}?section=schedule`);
  await expect(page.getByTestId('flow-fields')).toBeVisible();
}

async function openBoard(page: Page): Promise<void> {
  await page.goto(`/c/${CHANNEL.slug}/board`);
  // The columns are server-rendered, so they are on screen before the board can
  // be used; `data-ready` is set by the board's own mount effect.
  await expect(page.getByTestId('board')).toHaveAttribute('data-ready', 'true');
}

const column = (page: Page, name: string): Locator =>
  page.getByRole('region', { name, exact: true });

const cardIn = (page: Page, name: string, title: string): Locator =>
  column(page, name).getByTestId('board-card').filter({ hasText: title });

/**
 * Drive a native HTML5 drag. `locator.dragTo()` synthesises mouse events, which
 * do not start one, so the three events the board listens for are dispatched by
 * hand, sharing one `DataTransfer` exactly as the browser would.
 */
async function dragCardTo(
  page: Page,
  card: Locator,
  targetColumn: string,
): Promise<void> {
  const dropzone = column(page, targetColumn).getByTestId('column-dropzone');
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());

  await card.dispatchEvent('dragstart', { dataTransfer });
  await dropzone.dispatchEvent('dragover', { dataTransfer });
  await dropzone.dispatchEvent('drop', { dataTransfer });
  await dataTransfer.dispose();
}

/* -------------------------------------------------------------------------- */
/* Target publish date                                                         */
/* -------------------------------------------------------------------------- */

test('the target date can be set and cleared, and the card follows', async ({
  page,
}) => {
  await signIn(page);
  await openVideo(page, 'Date target');

  const field = page.getByTestId('target-date');
  const status = page.getByTestId('target-date-status');

  await expect(field).toHaveValue('');
  await expect(page.getByTestId('target-date-clear')).toBeDisabled();

  /*
    Set it. The field saves on change *and* on blur; either alone is enough,
    and `commit` is a no-op the second time, so this is one save.

    Retried through `untilTaken` because this is the first interaction after a
    navigation and `/videos/[id]` is the heaviest route in the app: a fill that
    lands before hydration puts text in the box that no draft knows about, and
    the save never happens. M8 widened that window again by giving the page
    three assist panels, which is how this surfaced — see `e2e/hydration.ts`,
    which is explicit that the retry is the faithful assertion and not a
    workaround.

    Cleared first on every attempt, so each one is a change (M9 review): a
    fill swallowed before hydration leaves 2026-11-20 in the box and React's
    draft empty, and filling the same value again is not a change, so the
    retry never saved — this spec failed a full run that way. The week spec
    already did this.
  */
  await untilTaken(
    async () => {
      await field.fill('');
      await field.fill('2026-11-20');
      await field.blur();
    },
    () => expect(status).toHaveText('Saved', { timeout: 4_000 }),
  );

  await expect
    .poll(async () => (await row('Date target'))?.target_publish_date)
    .toBe('2026-11-20');

  // A reload agrees, so the column was written rather than the field
  // remembering.
  await page.reload();
  await expect(page.getByTestId('target-date')).toHaveValue('2026-11-20');

  // And the board's card carries it — this is the column's primary sort key.
  await openBoard(page);
  await expect(
    cardIn(page, IDEA, 'Date target').getByTestId('target-date'),
    // The visually-hidden prefix is part of the chip: a screen reader hears
    // what the date is for, not a bare "20 Nov" among the other chips.
  ).toHaveText('Target publish date: 20 Nov');

  // Clear it. "Not scheduled yet" is the normal state of most of the board, so
  // this has to be as available as setting one.
  await openVideo(page, 'Date target');
  await page.getByTestId('target-date-clear').click();
  await expect(page.getByTestId('target-date-status')).toHaveText('Saved');
  await expect(page.getByTestId('target-date')).toHaveValue('');

  // NULL, not the empty string: the board sorts nulls last and `''` is not null.
  expect((await row('Date target'))?.target_publish_date).toBeNull();

  await page.reload();
  await expect(page.getByTestId('target-date')).toHaveValue('');

  await openBoard(page);
  await expect(
    cardIn(page, IDEA, 'Date target').getByTestId('target-date'),
  ).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* Archive                                                                     */
/* -------------------------------------------------------------------------- */

test('archiving takes the card off the board without deleting it, and restoring brings it back', async ({
  page,
}) => {
  await signIn(page);
  await openBoard(page);
  await expect(cardIn(page, SCRIPTING, 'Archive me')).toBeVisible();

  await openVideo(page, 'Archive me');
  await expect(page.getByTestId('archived-banner')).toHaveCount(0);

  await page.getByTestId('archive-toggle').click();
  await expect(page.getByTestId('archive-toggle')).toHaveAttribute(
    'data-archived',
    'true',
  );
  await expect(page.getByTestId('archived-banner')).toBeVisible();

  // The row is still there, with its stage untouched. "The card is gone" would
  // be just as true of a delete, which is the thing this must not be.
  const archived = await row('Archive me');
  expect(archived).not.toBeNull();
  expect(archived?.archived_at).not.toBeNull();
  expect(archived?.stage_kind).toBe('scripting');

  await openBoard(page);
  await expect(cardIn(page, SCRIPTING, 'Archive me')).toHaveCount(0);
  await expect(
    page.getByTestId('board-card').filter({ hasText: 'Archive me' }),
  ).toHaveCount(0);

  /*
    The door M7's review found: archived videos do not count toward the
    occupancy refusal, so the column can be switched off while this one is
    archived — and a restore would then put a live video where the board and
    /now cannot show it. `set_video_archived` refuses, with the stage's name,
    and `archived_at` is no longer a column a client can write around it.
  */
  const scripting = await db.query<{ id: string }>(
    `select s.id from public.stages s join public.videos v on v.stage_id = s.id where v.id = $1`,
    [videos.get('Archive me')],
  );
  await asUser(() =>
    db.query('select set_stage_enabled($1::uuid, false)', [scripting.rows[0].id]),
  );
  await openVideo(page, 'Archive me');
  await page.getByTestId('archive-toggle').click();
  await expect(page.getByTestId('archive-status')).toHaveAttribute('data-state', 'error');
  await expect(page.getByTestId('archive-status')).toContainText(
    `${SCRIPTING} is switched off, so restoring this video would hide it from the board and from /now.`,
  );
  await expect(page.getByTestId('archive-toggle')).toHaveAttribute('data-archived', 'true');
  expect((await row('Archive me'))?.archived_at).not.toBeNull();

  const forged = await page.evaluate(
    async ({ gateway, anon, email, password, videoId }) => {
      const session = await fetch(`${gateway}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: anon, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const { access_token: token } = (await session.json()) as { access_token?: string };
      const response = await fetch(`${gateway}/rest/v1/videos?id=eq.${videoId}`, {
        method: 'PATCH',
        headers: {
          apikey: anon,
          Authorization: `Bearer ${token ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ archived_at: null }),
      });
      return { status: response.status, body: await response.text() };
    },
    {
      gateway: GATEWAY_URL,
      anon: ANON_KEY,
      email: SEED_EMAIL,
      password: SEED_PASSWORD,
      videoId: videos.get('Archive me'),
    },
  );
  expect(forged.status).toBe(403);
  expect(forged.body).toContain('42501');
  expect((await row('Archive me'))?.archived_at).not.toBeNull();

  await asUser(() =>
    db.query('select set_stage_enabled($1::uuid, true)', [scripting.rows[0].id]),
  );

  // Restore. It goes back to the column it was in, because archiving never
  // moved it — there is no "Archived" stage to come back from.
  await openVideo(page, 'Archive me');
  await page.getByTestId('archive-toggle').click();
  await expect(page.getByTestId('archive-toggle')).toHaveAttribute(
    'data-archived',
    'false',
  );
  await expect(page.getByTestId('archived-banner')).toHaveCount(0);

  expect((await row('Archive me'))?.archived_at).toBeNull();

  await openBoard(page);
  await expect(cardIn(page, SCRIPTING, 'Archive me')).toBeVisible();
});

/* -------------------------------------------------------------------------- */
/* The stage select and the gate                                               */
/* -------------------------------------------------------------------------- */

test('the stage select refuses a gated move in the board’s own words', async ({
  page,
}) => {
  await signIn(page);

  // First, the refusal the board produces, so the wording under test is the
  // board's rather than one this file invented.
  await openBoard(page);
  await dragCardTo(page, cardIn(page, PACKAGING, 'Gate blocked'), SCRIPTING);

  const toast = page.getByTestId('toast');
  await expect(toast).toBeVisible();
  const toastText = (await toast.innerText()).replace(/\s+/g, ' ');

  // The stage is named by the channel's label for it (the seed's here), the
  // field by the gate's wording.
  const gateSentence = new RegExp(`${PACKAGING.replace(/[()]/g, '\\$&')} still needs [^.]+\\.`).exec(
    toastText,
  )?.[0];
  expect(
    gateSentence,
    'the board toast must name the missing packaging field',
  ).toBeTruthy();
  // It is the written concept that is missing, not the uploaded sketch — the
  // refusal has to be actionable on a card that may well carry a sketch.
  expect(gateSentence).toMatch(/thumbnail concept/i);

  // Now the same move from the detail page's select.
  await openVideo(page, 'Gate blocked');
  const select = page.getByTestId('stage-select');
  await expect(select).toHaveValue(
    await optionValue(page, PACKAGING),
    { timeout: 20_000 },
  );

  await select.selectOption({ label: SCRIPTING });

  const status = page.getByTestId('stage-select-status');
  await expect(status).toHaveAttribute('data-state', 'error');
  // Character for character the board's sentence. Not a paraphrase, and not
  // `P0001: gate:thumbnail_concept`.
  await expect(status).toContainText(gateSentence!);
  await expect(status).toContainText(`It is still in ${PACKAGING}.`);

  // The select snaps back, the way the card does.
  await expect(select).toHaveValue(await optionValue(page, PACKAGING));

  // And the database never moved it.
  expect((await row('Gate blocked'))?.stage_kind).toBe('packaging');
  await page.reload();
  await expect(page.getByTestId('stage-select')).toHaveValue(
    await optionValue(page, PACKAGING),
  );

  // The same select moves a video the gate is happy with, so the test above is
  // not passing because the control is broken.
  await openVideo(page, 'Archive me');
  await page
    .getByTestId('stage-select')
    .selectOption({ label: stageName('filming') });
  await expect(page.getByTestId('stage-select-status')).toContainText(
    `Moved to ${stageName('filming')}.`,
  );
  expect((await row('Archive me'))?.stage_kind).toBe('filming');
});

/** The `<option>` value for a stage name on the open detail page. */
async function optionValue(page: Page, name: string): Promise<string> {
  const value = await page
    .getByTestId('stage-select')
    .locator('option')
    .filter({ hasText: name })
    .first()
    .getAttribute('value');
  if (!value) throw new Error(`no stage option named ${name}`);
  return value;
}

/* -------------------------------------------------------------------------- */
/* waiting_on                                                                  */
/* -------------------------------------------------------------------------- */

test('waiting_on is stored with its age, shows on the card, and clears', async ({
  page,
}) => {
  await signIn(page);
  await openVideo(page, 'Waiting test');

  const field = page.getByTestId('waiting-on');
  const status = page.getByTestId('waiting-on-status');

  await expect(field).toHaveValue('');
  await expect(status).toHaveText('Nothing is blocking this one.');

  await field.fill('the editor');
  await field.blur();
  await expect(status).toHaveText('Saved');

  // Stored with the stamp the CHECK insists on — the age `/now` will show in
  // M3 is a column, not a guess.
  const blocked = await row('Waiting test');
  expect(blocked?.waiting_on).toBe('the editor');
  expect(blocked?.waiting_since).not.toBeNull();

  await page.reload();
  await expect(page.getByTestId('waiting-on')).toHaveValue('the editor');
  await expect(page.getByTestId('waiting-on-status')).toHaveText(
    'Blocked for less than an hour.',
  );

  // The board shows the chip PLAN.md asks a card to carry.
  await openBoard(page);
  await expect(cardIn(page, IDEA, 'Waiting test')).toContainText(
    'Waiting: the editor',
  );

  // Re-wording the block does not restart the clock: it is the same block.
  await openVideo(page, 'Waiting test');
  const since = blocked?.waiting_since;
  await page.getByTestId('waiting-on').fill('the editor’s second pass');
  await page.getByTestId('waiting-on').blur();
  await expect(page.getByTestId('waiting-on-status')).toHaveText('Saved');

  const reworded = await row('Waiting test');
  expect(reworded?.waiting_on).toBe('the editor’s second pass');
  expect(reworded?.waiting_since).toEqual(since);

  // Unblocked: both columns back to NULL together.
  await page.getByTestId('waiting-on-clear').click();
  await expect(page.getByTestId('waiting-on-status')).toHaveText('Saved');
  await expect(page.getByTestId('waiting-on')).toHaveValue('');

  const cleared = await row('Waiting test');
  expect(cleared?.waiting_on).toBeNull();
  expect(cleared?.waiting_since).toBeNull();

  await page.reload();
  await expect(page.getByTestId('waiting-on')).toHaveValue('');
  await expect(page.getByTestId('waiting-on-status')).toHaveText(
    'Nothing is blocking this one.',
  );
});

/* -------------------------------------------------------------------------- */
/* URL and notes                                                               */
/* -------------------------------------------------------------------------- */

test('the URL is validated, does not claim to be live, and notes save as typed', async ({
  page,
}) => {
  await signIn(page);
  await openVideo(page, 'Date target');

  const url = page.getByTestId('youtube-url');
  const urlStatus = page.getByTestId('youtube-url-status');

  // Not a link. Refused with a sentence, and — the part that matters — what was
  // typed is still in the box afterwards.
  await url.fill('tomorrow probably');
  await url.blur();
  await expect(urlStatus).toHaveAttribute('data-state', 'error');
  await expect(urlStatus).toContainText('not a link');
  await expect(url).toHaveValue('tomorrow probably');
  expect((await row('Date target'))?.youtube_url).toBeNull();

  // A real one saves.
  await url.fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await url.blur();
  await expect(urlStatus).toHaveText('Saved');
  expect((await row('Date target'))?.youtube_url).toBe(
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  );

  // This video has never reached a Published stage, so the page must not
  // present the link as somewhere to go.
  await expect(page.getByTestId('youtube-not-live')).toBeVisible();
  await expect(page.getByTestId('youtube-live')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Watch on YouTube' }),
  ).toHaveCount(0);

  // Notes: a textarea, kept exactly as typed, newlines and markdown included.
  const notes = 'B-roll:\n- desk from above\n\n**Sponsor read** at 4:20';
  await page.getByTestId('notes').fill(notes);
  await page.getByTestId('notes').blur();
  await expect(page.getByTestId('notes-status')).toHaveText('Saved');
  expect((await row('Date target'))?.notes).toBe(notes);

  await page.reload();
  await expect(page.getByTestId('notes')).toHaveValue(notes);

  // And the other side of that branch, so the caution above is a decision the
  // page makes rather than the only thing it can say: on a video that really
  // is published, the same URL becomes a link, with the date it went out.
  await openVideo(page, 'Already out');
  await page
    .getByTestId('youtube-url')
    .fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await page.getByTestId('youtube-url').blur();
  await expect(page.getByTestId('youtube-url-status')).toHaveText('Saved');

  await expect(page.getByTestId('youtube-not-live')).toHaveCount(0);
  const live = page.getByTestId('youtube-live');
  await expect(live).toBeVisible();
  await expect(live).toContainText('published');
  await expect(
    live.getByRole('link', { name: 'Watch on YouTube' }),
  ).toHaveAttribute('href', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});
