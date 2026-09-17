/**
 * `/rest/v1/*` — a straight reverse proxy onto PostgREST.
 *
 * Deliberately dumb. Nothing is rewritten, interpreted or filtered: the method,
 * the path after `/rest/v1`, the query string, the request headers and the body
 * go upstream unchanged, and the status, headers and body come back unchanged.
 * That includes `Authorization` (PostgREST validates the JWT itself and derives
 * the database role from its `role` claim), `apikey`, `Prefer`, `Range`,
 * `Content-Type`, `Accept`, and the `Accept-Profile`/`Content-Profile` pair.
 *
 * It matters that this layer knows nothing: every RPC the app makes
 * (`create_channel`, `capture_video`, `move_video`, `swap_thumbnail`) is a POST
 * to `/rest/v1/rpc/<fn>`, and a proxy that understood the app would be a proxy
 * that could lie about what the database allows.
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { POSTGREST_HOST, POSTGREST_PORT } from './config.mjs';
import { applyCors, isHopByHop, sendJson } from './http.mjs';
import { verifyJwt } from './jwt.js';

export function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
): void {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (isHopByHop(name) || name.toLowerCase() === 'host') continue;
    headers[name] = value;
  }

  // An `apikey` with no `Authorization` is an anon request, and stays one.
  //
  // The gateway has already checked that the key is one this stack issued
  // (server.mts, Kong's key-auth). What it must NOT do is promote the caller to
  // whatever role the key names: forwarding a service_role key verbatim as
  // `Authorization` would turn a bare `apikey` header into a full RLS-bypassing
  // session. Only an anon key is copied across; anything else is left for
  // PostgREST's own `db-anon-role` to handle, which is what a hosted project
  // does with a request that carries no `Authorization`.
  const suppliedKey =
    typeof req.headers.apikey === 'string' ? req.headers.apikey : null;
  if (!headers.authorization && suppliedKey !== null) {
    let role: unknown = null;
    try {
      role = verifyJwt(suppliedKey).role;
    } catch {
      role = null;
    }
    if (role === 'anon') {
      headers.authorization = `Bearer ${suppliedKey}`;
    }
  }

  const upstream = http.request(
    {
      host: POSTGREST_HOST,
      port: POSTGREST_PORT,
      method: req.method,
      path: `${path === '' ? '/' : path}${url.search}`,
      headers,
    },
    (upstreamRes) => {
      applyCors(req, res);
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined || isHopByHop(name)) continue;
        res.setHeader(name, value);
      }
      res.writeHead(upstreamRes.statusCode ?? 502);
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (error: Error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    applyCors(req, res);
    sendJson(res, 502, {
      message: `The local dev stack could not reach PostgREST on ${POSTGREST_HOST}:${POSTGREST_PORT}: ${error.message}`,
      code: 'dev_stack_upstream_unavailable',
      details: null,
      hint: 'Is `npm run dev:stack` still running?',
    });
  });

  req.pipe(upstream);
  req.on('error', () => upstream.destroy());
}
