/**
 * Request/response plumbing shared by the gateway's three surfaces.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Headers a hop must not forward. `connection` and friends are per-hop by
 * definition (RFC 9110 §7.6.1); `host` has to be rewritten for the upstream.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function isHopByHop(name: string): boolean {
  return HOP_BY_HOP.has(name.toLowerCase());
}

/**
 * CORS, permissive on purpose.
 *
 * A real project sits behind Kong, which answers preflights for every route.
 * The browser Supabase client here (storage uploads and signed-URL reads) runs
 * on http://localhost:3000 and calls http://127.0.0.1:54321 — a cross origin —
 * so without this the storage half of the harness would be unreachable from the
 * one place the app actually uses it.
 */
export function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
  if (origin) res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] ??
      'authorization, apikey, content-type, prefer, range, x-client-info, x-upsert, x-supabase-api-version, accept-profile, content-profile, cache-control, x-metadata',
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'content-range, content-location, content-length, content-type, etag, last-modified, x-supabase-api-version',
  );
  res.setHeader('Access-Control-Max-Age', '86400');
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.byteLength),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

/** Read the whole request body. Bodies here are a login form or a thumbnail. */
export async function readBody(
  req: IncomingMessage,
  limitBytes = 64 * 1024 * 1024,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > limitBytes) {
      throw new Error(`request body exceeds ${limitBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  if (body.byteLength === 0) return {};
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new BadRequest('could not parse the request body as JSON');
  }
}

export class BadRequest extends Error {}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function stringField(
  source: Record<string, unknown>,
  name: string,
): string | null {
  const value = source[name];
  return typeof value === 'string' && value !== '' ? value : null;
}
