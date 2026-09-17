/**
 * `npm run dev:stack:smoke` — drive a running stack with the app's own
 * `@supabase/supabase-js`, and say plainly what works.
 *
 * This is not the acceptance test. The acceptance test is `npm run e2e`, which
 * drives the real app in a real browser; what this adds is coverage of the
 * storage surface, which M0's UI does not touch yet, and a fast answer when the
 * question is "is the harness broken, or is the app?".
 *
 * Start the stack first, in another terminal:
 *
 *   npm run dev:stack
 *   npm run dev:stack:smoke
 *
 * It reads the same env as the stack, so a stack started on other ports is
 * smoke-tested with the same overrides (`DEV_STACK_PORT=54331 npm run
 * dev:stack:smoke`).
 */

import { createClient } from '@supabase/supabase-js';

import {
  API_KEY_EXP,
  API_KEY_IAT,
  GATEWAY_URL,
  SEED_EMAIL,
  SEED_PASSWORD,
  THUMBNAILS_BUCKET,
} from './config.mjs';
import { apiKey, nowSeconds, signJwt } from './jwt.js';

const ANON_KEY = apiKey('anon', API_KEY_IAT, API_KEY_EXP);
const SERVICE_ROLE_KEY = apiKey('service_role', API_KEY_IAT, API_KEY_EXP);

let failures = 0;

/**
 * The refresh grant, hit directly. supabase-js keeps one session per client, so
 * it cannot present the same refresh token twice — which is exactly the case
 * worth checking.
 */
async function rawRefresh(
  refreshToken: string,
): Promise<{ ok: boolean; status: number; refreshToken: string | null }> {
  const response = await fetch(`${GATEWAY_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const body = (await response.json()) as { refresh_token?: string };
  return {
    ok: response.ok,
    status: response.status,
    refreshToken: body.refresh_token ?? null,
  };
}

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  console.log(`Smoke-testing ${GATEWAY_URL} with @supabase/supabase-js\n`);

  const anon = createClient(GATEWAY_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  /* ---- RLS, before signing in ------------------------------------------ */

  const signedOut = await anon.from('channels').select('id, slug');
  check(
    'anon sees no channels (RLS bites)',
    signedOut.error === null && (signedOut.data?.length ?? -1) === 0,
    signedOut.error?.message ?? `${signedOut.data?.length ?? 0} rows`,
  );

  const anonUser = await anon.auth.getUser();
  check(
    'anon getUser() reports no user rather than throwing',
    anonUser.data.user === null,
  );

  /* ---- Wrong password --------------------------------------------------- */

  const wrong = await anon.auth.signInWithPassword({
    email: SEED_EMAIL,
    password: 'definitely-not-the-password',
  });
  check(
    'a wrong password is an ordinary auth error',
    wrong.error !== null && wrong.error.status === 400,
    wrong.error ? `${wrong.error.message} (code ${String(wrong.error.code)})` : 'no error',
  );

  /* ---- Signing in ------------------------------------------------------- */

  const client = createClient(GATEWAY_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const signIn = await client.auth.signInWithPassword({
    email: SEED_EMAIL,
    password: SEED_PASSWORD,
  });
  check(
    'signInWithPassword returns a session and a user',
    signIn.error === null && !!signIn.data.session && !!signIn.data.user,
    signIn.error?.message ?? '',
  );

  const session = signIn.data.session;
  if (!session) {
    console.log('\nCannot continue without a session.');
    process.exit(1);
  }

  const userId = session.user.id;

  const verified = await client.auth.getUser();
  check(
    'getUser() verifies the access token against /auth/v1/user',
    verified.data.user?.id === userId,
    verified.error?.message ?? '',
  );

  /* ---- Reading through PostgREST as `authenticated` --------------------- */

  const channels = await client
    .from('channels')
    .select('id, name, slug')
    .order('created_at', { ascending: true });
  check(
    'the signed-in user sees exactly their two seeded channels',
    channels.error === null && channels.data?.length === 2,
    channels.error?.message ?? (channels.data ?? []).map((c) => c.slug).join(', '),
  );

  const first = channels.data?.[0];
  if (first) {
    const stages = await client
      .from('stages')
      .select('name, position')
      .eq('channel_id', first.id)
      .order('position');
    check(
      'nine stages on the first channel',
      stages.data?.length === 9,
      stages.error?.message ?? (stages.data ?? []).map((s) => s.name).join(' | '),
    );

    const templates = await client
      .from('checklist_templates')
      .select('id', { count: 'exact', head: true });
    check(
      'checklist templates were seeded',
      (templates.count ?? 0) > 0,
      templates.error?.message ?? `${String(templates.count)} rows`,
    );
  }

  /* ---- RPC -------------------------------------------------------------- */

  if (first) {
    const captured = await client.rpc('capture_video', {
      p_channel: first.id,
      p_title: 'Smoke-test idea',
    });
    check(
      'rpc(capture_video) works — every write in this app is an RPC',
      captured.error === null && typeof captured.data === 'object',
      captured.error?.message ?? '',
    );

    const created = captured.data as { id?: string } | null;
    if (created?.id) {
      await client.from('videos').delete().eq('id', created.id);
    }
  }

  const forbidden = await client.from('videos').insert({
    channel_id: first?.id ?? '',
    stage_id: '00000000-0000-4000-8000-000000000000',
    title: 'straight insert',
  } as never);
  check(
    'a direct INSERT on videos is refused (the grant is revoked)',
    forbidden.error !== null,
    forbidden.error?.message ?? 'it succeeded, which is a bug',
  );

  /* ---- Storage ---------------------------------------------------------- */

  const bytes = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {
    type: 'image/png',
  });
  const mine = `${userId}/smoke/thumb.png`;
  const theirs = `00000000-0000-4000-8000-0000000000ff/smoke/thumb.png`;

  const upload = await client.storage.from(THUMBNAILS_BUCKET).upload(mine, bytes);
  check('upload to uid/… succeeds', upload.error === null, upload.error?.message ?? '');

  const clash = await client.storage.from(THUMBNAILS_BUCKET).upload(mine, bytes);
  check(
    'uploading over an existing object without upsert is a 409',
    clash.error !== null,
    clash.error?.message ?? 'it overwrote silently',
  );

  const upsert = await client.storage
    .from(THUMBNAILS_BUCKET)
    .upload(mine, bytes, { upsert: true });
  check('upsert overwrites', upsert.error === null, upsert.error?.message ?? '');

  const denied = await client.storage.from(THUMBNAILS_BUCKET).upload(theirs, bytes);
  check(
    "uploading under someone else's user id is refused by the storage policy",
    denied.error !== null,
    denied.error?.message ?? 'it was allowed, which is a bug',
  );

  const downloaded = await client.storage.from(THUMBNAILS_BUCKET).download(mine);
  check(
    'download returns the bytes',
    downloaded.error === null && (await downloaded.data?.arrayBuffer())?.byteLength === 8,
    downloaded.error?.message ?? '',
  );

  const signed = await client.storage
    .from(THUMBNAILS_BUCKET)
    .createSignedUrls([mine], 60);
  const signedUrl = signed.data?.[0]?.signedUrl ?? null;
  check(
    'createSignedUrls returns a URL',
    signed.error === null && typeof signedUrl === 'string',
    signed.error?.message ?? String(signedUrl),
  );

  if (signedUrl) {
    const response = await fetch(signedUrl);
    check(
      'the signed URL serves the object with no Authorization header',
      response.ok && (await response.arrayBuffer()).byteLength === 8,
      `HTTP ${response.status}`,
    );
  }

  /* ---- list(): one level, folders collapsed ----------------------------- */

  // The shape M4 will actually use: {user_id}/{video_id}/{file}.
  const listed = [`${userId}/v1/concept.png`, `${userId}/v1/safe.png`, `${userId}/v2/safe.png`];
  for (const name of listed) {
    await client.storage.from(THUMBNAILS_BUCKET).upload(name, bytes, { upsert: true });
  }

  const atUser = await client.storage.from(THUMBNAILS_BUCKET).list(userId);
  const atUserNames = (atUser.data ?? []).map((entry) => entry.name);
  check(
    'list(uid) returns one row per folder, not recursive paths',
    atUser.error === null &&
      atUserNames.includes('v1') &&
      atUserNames.includes('v2') &&
      !atUserNames.some((name) => name.startsWith('/') || name.includes('/')),
    atUser.error?.message ?? atUserNames.join(', '),
  );
  check(
    'a folder row carries a null id and null metadata, as the real API does',
    (atUser.data ?? [])
      .filter((entry) => entry.name === 'v1' || entry.name === 'v2')
      .every((entry) => entry.id === null && entry.metadata === null),
    (atUser.data ?? []).map((entry) => `${entry.name}:${String(entry.id)}`).join(', '),
  );

  const atFolder = await client.storage.from(THUMBNAILS_BUCKET).list(`${userId}/v1`);
  const atFolderNames = (atFolder.data ?? []).map((entry) => entry.name);
  check(
    'list(uid/v1) returns the two objects by bare name, with ids',
    atFolder.error === null &&
      atFolderNames.length === 2 &&
      atFolderNames.includes('concept.png') &&
      atFolderNames.includes('safe.png') &&
      (atFolder.data ?? []).every((entry) => entry.id !== null),
    atFolder.error?.message ?? atFolderNames.join(', '),
  );

  const atRoot = await client.storage.from(THUMBNAILS_BUCKET).list();
  const atRootNames = (atRoot.data ?? []).map((entry) => entry.name);
  check(
    'list() at the bucket root collapses to the one user folder',
    atRoot.error === null && atRootNames.length === 1 && atRootNames[0] === userId,
    atRoot.error?.message ?? atRootNames.join(', '),
  );

  await client.storage.from(THUMBNAILS_BUCKET).remove(listed);

  /* ---- An expired session is 401, not 403 ------------------------------- */

  // The distinction the app has to act on: "your session expired, refresh and
  // retry" is not "you tried to write into someone else's folder".
  const expiredToken = signJwt({
    sub: userId,
    role: 'authenticated',
    aud: 'authenticated',
    email: SEED_EMAIL,
    iat: nowSeconds() - 7200,
    exp: nowSeconds() - 3600,
  });
  const expiredUpload = await fetch(
    `${GATEWAY_URL}/storage/v1/object/${THUMBNAILS_BUCKET}/${userId}/smoke/expired.png`,
    {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${expiredToken}`,
        'Content-Type': 'image/png',
      },
      body: new Uint8Array([137, 80, 78, 71]),
    },
  );
  check(
    'storage answers an expired token 401 (a rejected token, not a rejected path)',
    expiredUpload.status === 401,
    `HTTP ${expiredUpload.status}`,
  );

  /* ---- The gateway behaves like Kong ------------------------------------ */

  const keyless = await fetch(`${GATEWAY_URL}/rest/v1/channels?select=id`);
  check(
    'a request with no apikey is refused, as Kong refuses it',
    keyless.status === 401,
    `HTTP ${keyless.status}`,
  );

  const keyOnly = await fetch(`${GATEWAY_URL}/rest/v1/channels?select=slug`, {
    headers: { apikey: SERVICE_ROLE_KEY },
  });
  const keyOnlyRows = (await keyOnly.json()) as unknown[];
  check(
    'a bare service_role apikey is NOT promoted to an RLS-bypassing session',
    keyOnly.status === 200 && Array.isArray(keyOnlyRows) && keyOnlyRows.length === 0,
    `HTTP ${keyOnly.status}, ${JSON.stringify(keyOnlyRows).slice(0, 120)}`,
  );

  const pretendingToBeSuperuser = signJwt({
    role: 'postgres',
    sub: userId,
    iat: nowSeconds(),
    exp: nowSeconds() + 60,
  });
  const superuserAttempt = await fetch(`${GATEWAY_URL}/rest/v1/channels?select=id`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${pretendingToBeSuperuser}` },
  });
  check(
    'a token claiming role "postgres" is refused (PostgREST runs as `authenticator`)',
    superuserAttempt.status === 403,
    `HTTP ${superuserAttempt.status}`,
  );

  const removed = await client.storage.from(THUMBNAILS_BUCKET).remove([mine]);
  check(
    'remove deletes the object',
    removed.error === null && (removed.data?.length ?? 0) === 1,
    removed.error?.message ?? '',
  );

  /* ---- Refresh and sign out --------------------------------------------- */

  const refreshed = await client.auth.refreshSession(session);
  check(
    'refresh_token grant issues a fresh pair',
    refreshed.error === null &&
      !!refreshed.data.session &&
      refreshed.data.session.refresh_token !== session.refresh_token,
    refreshed.error?.message ?? '',
  );

  // GoTrue's reuse interval, and the reason it exists: a server-rendered page
  // builds several Supabase clients per request, and when the access token is
  // near expiry they all present the same refresh token at once. Presenting it
  // twice must not sign the user out.
  const rotated = refreshed.data.session;
  if (rotated) {
    const [a, b] = await Promise.all([
      rawRefresh(rotated.refresh_token),
      rawRefresh(rotated.refresh_token),
    ]);
    check(
      'the same refresh token presented twice at once yields two working sessions',
      a.ok && b.ok,
      `first ${a.status}, second ${b.status}`,
    );
    check(
      'both point at the same live refresh token (no fork)',
      a.ok && b.ok && a.refreshToken === b.refreshToken,
      `${String(a.refreshToken)} vs ${String(b.refreshToken)}`,
    );
  }

  const signOut = await client.auth.signOut();
  check('signOut succeeds', signOut.error === null, signOut.error?.message ?? '');

  console.log('');
  if (failures > 0) {
    console.log(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
