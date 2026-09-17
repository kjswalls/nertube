-- Dev-stack-only additions to the auth schema.
--
-- `supabase/tests/shim.sql` recreates just enough of `auth` for the migrations
-- to apply: the schema, `auth.users(id, email, created_at)` and `auth.uid()`.
-- That is all a SQL test needs, because a SQL test sets `request.jwt.claims`
-- by hand. A *running* stack has to sign people in, so it needs somewhere to
-- keep a password and a refresh token.
--
-- This file is applied by `scripts/dev-stack/start.mts` AFTER the migrations,
-- and only to the throwaway dev database. It is deliberately NOT part of
-- `supabase/migrations/` (those are the real project's schema) and NOT part of
-- the shim (that is the SQL-test harness, which must stay minimal).
--
-- The columns mirror the GoTrue ones the app could plausibly read. Passwords
-- are bcrypt via pgcrypto's `crypt()`/`gen_salt('bf')`, which is what GoTrue
-- uses too — so a password is never stored or compared in plaintext even here.

create extension if not exists pgcrypto;

alter table auth.users
  add column if not exists aud                text        not null default 'authenticated',
  add column if not exists role               text        not null default 'authenticated',
  add column if not exists encrypted_password text,
  add column if not exists email_confirmed_at timestamptz,
  add column if not exists last_sign_in_at    timestamptz,
  add column if not exists raw_app_meta_data  jsonb       not null default '{"provider":"email","providers":["email"]}'::jsonb,
  add column if not exists raw_user_meta_data jsonb       not null default '{}'::jsonb,
  add column if not exists is_anonymous       boolean     not null default false,
  add column if not exists updated_at         timestamptz not null default now();

-- GoTrue stores emails folded to lower case and treats them case-insensitively.
create unique index if not exists users_email_lower_key
  on auth.users (lower(email));

-- One row per issued refresh token. `revoked` rather than a delete so a replayed
-- token is distinguishable from an unknown one, the way GoTrue does it.
--
-- `revoked_at` and `replaced_by` are what make GoTrue's reuse interval
-- possible. A server-rendered page creates several Supabase clients per request
-- (the proxy, the page, the header), and an expiring access token has all of
-- them reaching for the same refresh token at once. Real GoTrue answers a
-- token that was rotated moments ago with the session that replaced it
-- (SECURITY_REFRESH_TOKEN_REUSE_INTERVAL, 10 seconds by default) rather than an
-- error. Without that, a page whose token expires mid-render signs the user
-- out — which is a harness bug, not an app bug, and one worth not having.
create table if not exists auth.refresh_tokens (
  token       text primary key,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  session_id  uuid        not null,
  revoked     boolean     not null default false,
  revoked_at  timestamptz,
  replaced_by text,
  created_at  timestamptz not null default now()
);

create index if not exists refresh_tokens_user_id_idx
  on auth.refresh_tokens (user_id);

-- The storage API needs (bucket_id, name) to identify an object, so that an
-- upsert is an upsert. Real Supabase has this constraint; the SQL-test shim
-- does not need it and therefore does not carry it.
create unique index if not exists objects_bucket_id_name_key
  on storage.objects (bucket_id, name);

-- Password check, kept in SQL so the plaintext never leaves the query. Returns
-- the user id on a match and nothing at all otherwise — a wrong password and an
-- unknown email are indistinguishable to the caller, as they should be.
create or replace function auth.dev_verify_password(p_email text, p_password text)
returns uuid
language sql
stable
as $$
  select u.id
    from auth.users u
   where lower(u.email) = lower(p_email)
     and u.encrypted_password is not null
     and u.encrypted_password = crypt(p_password, u.encrypted_password)
$$;

-- The role PostgREST logs in as.
--
-- A hosted project runs PostgREST as `authenticator`: LOGIN, NOINHERIT, and
-- granted membership in exactly `anon`, `authenticated` and `service_role`. A
-- token whose `role` claim names anything else therefore fails at `SET ROLE`.
-- Connecting PostgREST as `postgres` instead (which is `rolsuper` here) would
-- make that claim unconstrained, so a token minted with the wrong role would be
-- invisible locally and fatal in production — the exact class of false
-- confidence this harness exists to avoid.
--
-- Roles are cluster-wide, not per-database, so this is idempotent by hand.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  else
    alter role authenticator login noinherit;
  end if;
end
$$;

grant anon, authenticated, service_role to authenticator;
