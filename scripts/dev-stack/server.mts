/**
 * The one HTTP origin the app is pointed at.
 *
 * A real Supabase project puts Kong in front of three services on one host and
 * routes by path prefix. This does the same, with the same prefixes, so
 * `NEXT_PUBLIC_SUPABASE_URL` is the only thing that changes between here and a
 * hosted project:
 *
 *   /rest/v1/*     → PostgREST (reverse proxy, rest.mts)
 *   /auth/v1/*     → the GoTrue subset (auth.mts)
 *   /storage/v1/*  → the Storage subset (storage.mts)
 *   /health        → this harness's own readiness check
 *
 * Kong also does one thing before any of that: its `key-auth` plugin refuses a
 * request with no api key, so a helper that forgets to send one fails at the
 * gateway rather than reaching PostgREST or GoTrue. `apiKeyProblem` below is
 * that check — without it a keyless request works locally and 401s the first
 * time it runs against a hosted project.
 */

import http from 'node:http';
import type { IncomingMessage, Server } from 'node:http';

import { GATEWAY_HOST, GATEWAY_PORT } from './config.mjs';
import { handleAuth } from './auth.mjs';
import { applyCors, sendJson } from './http.mjs';
import { JwtError, verifyJwt } from './jwt.js';
import { handleRest } from './rest.mjs';
import { handleStorage } from './storage.mjs';

/**
 * Kong's `key-auth`, as far as it matters here.
 *
 * A real project answers a request with no `apikey` 401 `{"message":"No API key
 * found in request"}` before it reaches any service. The two api keys are
 * themselves JWTs signed with the project's secret, so "is this a key we issued"
 * is a signature check.
 *
 * Returns the error to send, or `null` when the request may proceed.
 */
function apiKeyProblem(
  req: IncomingMessage,
  url: URL,
): { status: number; body: { message: string; hint?: string } } | null {
  const header = req.headers.apikey;
  const supplied =
    (typeof header === 'string' ? header : header?.[0]) ??
    url.searchParams.get('apikey') ??
    null;

  if (!supplied) {
    return {
      status: 401,
      body: {
        message: 'No API key found in request',
        hint: 'A real project sits behind Kong, which refuses this before it reaches PostgREST or GoTrue. Send the anon key as the `apikey` header — supabase-js always does.',
      },
    };
  }

  try {
    verifyJwt(supplied);
  } catch (error) {
    return {
      status: 401,
      body: {
        message: 'Invalid authentication credentials',
        hint:
          error instanceof JwtError
            ? `The \`apikey\` header is not a key this stack issued: ${error.message}.`
            : 'The `apikey` header is not a key this stack issued.',
      },
    };
  }

  return null;
}

/**
 * The routes an api key is NOT required for: the harness's own health check,
 * and the signed-URL GET, whose token *is* its authorisation and which a
 * browser fetches from an `<img>` tag that cannot set headers.
 */
function isApiKeyExempt(path: string): boolean {
  return (
    path === '/health' ||
    path === '/' ||
    path.startsWith('/storage/v1/object/sign/')
  );
}

/**
 * Flipped once PostgREST is up and the seed is in. `/health` answers 503 until
 * then, so anything waiting on this origin — Playwright's `webServer`, a
 * shell loop — waits for a stack that can actually answer a query, not just for
 * an open socket.
 */
let ready = false;

export function markReady(): void {
  ready = true;
}

export function createGateway(): Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${GATEWAY_HOST}:${GATEWAY_PORT}`);
    const path = url.pathname;

    if (req.method === 'OPTIONS') {
      applyCors(req, res);
      res.writeHead(204);
      res.end();
      return;
    }

    // Kong's key-auth, ahead of every service route.
    const served =
      path.startsWith('/rest/v1') ||
      path.startsWith('/auth/v1') ||
      path.startsWith('/storage/v1');
    if (served && !isApiKeyExempt(path)) {
      const problem = apiKeyProblem(req, url);
      if (problem) {
        // Nothing will read this request's body; drain it so the client sees
        // the response rather than a reset connection.
        req.resume();
        applyCors(req, res);
        sendJson(res, problem.status, problem.body);
        return;
      }
    }

    // The REST proxy streams the request body, so it sets its own CORS headers
    // on the upstream response rather than having them written here first.
    if (path === '/rest/v1' || path.startsWith('/rest/v1/')) {
      handleRest(req, res, path.slice('/rest/v1'.length), url);
      return;
    }

    applyCors(req, res);

    if (path === '/health' || path === '/') {
      sendJson(res, ready ? 200 : 503, {
        service: 'nertube-dev-stack',
        status: ready ? 'ok' : 'starting',
        note: 'Local TEST harness that approximates Supabase. Never used in production.',
      });
      return;
    }

    const route = path.startsWith('/auth/v1')
      ? handleAuth(req, res, path.slice('/auth/v1'.length), url)
      : path.startsWith('/storage/v1')
        ? handleStorage(req, res, path.slice('/storage/v1'.length), url)
        : null;

    if (route === null) {
      sendJson(res, 404, {
        message: `${req.method ?? 'GET'} ${path} is not a route this harness serves. It serves /rest/v1, /auth/v1 and /storage/v1.`,
      });
      return;
    }

    route.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[dev-stack] ${req.method ?? 'GET'} ${path} failed:`, error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, {
        message: `The local dev stack failed handling this request: ${message}`,
      });
    });
  });
}

export function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(GATEWAY_PORT, GATEWAY_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
