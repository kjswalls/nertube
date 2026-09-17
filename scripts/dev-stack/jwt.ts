/**
 * The smallest HS256 JWT implementation that is still correct, so the harness
 * needs no crypto dependency.
 *
 * PostgREST validates these tokens itself, which is the point: the gateway does
 * not tell PostgREST who the caller is, it hands over a signed token and
 * PostgREST derives the database role from the `role` claim and publishes every
 * claim as the `request.jwt.claims` GUC. That is the same mechanism
 * `auth.uid()` reads in `supabase/tests/shim.sql` and in a real project.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { JWT_ISSUER, JWT_SECRET } from './shared.js';

export interface JwtClaims {
  sub?: string;
  role?: string;
  aud?: string;
  email?: string;
  iat?: number;
  exp?: number;
  iss?: string;
  session_id?: string;
  is_anonymous?: boolean;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
  [claim: string]: unknown;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(data: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(data).digest());
}

/** Mint an HS256 token. `iat`/`exp` already in `claims` are left alone. */
export function signJwt(claims: JwtClaims, secret: string = JWT_SECRET): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(claims));
  const data = `${header}.${body}`;
  return `${data}.${sign(data, secret)}`;
}

export class JwtError extends Error {}

/**
 * Verify signature and expiry, and return the claims.
 *
 * `timingSafeEqual` over a length check first — a constant-time compare on
 * buffers of different lengths throws rather than returning false.
 */
export function verifyJwt(
  token: string,
  secret: string = JWT_SECRET,
): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('malformed token');
  }
  const [header, body, signature] = parts;

  const expected = Buffer.from(sign(`${header}.${body}`, secret));
  const actual = Buffer.from(signature);
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    throw new JwtError('bad signature');
  }

  let claims: JwtClaims;
  try {
    claims = JSON.parse(base64urlDecode(body).toString('utf8')) as JwtClaims;
  } catch {
    throw new JwtError('unreadable claims');
  }

  if (typeof claims.exp === 'number' && claims.exp <= nowSeconds()) {
    throw new JwtError('token expired');
  }

  return claims;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * An api key: a JWT carrying nothing but a role, exactly like a real project's
 * anon / service_role keys. Deterministic, so the value printed for
 * `.env.local` never changes between runs.
 */
export function apiKey(
  role: 'anon' | 'service_role',
  iat: number,
  exp: number,
): string {
  return signJwt({ iss: JWT_ISSUER, role, iat, exp });
}

/** Pull the bearer token out of an `Authorization` header, if there is one. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
