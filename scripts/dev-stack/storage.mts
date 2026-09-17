/**
 * `/storage/v1/*` — enough of the Supabase Storage object API for the thumbnail
 * work M4 will do, built now because M1 starts uploading.
 *
 * Bytes live in a gitignored directory; the *metadata* lives in
 * `storage.objects` in the same database, and every read and write of that
 * table happens through `withClaims()` as the caller's own database role. That
 * is the important part: the rule this enforces is not a JavaScript re-reading
 * of the storage policy, it is the policy itself —
 *
 *   create policy "thumbnails owner rw" on storage.objects
 *     using      (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = auth.uid()::text)
 *     with check (…same…);
 *
 * — running in Postgres. A path whose first segment is not the caller's user id
 * is refused by the database, and the harness turns that refusal into the 403
 * the real service sends. Change the policy and this surface changes with it.
 *
 * Implemented: upload, upload-with-upsert, overwrite (PUT), download, remove,
 * list, createSignedUrl(s) and the signed-URL GET. Everything else answers 501
 * with a message that says so — see `scripts/dev-stack/README.md`.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

import { STORAGE_DIR } from './config.mjs';
import { queryOne, withClaims } from './db.mjs';
import { asRecord, readBody, readJson, sendJson } from './http.mjs';
import { bearerToken, JwtError, nowSeconds, signJwt, verifyJwt } from './jwt.js';

/* -------------------------------------------------------------------------- */
/* Caller identity                                                             */
/* -------------------------------------------------------------------------- */

interface Caller {
  role: 'anon' | 'authenticated';
  claims: Record<string, unknown> | null;
}

/** An `Authorization` header whose token does not verify. */
class BadToken extends Error {}

/**
 * Who is asking, in the terms the database understands.
 *
 * Three cases, and the difference between the last two is the whole point:
 *
 *   - no `Authorization` header at all, or an api key (which carries a role but
 *     no `sub`): the `anon` role with no claims — what PostgREST would make of
 *     it, and what the storage policy will refuse;
 *   - a valid `authenticated` token: that user;
 *   - a token that does not verify — a bad signature, or an EXPIRED session:
 *     `BadToken`, which the caller turns into a 401.
 *
 * Quietly demoting an expired token to `anon` (which is what this used to do)
 * makes an expired session indistinguishable from writing into someone else's
 * folder: both come back as the policy's 403. The app would then render "an
 * object path must start with your own user id" when the truth is "your session
 * expired", and nothing here would ever make it exercise the refresh-and-retry
 * path a hosted project forces. Real storage-api rejects the token itself, as
 * `/rest/v1` and `/auth/v1/user` already do here with the same token.
 */
function callerOf(req: IncomingMessage): Caller {
  const token = bearerToken(req.headers.authorization);
  if (!token) return { role: 'anon', claims: null };

  let claims: Record<string, unknown>;
  try {
    claims = verifyJwt(token) as Record<string, unknown>;
  } catch (error) {
    throw new BadToken(error instanceof JwtError ? error.message : 'invalid JWT');
  }

  if (claims.role === 'authenticated' && typeof claims.sub === 'string') {
    return { role: 'authenticated', claims };
  }
  return { role: 'anon', claims: null };
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** The shape `storage-js` parses: `message` and `statusCode`. */
function sendStorageError(
  res: ServerResponse,
  status: number,
  error: string,
  message: string,
): void {
  sendJson(res, status, { statusCode: String(status), error, message });
}

const UNAUTHORIZED_MESSAGE =
  'new row violates row-level security policy: an object path must start with your own user id (uid/…), which is what the thumbnails bucket policy requires.';

/* -------------------------------------------------------------------------- */
/* Paths                                                                       */
/* -------------------------------------------------------------------------- */

class UnsafePath extends Error {}

/**
 * Turn the URL segments after the bucket into an object name.
 *
 * Refuses anything that could climb out of the storage directory. The database
 * decides *who* may write where; this decides only that a name is a name.
 */
function objectName(segments: readonly string[]): string {
  const parts = segments.map((segment) => decodeURIComponent(segment));
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || part.includes('\0')) {
      throw new UnsafePath(`"${parts.join('/')}" is not a usable object path`);
    }
  }
  if (parts.length === 0) throw new UnsafePath('an object path is required');
  return parts.join('/');
}

function fileFor(bucket: string, name: string): string {
  const full = path.resolve(STORAGE_DIR, bucket, name);
  const root = path.resolve(STORAGE_DIR, bucket) + path.sep;
  if (!full.startsWith(root)) {
    throw new UnsafePath(`"${name}" escapes the bucket directory`);
  }
  return full;
}

/* -------------------------------------------------------------------------- */
/* Multipart                                                                   */
/* -------------------------------------------------------------------------- */

interface UploadedPart {
  bytes: Buffer;
  contentType: string | null;
}

/**
 * The one multipart case storage-js produces: a handful of small text fields
 * plus one file part, whose field name is the empty string when the caller
 * passed a Blob. Written out rather than pulled in as a dependency — a full
 * parser would be more code to trust, not less.
 */
function parseMultipart(body: Buffer, boundary: string): UploadedPart | null {
  const delimiter = Buffer.from(`--${boundary}`);
  const chunks: Buffer[] = [];

  let index = body.indexOf(delimiter);
  while (index !== -1) {
    const start = index + delimiter.byteLength;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    chunks.push(body.subarray(start, next));
    index = next;
  }

  let fallback: UploadedPart | null = null;

  for (const chunk of chunks) {
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const rawHeaders = chunk.subarray(0, headerEnd).toString('utf8');
    // Trailing CRLF belongs to the delimiter that follows, not to the content.
    let content = chunk.subarray(headerEnd + 4);
    if (content.subarray(-2).toString('binary') === '\r\n') {
      content = content.subarray(0, content.byteLength - 2);
    }

    const disposition = /content-disposition:([^\r\n]*)/i.exec(rawHeaders)?.[1] ?? '';
    const contentType =
      /content-type:\s*([^\r\n]*)/i.exec(rawHeaders)?.[1]?.trim() ?? null;
    const fieldName = /\bname="([^"]*)"/i.exec(disposition)?.[1];
    const hasFilename = /\bfilename="/i.test(disposition);

    if (hasFilename || fieldName === '') {
      return { bytes: content, contentType };
    }
    // Anything that is not one of storage-js's known text fields is a plausible
    // file part from a hand-rolled FormData.
    if (fieldName !== undefined && !['cacheControl', 'metadata'].includes(fieldName)) {
      fallback ??= { bytes: content, contentType };
    }
  }

  return fallback;
}

function uploadPayload(req: IncomingMessage, body: Buffer): UploadedPart {
  const contentType = req.headers['content-type'] ?? '';
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (boundary) {
    const parsed = parseMultipart(body, (boundary[1] ?? boundary[2]).trim());
    if (parsed) return parsed;
    return { bytes: Buffer.alloc(0), contentType: null };
  }
  return {
    bytes: body,
    contentType: contentType === '' ? 'application/octet-stream' : contentType,
  };
}

/* -------------------------------------------------------------------------- */
/* Object metadata, through the real policy                                    */
/* -------------------------------------------------------------------------- */

interface ObjectRow {
  id: string;
  name: string;
  metadata: { size?: number; mimetype?: string; cacheControl?: string } | null;
  updated_at: Date;
}

async function bucketExists(bucket: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    'select id from storage.buckets where id = $1',
    [bucket],
  );
  return row !== null;
}

/**
 * Insert or update the object row AS THE CALLER. A refusal here is the storage
 * policy refusing, and is reported as 403 exactly as the real service does.
 */
async function upsertObject(
  caller: Caller,
  bucket: string,
  name: string,
  metadata: Record<string, unknown>,
  allowOverwrite: boolean,
): Promise<{ ok: true; row: ObjectRow } | { ok: false; reason: 'denied' | 'exists' }> {
  try {
    return await withClaims(caller.role, caller.claims, async (client) => {
      const existing = await client.query<ObjectRow>(
        'select id, name, metadata, updated_at from storage.objects where bucket_id = $1 and name = $2',
        [bucket, name],
      );

      if (existing.rowCount && existing.rowCount > 0) {
        if (!allowOverwrite) return { ok: false, reason: 'exists' } as const;
        const updated = await client.query<ObjectRow>(
          `update storage.objects
              set metadata = $3, updated_at = now()
            where bucket_id = $1 and name = $2
        returning id, name, metadata, updated_at`,
          [bucket, name, metadata],
        );
        if (updated.rowCount === 0) return { ok: false, reason: 'denied' } as const;
        return { ok: true, row: updated.rows[0] } as const;
      }

      const inserted = await client.query<ObjectRow>(
        `insert into storage.objects (bucket_id, name, owner, metadata)
         values ($1, $2, auth.uid(), $3)
      returning id, name, metadata, updated_at`,
        [bucket, name, metadata],
      );
      return { ok: true, row: inserted.rows[0] } as const;
    });
  } catch (error) {
    // 42501 is "new row violates row-level security policy" and friends: the
    // policy said no. Anything else is a real fault and should not be hidden.
    if (isRlsRefusal(error)) return { ok: false, reason: 'denied' };
    throw error;
  }
}

function isRlsRefusal(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42501';
}

/** Read the object row as the caller. `null` means "not visible to you". */
async function readObject(
  caller: Caller,
  bucket: string,
  name: string,
): Promise<ObjectRow | null> {
  return withClaims(caller.role, caller.claims, async (client) => {
    const result = await client.query<ObjectRow>(
      'select id, name, metadata, updated_at from storage.objects where bucket_id = $1 and name = $2',
      [bucket, name],
    );
    return result.rows[0] ?? null;
  });
}

/* -------------------------------------------------------------------------- */
/* Routing                                                                     */
/* -------------------------------------------------------------------------- */

export async function handleStorage(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
  url: URL,
): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = requestPath.split('/').filter((segment) => segment !== '');

  try {
    if (segments[0] === 'bucket') {
      return await handleBucket(req, res, segments.slice(1), method);
    }

    if (segments[0] === 'object') {
      return await handleObject(req, res, segments.slice(1), url, method);
    }
  } catch (error) {
    if (error instanceof UnsafePath) {
      return sendStorageError(res, 400, 'InvalidKey', error.message);
    }
    if (error instanceof BadToken) {
      return sendStorageError(
        res,
        401,
        'InvalidJWT',
        `${error.message} — this is a rejected token, not a rejected path. The session has to be refreshed.`,
      );
    }
    throw error;
  }

  sendStorageError(
    res,
    501,
    'NotImplemented',
    `${method} /storage/v1/${segments.join('/')} is not implemented by the local dev stack. See scripts/dev-stack/README.md.`,
  );
}

/**
 * Bucket reads, as the caller.
 *
 * `storage.buckets` has RLS on with no policy for the client roles — both in
 * real Supabase and in `supabase/tests/shim.sql` — so this correctly answers a
 * client with nothing. It is *not* short-circuited to a privileged read: a
 * harness that let a client list buckets would be more permissive than the
 * thing it stands in for, which is the exact mistake M0's review found in the
 * shim (finding F7).
 */
async function handleBucket(
  req: IncomingMessage,
  res: ServerResponse,
  rest: readonly string[],
  method: string,
): Promise<void> {
  if (method !== 'GET') {
    return sendStorageError(
      res,
      501,
      'NotImplemented',
      'The local dev stack does not create, update or delete buckets — `supabase/migrations/0001_init.sql` owns the one bucket there is.',
    );
  }

  const caller = callerOf(req);
  const where = rest.length === 0 ? '' : ' where id = $1';
  const values = rest.length === 0 ? [] : [decodeURIComponent(rest[0])];

  const rows = await withClaims(caller.role, caller.claims, async (client) => {
    const result = await client.query(
      `select id, name, public, created_at from storage.buckets${where}`,
      values,
    );
    return result.rows;
  }).catch((error: unknown) => {
    if (isRlsRefusal(error)) return [];
    throw error;
  });

  if (rest.length === 0) return sendJson(res, 200, rows);
  if (rows.length === 0) {
    return sendStorageError(res, 404, 'NotFound', 'Bucket not found');
  }
  return sendJson(res, 200, rows[0]);
}

async function handleObject(
  req: IncomingMessage,
  res: ServerResponse,
  rest: readonly string[],
  url: URL,
  method: string,
): Promise<void> {
  // The signed-URL GET first, before any look at `Authorization`: the token in
  // the query string *is* the authorisation, and the browser fetches these from
  // an `<img>` tag that sends whatever cookies and headers it likes.
  if (rest[0] === 'sign' && method === 'GET' && rest.length > 2) {
    return serveSigned(res, decodeURIComponent(rest[1]), objectName(rest.slice(2)), url);
  }

  const caller = callerOf(req);

  // `sign` and `list` are verbs that take the bucket's place; everything else
  // starts with the bucket id.
  if (rest[0] === 'sign') {
    if (method === 'POST' && rest.length === 2) {
      return signMany(req, res, caller, decodeURIComponent(rest[1]));
    }
    if (method === 'POST' && rest.length > 2) {
      return signOne(req, res, caller, decodeURIComponent(rest[1]), objectName(rest.slice(2)));
    }
  }

  if (rest[0] === 'list' && method === 'POST' && rest.length === 2) {
    return list(req, res, caller, decodeURIComponent(rest[1]));
  }

  // storage-js `download()` hits /object/<bucket>/<path>; the service also
  // answers /object/authenticated/<bucket>/<path> for the same thing.
  const authenticatedAlias = rest[0] === 'authenticated';
  const scoped = authenticatedAlias ? rest.slice(1) : rest;

  if (rest[0] === 'public') {
    return sendStorageError(
      res,
      400,
      'InvalidRequest',
      'The thumbnails bucket is private; there are no public object URLs. Use createSignedUrl().',
    );
  }

  if (scoped.length >= 1) {
    const bucket = decodeURIComponent(scoped[0]);

    if (method === 'DELETE' && scoped.length === 1) {
      return remove(req, res, caller, bucket);
    }
    if (scoped.length >= 2) {
      const name = objectName(scoped.slice(1));
      if (method === 'POST') return upload(req, res, caller, bucket, name, false);
      if (method === 'PUT') return upload(req, res, caller, bucket, name, true);
      if (method === 'GET' || method === 'HEAD') {
        return download(req, res, caller, bucket, name, method === 'HEAD');
      }
      if (method === 'DELETE') return removeOne(res, caller, bucket, name);
    }
  }

  sendStorageError(
    res,
    501,
    'NotImplemented',
    `${method} /storage/v1/object/${rest.join('/')} is not implemented by the local dev stack. See scripts/dev-stack/README.md.`,
  );
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

async function upload(
  req: IncomingMessage,
  res: ServerResponse,
  caller: Caller,
  bucket: string,
  name: string,
  isUpdate: boolean,
): Promise<void> {
  if (!(await bucketExists(bucket))) {
    await readBody(req).catch(() => Buffer.alloc(0));
    return sendStorageError(res, 404, 'NotFound', 'Bucket not found');
  }

  const body = await readBody(req);
  const part = uploadPayload(req, body);

  // PUT is an update and always replaces; POST replaces only with `x-upsert`.
  const upsertHeader = req.headers['x-upsert'];
  const allowOverwrite =
    isUpdate || (typeof upsertHeader === 'string' && upsertHeader === 'true');

  const metadata = {
    size: part.bytes.byteLength,
    mimetype: part.contentType ?? 'application/octet-stream',
    cacheControl: cacheControlOf(req),
    lastModified: new Date().toISOString(),
    eTag: `"${createHash('md5').update(part.bytes).digest('hex')}"`,
  };

  const result = await upsertObject(caller, bucket, name, metadata, allowOverwrite);

  if (!result.ok) {
    if (result.reason === 'exists') {
      return sendStorageError(
        res,
        409,
        'Duplicate',
        'The resource already exists',
      );
    }
    return sendStorageError(res, 403, 'Unauthorized', UNAUTHORIZED_MESSAGE);
  }

  const file = fileFor(bucket, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, part.bytes);

  sendJson(res, 200, { Id: result.row.id, Key: `${bucket}/${name}` });
}

function cacheControlOf(req: IncomingMessage): string {
  const header = req.headers['cache-control'];
  return typeof header === 'string' && header !== '' ? header : 'max-age=3600';
}

async function download(
  req: IncomingMessage,
  res: ServerResponse,
  caller: Caller,
  bucket: string,
  name: string,
  headOnly: boolean,
): Promise<void> {
  const row = await readObject(caller, bucket, name);
  if (!row) {
    // The real service answers 400 "Object not found" for an object you cannot
    // see as well as for one that is not there. Indistinguishable on purpose.
    return sendStorageError(res, 400, 'InvalidRequest', 'Object not found');
  }
  await sendBytes(res, bucket, name, row, headOnly);
}

async function sendBytes(
  res: ServerResponse,
  bucket: string,
  name: string,
  row: ObjectRow,
  headOnly = false,
): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(fileFor(bucket, name));
  } catch {
    return sendStorageError(
      res,
      404,
      'NotFound',
      `"${bucket}/${name}" has a row in storage.objects but no bytes on disk. Re-run the stack; .dev-stack/ is throwaway state.`,
    );
  }

  res.writeHead(200, {
    'Content-Type': row.metadata?.mimetype ?? 'application/octet-stream',
    'Content-Length': String(bytes.byteLength),
    'Cache-Control': row.metadata?.cacheControl ?? 'max-age=3600',
    'Last-Modified': row.updated_at.toUTCString(),
  });
  res.end(headOnly ? undefined : bytes);
}

async function removeOne(
  res: ServerResponse,
  caller: Caller,
  bucket: string,
  name: string,
): Promise<void> {
  const removed = await deleteObjects(caller, bucket, [name]);
  if (removed.length === 0) {
    return sendStorageError(res, 400, 'InvalidRequest', 'Object not found');
  }
  sendJson(res, 200, { message: 'Successfully deleted' });
}

async function remove(
  req: IncomingMessage,
  res: ServerResponse,
  caller: Caller,
  bucket: string,
): Promise<void> {
  const body = asRecord(await readJson(req).catch(() => ({})));
  const prefixes = Array.isArray(body.prefixes)
    ? body.prefixes.filter((value): value is string => typeof value === 'string')
    : [];

  if (prefixes.length === 0) {
    return sendStorageError(
      res,
      400,
      'InvalidRequest',
      'A non-empty `prefixes` array is required',
    );
  }

  const removed = await deleteObjects(caller, bucket, prefixes);
  sendJson(
    res,
    200,
    removed.map((row) => ({
      name: row.name,
      id: row.id,
      bucket_id: bucket,
      updated_at: row.updated_at.toISOString(),
      metadata: row.metadata,
    })),
  );
}

/**
 * Delete as the caller: rows the policy hides simply do not match, so a request
 * to remove someone else's object silently removes nothing — which is what the
 * real service does too.
 */
async function deleteObjects(
  caller: Caller,
  bucket: string,
  names: readonly string[],
): Promise<ObjectRow[]> {
  const rows = await withClaims(caller.role, caller.claims, async (client) => {
    const result = await client.query<ObjectRow>(
      `delete from storage.objects
        where bucket_id = $1 and name = any($2::text[])
    returning id, name, metadata, updated_at`,
      [bucket, [...names]],
    );
    return result.rows;
  }).catch((error: unknown) => {
    if (isRlsRefusal(error)) return [] as ObjectRow[];
    throw error;
  });

  await Promise.all(
    rows.map(async (row) => {
      try {
        await fs.rm(fileFor(bucket, row.name), { force: true });
      } catch {
        // A missing file is already the state we wanted.
      }
    }),
  );

  return rows;
}

/**
 * One level of one bucket, the way the real Storage API answers it.
 *
 * Two things here are easy to get wrong and were:
 *
 *   1. **The prefix has no trailing slash.** `storage-js` sends
 *      `prefix: path || ''` (node_modules/@supabase/storage-js/dist/index.mjs),
 *      so `.list(uid)` sends `uid`, not `uid/`. Slicing the returned names by
 *      `prefix.length` therefore left the separator behind and every name came
 *      back as `/v1/concept.png`. Normalise to a trailing slash before both the
 *      LIKE and the slice.
 *   2. **`list` is not recursive.** The real API returns the immediate level:
 *      objects as themselves, and anything deeper collapsed into one folder row
 *      per distinct first segment, with `id`, `metadata` and the timestamps all
 *      null. M4 lists thumbnails under `{user_id}/{video_id}/`, so code written
 *      against a recursive listing here would break against a hosted project.
 *
 * `limit`/`offset` are applied to the collapsed level, which means the scan
 * itself is bounded by a fixed ceiling rather than by the caller's page — fine
 * for a dev database, and noted in the README's divergence list along with the
 * `search`, `sortBy` and pagination-cursor options this does not implement
 * beyond sorting by name.
 */
const LIST_SCAN_CEILING = 10_000;

async function list(
  req: IncomingMessage,
  res: ServerResponse,
  caller: Caller,
  bucket: string,
): Promise<void> {
  const body = asRecord(await readJson(req).catch(() => ({})));
  const requested = typeof body.prefix === 'string' ? body.prefix : '';
  const prefix =
    requested === '' || requested.endsWith('/') ? requested : `${requested}/`;
  const limit = typeof body.limit === 'number' ? body.limit : 100;
  const offset = typeof body.offset === 'number' ? body.offset : 0;
  const sortBy = asRecord(body.sortBy);
  const descending = sortBy.order === 'desc';

  const rows = await withClaims(caller.role, caller.claims, async (client) => {
    const result = await client.query<ObjectRow & { created_at: Date }>(
      `select id, name, metadata, created_at, updated_at
         from storage.objects
        where bucket_id = $1 and name like $2 || '%'
     order by name
        limit $3`,
      [bucket, prefix, LIST_SCAN_CEILING],
    );
    return result.rows;
  }).catch((error: unknown) => {
    if (isRlsRefusal(error)) return [];
    throw error;
  });

  interface Entry {
    name: string;
    id: string | null;
    updated_at: string | null;
    created_at: string | null;
    last_accessed_at: string | null;
    metadata: unknown;
  }

  const entries: Entry[] = [];
  const folders = new Set<string>();

  for (const row of rows) {
    const rest = row.name.slice(prefix.length);
    if (rest === '') continue;
    const separator = rest.indexOf('/');

    if (separator === -1) {
      entries.push({
        name: rest,
        id: row.id,
        updated_at: row.updated_at.toISOString(),
        created_at: row.created_at.toISOString(),
        last_accessed_at: row.updated_at.toISOString(),
        metadata: row.metadata,
      });
      continue;
    }

    const folder = rest.slice(0, separator);
    if (folders.has(folder)) continue;
    folders.add(folder);
    entries.push({
      name: folder,
      id: null,
      updated_at: null,
      created_at: null,
      last_accessed_at: null,
      metadata: null,
    });
  }

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (descending) entries.reverse();

  sendJson(res, 200, entries.slice(offset, offset + limit));
}

/* -------------------------------------------------------------------------- */
/* Signed URLs                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A signed URL is a JWT over the object it names, exactly as the real service
 * does it, so the token cannot be edited to point somewhere else.
 */
function signedPath(bucket: string, name: string, expiresIn: number): string {
  const token = signJwt({
    url: `${bucket}/${name}`,
    iat: nowSeconds(),
    exp: nowSeconds() + expiresIn,
  });
  const encoded = name.split('/').map(encodeURIComponent).join('/');
  return `/object/sign/${encodeURIComponent(bucket)}/${encoded}?token=${token}`;
}

async function signOne(
  req: IncomingMessage,
  res: ServerResponse,
  caller: Caller,
  bucket: string,
  name: string,
): Promise<void> {
  const body = asRecord(await readJson(req).catch(() => ({})));
  const expiresIn = typeof body.expiresIn === 'number' ? body.expiresIn : 3600;

  const row = await readObject(caller, bucket, name);
  if (!row) {
    return sendStorageError(res, 400, 'InvalidRequest', 'Object not found');
  }
  sendJson(res, 200, { signedURL: signedPath(bucket, name, expiresIn) });
}

async function signMany(
  req: IncomingMessage,
  res: ServerResponse,
  caller: Caller,
  bucket: string,
): Promise<void> {
  const body = asRecord(await readJson(req).catch(() => ({})));
  const expiresIn = typeof body.expiresIn === 'number' ? body.expiresIn : 3600;
  const paths = Array.isArray(body.paths)
    ? body.paths.filter((value): value is string => typeof value === 'string')
    : [];

  const results = await Promise.all(
    paths.map(async (requested) => {
      let name: string;
      try {
        name = objectName(requested.split('/'));
      } catch {
        return { error: 'Invalid key', path: requested, signedURL: null };
      }
      const row = await readObject(caller, bucket, name);
      if (!row) {
        return { error: 'Either the object does not exist or you do not have access to it', path: requested, signedURL: null };
      }
      return { error: null, path: requested, signedURL: signedPath(bucket, name, expiresIn) };
    }),
  );

  sendJson(res, 200, results);
}

/**
 * Serve a signed URL. No Authorization header is involved — the token *is* the
 * authorisation, and it names the one object it is good for.
 */
async function serveSigned(
  res: ServerResponse,
  bucket: string,
  name: string,
  url: URL,
): Promise<void> {
  const token = url.searchParams.get('token');
  if (!token) {
    return sendStorageError(res, 400, 'InvalidRequest', 'Missing token');
  }

  let signedFor: unknown;
  try {
    signedFor = verifyJwt(token).url;
  } catch {
    return sendStorageError(res, 400, 'InvalidJWT', 'Invalid or expired token');
  }

  if (signedFor !== `${bucket}/${name}`) {
    return sendStorageError(
      res,
      400,
      'InvalidSignature',
      'The token does not sign this object',
    );
  }

  // The signature already settled who may read this, so the row is read with
  // full privileges — the same reason the real service serves signed URLs
  // without a session.
  const row = await queryOne<ObjectRow>(
    'select id, name, metadata, updated_at from storage.objects where bucket_id = $1 and name = $2',
    [bucket, name],
  );
  if (!row) return sendStorageError(res, 400, 'InvalidRequest', 'Object not found');

  await sendBytes(res, bucket, name, row);
}
