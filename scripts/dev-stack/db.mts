/**
 * The harness's own database access.
 *
 * Only the two things PostgREST cannot do sit here: signing people in (reading
 * `auth.users`) and the storage object API. Everything the *app* does still
 * goes through PostgREST, over HTTP, as the `anon` or `authenticated` role,
 * with RLS on — which is the whole point of the exercise.
 */

import pg from 'pg';

import { PG } from './config.mjs';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  pool ??= new pg.Pool({
    host: PG.host,
    port: PG.port,
    user: PG.user,
    password: PG.password === '' ? undefined : PG.password,
    database: PG.database,
    max: 8,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = null;
    await closing.end();
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, values as unknown[]);
  return result.rows;
}

export async function queryOne<
  T extends pg.QueryResultRow = pg.QueryResultRow,
>(text: string, values: readonly unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, values);
  return rows[0] ?? null;
}

/**
 * Run `fn` inside a transaction that looks exactly like a PostgREST request:
 * the request's database role, with `request.jwt.claims` set to the token's
 * claims, so `auth.uid()` answers and every RLS policy applies.
 *
 * This is how the harness avoids re-implementing the rules. The seed calls
 * `create_channel` and `capture_video` through it, so a broken grant fails the
 * seed instead of hiding behind a superuser connection; and the storage API
 * writes `storage.objects` through it, so the *real* policy from
 * `0001_init.sql` — "the first path segment must be your user id" — is what
 * decides, not a JavaScript copy of it.
 */
export async function withClaims<T>(
  role: 'anon' | 'authenticated',
  claims: Record<string, unknown> | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    // PostgREST leaves this as the empty string for an unauthenticated request;
    // `auth.uid()` in the shim (and in Supabase) reads empty as NULL.
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      claims === null ? '' : JSON.stringify(claims),
    ]);
    await client.query(`set local role ${role}`);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` in one transaction with full privileges.
 *
 * Used where the harness needs an atomic read-modify-write of its own auth
 * bookkeeping — refresh-token rotation, which two concurrent requests will
 * otherwise both win.
 */
export async function inTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** `withClaims` for a signed-in user, with the claims a real token carries. */
export async function asAuthenticatedUser<T>(
  userId: string,
  email: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withClaims(
    'authenticated',
    { sub: userId, role: 'authenticated', aud: 'authenticated', email },
    fn,
  );
}
