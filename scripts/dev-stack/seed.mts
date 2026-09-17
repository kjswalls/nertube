/**
 * The demo data the stack comes up with.
 *
 * Two rules it follows, both deliberate:
 *
 * 1. **The content comes from `lib/defaults.ts`.** Not a copy of it — the file
 *    itself. The nine stages, the seven checklist templates and the eight
 *    format buckets that appear in the dev database are the same rows a real
 *    `createChannel` would write, so a change to the product's seed content
 *    shows up here without anyone remembering to mirror it.
 *
 * 2. **It writes through the SQL functions, as the user.** `create_channel` and
 *    `capture_video` are called over a connection that has `SET ROLE
 *    authenticated` and `request.jwt.claims` set, so RLS and the column grants
 *    apply exactly as they do to the running app. A seed that used a superuser
 *    connection and plain INSERTs would happily produce a database the app
 *    itself could never have created — for instance a video already sitting
 *    past the packaging gate, which `capture_video` makes impossible.
 *
 * Videos stay minimal on purpose: M1 owns cards, so a couple of captured ideas
 * per channel is enough to prove the board renders and no more.
 */

import {
  CHANNEL_DEFAULTS,
  SCRIPT_TEMPLATE,
  SEED_BUCKETS,
  SEED_CHECKLISTS,
  SEED_STAGES,
} from '../../lib/defaults.js';
import { slugify } from '../../lib/slug.js';

import { SEED_CHANNELS, SEED_EMAIL, SEED_PASSWORD } from './config.mjs';
import { asAuthenticatedUser, query, queryOne } from './db.mjs';

export interface SeedResult {
  userId: string;
  email: string;
  password: string;
  channels: { name: string; slug: string; id: string; videos: number }[];
}

/** A couple of ideas per channel. Enough to see; not a fixture. */
const SEED_IDEAS: Record<string, readonly string[]> = {
  Personal: [
    'Desk tour, but only what earns its place',
    'How long a video actually takes me',
  ],
  'Sunday Softworks': [
    'Shipping a tiny tool in one Sunday',
    'The build log nobody asked for',
  ],
};

export async function seed(): Promise<SeedResult> {
  const userId = await createUser(SEED_EMAIL, SEED_PASSWORD);

  const channels: SeedResult['channels'] = [];
  for (const name of SEED_CHANNELS) {
    const slug = slugify(name);
    const channel = await createChannel(userId, SEED_EMAIL, name, slug);
    const videos = await captureIdeas(
      userId,
      SEED_EMAIL,
      channel.id,
      SEED_IDEAS[name] ?? [],
    );
    channels.push({ name, slug, id: channel.id, videos });
  }

  return { userId, email: SEED_EMAIL, password: SEED_PASSWORD, channels };
}

/**
 * The one account. `crypt(…, gen_salt('bf'))` is bcrypt — the same algorithm
 * GoTrue uses — so even the throwaway password is never stored in the clear.
 */
async function createUser(email: string, password: string): Promise<string> {
  const existing = await queryOne<{ id: string }>(
    'select id from auth.users where lower(email) = lower($1)',
    [email],
  );

  if (existing) {
    await query(
      `update auth.users
          set encrypted_password = crypt($2, gen_salt('bf')),
              email_confirmed_at = coalesce(email_confirmed_at, now()),
              updated_at = now()
        where id = $1`,
      [existing.id, password],
    );
    return existing.id;
  }

  const row = await queryOne<{ id: string }>(
    `insert into auth.users (email, encrypted_password, email_confirmed_at, aud, role)
     values (lower($1), crypt($2, gen_salt('bf')), now(), 'authenticated', 'authenticated')
     returning id`,
    [email, password],
  );

  if (!row) throw new Error(`could not create the seed user ${email}`);
  return row.id;
}

/**
 * The same call `app/actions/channels.ts` makes, with the same payload built
 * from the same file: one transaction that writes the channel, its nine stages,
 * a checklist template per stage and the format buckets.
 */
async function createChannel(
  userId: string,
  email: string,
  name: string,
  slug: string,
): Promise<{ id: string; slug: string }> {
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

  const buckets = SEED_BUCKETS.map((bucket) => ({
    axis: bucket.axis,
    name: bucket.name,
    position: bucket.position,
    monthly_quota: null,
  }));

  return asAuthenticatedUser(userId, email, async (client) => {
    const result = await client.query<{ id: string; slug: string }>(
      `select id, slug from create_channel(
         $1::text, $2::text, $3::text, $4::int, $5::int, $6::numeric, $7::text,
         $8::jsonb, $9::jsonb
       )`,
      [
        name,
        slug,
        SCRIPT_TEMPLATE,
        CHANNEL_DEFAULTS.wip_threshold,
        CHANNEL_DEFAULTS.stale_days,
        CHANNEL_DEFAULTS.expected_ctr,
        CHANNEL_DEFAULTS.voice_guide,
        JSON.stringify(stages),
        JSON.stringify(buckets),
      ],
    );
    return result.rows[0];
  });
}

/**
 * `capture_video` is the only way a client creates a video, and it always lands
 * the row in the channel's Idea stage. Using it here rather than an INSERT is
 * the point: `INSERT` on `videos` is revoked from `authenticated`, so a seed
 * that tried to insert would fail — which is exactly the guarantee the app
 * relies on.
 */
async function captureIdeas(
  userId: string,
  email: string,
  channelId: string,
  titles: readonly string[],
): Promise<number> {
  if (titles.length === 0) return 0;

  return asAuthenticatedUser(userId, email, async (client) => {
    let captured = 0;
    for (const title of titles) {
      await client.query('select id from capture_video($1::uuid, $2::text)', [
        channelId,
        title,
      ]);
      captured += 1;
    }
    return captured;
  });
}
