/**
 * `/auth/v1/*` — the slice of GoTrue this app uses.
 *
 * Four endpoints, because four is all `@supabase/ssr` touches for a
 * single-user, email-and-password app with no sign-up screen:
 *
 *   POST /auth/v1/token?grant_type=password        signIn
 *   POST /auth/v1/token?grant_type=refresh_token   the refresh proxy.ts relies on
 *   GET  /auth/v1/user                             every getUser() guard
 *   POST /auth/v1/logout                           signOut
 *
 * The response bodies are GoTrue's, not an approximation of them: `auth-js`
 * parses the *shape*, so getting it wrong turns a wrong password into an
 * unhandled exception rather than the message under the password field.
 * Specifically, `_getErrorMessage` reads `msg`, then `message`, then
 * `error_description`, then `error`; and the error code is read from `code`
 * when the response carries an `X-Supabase-Api-Version` of 2024-01-01 or later.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type pg from 'pg';

import { ACCESS_TOKEN_TTL_SECONDS, GATEWAY_URL } from './config.mjs';
import { inTransaction, query, queryOne } from './db.mjs';
import {
  asRecord,
  BadRequest,
  readJson,
  sendJson,
  sendNoContent,
  stringField,
} from './http.mjs';
import { bearerToken, JwtError, nowSeconds, signJwt, verifyJwt } from './jwt.js';

/** GoTrue stamps this on every response; auth-js reads it to pick `code`. */
const API_VERSION_HEADER = { 'X-Supabase-Api-Version': '2024-01-01' };

interface UserRow {
  id: string;
  email: string | null;
  aud: string;
  role: string;
  email_confirmed_at: Date | null;
  last_sign_in_at: Date | null;
  raw_app_meta_data: Record<string, unknown>;
  raw_user_meta_data: Record<string, unknown>;
  is_anonymous: boolean;
  created_at: Date;
  updated_at: Date;
}

/** The GoTrue user object, as `auth-js` expects to receive it. */
function userObject(row: UserRow): Record<string, unknown> {
  const iso = (value: Date | null) => (value ? value.toISOString() : null);
  return {
    id: row.id,
    aud: row.aud,
    role: row.role,
    email: row.email ?? '',
    email_confirmed_at: iso(row.email_confirmed_at),
    confirmed_at: iso(row.email_confirmed_at),
    phone: '',
    last_sign_in_at: iso(row.last_sign_in_at),
    app_metadata: row.raw_app_meta_data,
    user_metadata: row.raw_user_meta_data,
    identities: [
      {
        identity_id: row.id,
        id: row.id,
        user_id: row.id,
        identity_data: {
          email: row.email ?? '',
          email_verified: row.email_confirmed_at !== null,
          phone_verified: false,
          sub: row.id,
        },
        provider: 'email',
        last_sign_in_at: iso(row.last_sign_in_at),
        created_at: row.created_at.toISOString(),
        updated_at: row.updated_at.toISOString(),
        email: row.email ?? '',
      },
    ],
    is_anonymous: row.is_anonymous,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

const USER_COLUMNS = `
  id, email, aud, role, email_confirmed_at, last_sign_in_at,
  raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at
`;

async function loadUser(userId: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    `select ${USER_COLUMNS} from auth.users where id = $1`,
    [userId],
  );
}

/**
 * An error in the shape auth-js parses. Every field GoTrue sends is sent, so
 * whichever one a given client version reads, it reads something useful.
 */
function sendAuthError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(
    res,
    status,
    {
      code: status,
      error_code: code,
      msg: message,
      // The pre-2024 spelling, still read by older clients and by anything
      // that treats this endpoint as plain OAuth2.
      error: code,
      error_description: message,
      message,
    },
    API_VERSION_HEADER,
  );
}

interface Session {
  access_token: string;
  token_type: 'bearer';
  expires_in: number;
  expires_at: number;
  refresh_token: string;
  user: Record<string, unknown>;
}

/**
 * Mint an access token + refresh token pair and record the refresh token.
 *
 * The claims are exactly the ones PostgREST and the RLS policies need: `role`
 * picks the database role, `sub` is what `auth.uid()` returns, `email` is what
 * `auth.email()` returns. The rest are there because the real thing sends them
 * and something downstream may read them.
 */
async function issueSession(
  row: UserRow,
  sessionId: string = randomUUID(),
  /** Reuse an existing refresh token instead of minting one (see below). */
  existingRefreshToken?: string,
): Promise<Session> {
  const issuedAt = nowSeconds();
  const expiresAt = issuedAt + ACCESS_TOKEN_TTL_SECONDS;

  const accessToken = signJwt({
    iss: `${GATEWAY_URL}/auth/v1`,
    sub: row.id,
    aud: row.aud,
    role: row.role,
    email: row.email ?? '',
    phone: '',
    app_metadata: row.raw_app_meta_data,
    user_metadata: row.raw_user_meta_data,
    session_id: sessionId,
    is_anonymous: row.is_anonymous,
    iat: issuedAt,
    exp: expiresAt,
  });

  let refreshToken = existingRefreshToken;
  if (refreshToken === undefined) {
    refreshToken = randomBytes(24).toString('base64url');
    await query(
      `insert into auth.refresh_tokens (token, user_id, session_id) values ($1, $2, $3)`,
      [refreshToken, row.id, sessionId],
    );
  }

  await query(`update auth.users set last_sign_in_at = now() where id = $1`, [
    row.id,
  ]);
  const refreshed = (await loadUser(row.id)) ?? row;

  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    expires_at: expiresAt,
    refresh_token: refreshToken,
    user: userObject(refreshed),
  };
}

/**
 * GoTrue's `SECURITY_REFRESH_TOKEN_REUSE_INTERVAL`, in milliseconds.
 *
 * A server-rendered page builds several Supabase clients per request — the
 * proxy, the page, the header — and when the access token is close to expiry
 * they all reach for the same refresh token at once. Real GoTrue answers a
 * token that was rotated within this window with the session that replaced it,
 * rather than with an error. Without that, a page whose token expires
 * mid-render signs the user out, and `proxy.ts`'s refresh is unusable.
 */
const REFRESH_REUSE_INTERVAL_MS = 10_000;

/**
 * Follow `replaced_by` from a token that has just been rotated to the token
 * that is live now. Bounded, because a chain is only ever a handful long and a
 * cycle must not hang the request.
 */
async function currentTokenInChain(
  client: pg.PoolClient,
  token: string,
): Promise<string | null> {
  let current = token;
  for (let hop = 0; hop < 16; hop += 1) {
    const result = await client.query<{
      revoked: boolean;
      revoked_at: Date | null;
      replaced_by: string | null;
    }>(
      'select revoked, revoked_at, replaced_by from auth.refresh_tokens where token = $1',
      [current],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (!row.revoked) return current;
    if (
      row.replaced_by === null ||
      row.revoked_at === null ||
      Date.now() - row.revoked_at.getTime() > REFRESH_REUSE_INTERVAL_MS
    ) {
      return null;
    }
    current = row.replaced_by;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Routing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Handle a request whose path starts `/auth/v1`. `path` is what follows that
 * prefix, e.g. `/token` or `/user`.
 */
export async function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
): Promise<void> {
  const method = req.method ?? 'GET';

  if (path === '/token' && method === 'POST') {
    const grantType = url.searchParams.get('grant_type');
    if (grantType === 'password') return passwordGrant(req, res);
    if (grantType === 'refresh_token') return refreshGrant(req, res);
    return sendAuthError(
      res,
      400,
      'unsupported_grant_type',
      `This harness implements grant_type=password and grant_type=refresh_token, not ${String(grantType)}.`,
    );
  }

  if (path === '/user' && (method === 'GET' || method === 'HEAD')) {
    return currentUser(req, res);
  }

  if (path === '/logout' && method === 'POST') {
    return logout(req, res);
  }

  // HS256, so there are no public keys to publish — the real thing also answers
  // with an empty key set for a symmetric project. auth-js only asks when
  // `getClaims()` is used, which this app does not, but an empty 200 is a much
  // better answer than a 404 if it ever does.
  if (path === '/.well-known/jwks.json' && method === 'GET') {
    return sendJson(res, 200, { keys: [] }, API_VERSION_HEADER);
  }

  if (path === '/settings' && method === 'GET') {
    return sendJson(
      res,
      200,
      {
        external: { email: true },
        disable_signup: true,
        mailer_autoconfirm: true,
        external_labels: {},
      },
      API_VERSION_HEADER,
    );
  }

  if (path === '/health' && method === 'GET') {
    return sendJson(res, 200, { name: 'nertube-dev-stack-auth' }, API_VERSION_HEADER);
  }

  sendAuthError(
    res,
    404,
    'not_found',
    `${method} /auth/v1${path} is not implemented by the local dev stack. See scripts/dev-stack/README.md.`,
  );
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

async function passwordGrant(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = asRecord(await readJson(req));
  } catch (error) {
    return sendAuthError(
      res,
      400,
      'bad_json',
      error instanceof BadRequest ? error.message : 'Unreadable request body.',
    );
  }

  const email = stringField(body, 'email');
  const password = stringField(body, 'password');

  if (!email || !password) {
    return sendAuthError(
      res,
      400,
      'validation_failed',
      'An email address and a password are required.',
    );
  }

  // The comparison happens in SQL against the bcrypt hash; a miss and an
  // unknown address are the same answer, so neither can be probed for.
  const match = await queryOne<{ id: string }>(
    'select auth.dev_verify_password($1, $2) as id',
    [email, password],
  );

  if (!match?.id) {
    return sendAuthError(
      res,
      400,
      'invalid_credentials',
      'Invalid login credentials',
    );
  }

  const row = await loadUser(match.id);
  if (!row) {
    return sendAuthError(
      res,
      400,
      'invalid_credentials',
      'Invalid login credentials',
    );
  }

  if (!row.email_confirmed_at) {
    return sendAuthError(res, 400, 'email_not_confirmed', 'Email not confirmed');
  }

  sendJson(res, 200, await issueSession(row), API_VERSION_HEADER);
}

async function refreshGrant(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = asRecord(await readJson(req).catch(() => ({})));
  const token = stringField(body, 'refresh_token');

  if (!token) {
    return sendAuthError(
      res,
      400,
      'validation_failed',
      'A refresh_token is required.',
    );
  }

  /*
   * All of the token bookkeeping happens in one transaction, behind a
   * `SELECT … FOR UPDATE` on the presented token.
   *
   * Without the lock, two requests arriving together both read `revoked =
   * false`, both mint a successor, and the session forks: whichever response
   * the browser stored last wins and the other successor is orphaned. Real
   * GoTrue locks the row for exactly this reason, and a server-rendered page
   * makes concurrent refreshes the normal case rather than a rare one.
   */
  const outcome = await inTransaction(
    async (
      client,
    ): Promise<
      | { kind: 'unknown' }
      | { kind: 'ok'; userId: string; sessionId: string; refreshToken: string }
    > => {
      const found = await client.query<{
        user_id: string;
        session_id: string;
        revoked: boolean;
      }>(
        `select user_id, session_id, revoked
           from auth.refresh_tokens
          where token = $1
            for update`,
        [token],
      );

      const stored = found.rows[0];
      if (!stored) return { kind: 'unknown' };

      if (stored.revoked) {
        // Presented again after rotation: inside the reuse interval, hand back
        // the token that replaced it. Outside it, it is simply dead.
        const live = await currentTokenInChain(client, token);
        if (live === null) return { kind: 'unknown' };
        return {
          kind: 'ok',
          userId: stored.user_id,
          sessionId: stored.session_id,
          refreshToken: live,
        };
      }

      const successor = randomBytes(24).toString('base64url');
      await client.query(
        `insert into auth.refresh_tokens (token, user_id, session_id)
         values ($1, $2, $3)`,
        [successor, stored.user_id, stored.session_id],
      );
      await client.query(
        `update auth.refresh_tokens
            set revoked = true, revoked_at = now(), replaced_by = $2
          where token = $1`,
        [token, successor],
      );

      return {
        kind: 'ok',
        userId: stored.user_id,
        sessionId: stored.session_id,
        refreshToken: successor,
      };
    },
  );

  if (outcome.kind === 'unknown') {
    // GoTrue's own code and message for an unknown or long-dead refresh token.
    // `proxy.ts` depends on this being an ordinary error: it clears the auth
    // cookies rather than looping on a token that will never work.
    return sendAuthError(
      res,
      400,
      'refresh_token_not_found',
      'Invalid Refresh Token: Refresh Token Not Found',
    );
  }

  const row = await loadUser(outcome.userId);
  if (!row) {
    return sendAuthError(
      res,
      400,
      'refresh_token_not_found',
      'Invalid Refresh Token: Refresh Token Not Found',
    );
  }

  sendJson(
    res,
    200,
    await issueSession(row, outcome.sessionId, outcome.refreshToken),
    API_VERSION_HEADER,
  );
}

async function currentUser(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const token = bearerToken(req.headers.authorization);
  if (!token) {
    return sendAuthError(res, 401, 'no_authorization', 'This endpoint requires a Bearer token');
  }

  let sub: string;
  try {
    const claims = verifyJwt(token);
    if (typeof claims.sub !== 'string' || claims.sub === '') {
      // An api key (the anon key) is a valid signature with no subject. GoTrue
      // answers 401 for it, and `getUser()` must therefore report "no user"
      // rather than a crash — which is exactly what the signed-out redirect in
      // `proxy.ts` is built on.
      return sendAuthError(res, 401, 'bad_jwt', 'invalid claim: missing sub claim');
    }
    sub = claims.sub;
  } catch (error) {
    return sendAuthError(
      res,
      401,
      'bad_jwt',
      error instanceof JwtError ? error.message : 'invalid JWT',
    );
  }

  const row = await loadUser(sub);
  if (!row) {
    return sendAuthError(res, 403, 'user_not_found', 'User from sub claim in JWT does not exist');
  }

  sendJson(res, 200, userObject(row), API_VERSION_HEADER);
}

async function logout(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const token = bearerToken(req.headers.authorization);
  if (token) {
    try {
      const claims = verifyJwt(token);
      if (typeof claims.session_id === 'string') {
        // `replaced_by` deliberately left null: a signed-out session has no
        // successor, so the reuse interval cannot resurrect it.
        await query(
          `update auth.refresh_tokens
              set revoked = true, revoked_at = now()
            where session_id = $1`,
          [claims.session_id],
        );
      }
    } catch {
      // Signing out with a token that is already dead is a success, not an
      // error: the caller wanted the session gone and it is gone.
    }
  }
  // Drain any body so the socket can be reused.
  await readJson(req).catch(() => ({}));
  sendNoContent(res);
}
