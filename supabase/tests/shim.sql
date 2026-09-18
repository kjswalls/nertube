-- Local Supabase shim for verifying migrations without Docker.
--
-- The Supabase CLI stack needs Docker. Where Docker is unavailable, this file
-- recreates just enough of a Supabase database (auth schema, storage schema,
-- roles, default privileges) that supabase/migrations/*.sql can be applied to a
-- stock Postgres and its constraints, RLS policies and functions exercised for
-- real. It is a TEST harness: never applied to a hosted project.

-- Roles Supabase provides. 'authenticated' and 'anon' deliberately lack
-- BYPASSRLS so policies actually bite when tests SET ROLE to them.
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase grants all on public tables to these roles by default; the
-- migration's column-level REVOKEs are meaningless without that baseline.
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to anon, authenticated, service_role;

-- auth schema -------------------------------------------------------------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz not null default now()
);

-- Reads the claims a test sets with:
--   select set_config('request.jwt.claims', json_build_object('sub', <uuid>)::text, true);
--
-- Shaped exactly like Supabase's own auth.uid(): the SETTING is nullif'd before
-- the cast, not the extracted claim after it. PostgREST leaves
-- request.jwt.claims as the EMPTY STRING on an unauthenticated request, and
-- `''::json` raises — which would come out of every RLS policy and out of
-- move_video/swap_thumbnail at variable initialisation, so the logged-out path
-- could not be tested at all. Empty must read as NULL.
create or replace function auth.uid() returns uuid
  language sql stable
  as $$ select coalesce(
       nullif(current_setting('request.jwt.claim.sub', true), ''),
       nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;

-- Same empty-string handling as auth.uid() above.
create or replace function auth.role() returns text
  language sql stable
  as $$ select coalesce(
       nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
       current_setting('role', true)) $$;

create or replace function auth.email() returns text
  language sql stable
  as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email' $$;

grant execute on function auth.uid(), auth.role(), auth.email() to anon, authenticated, service_role;

-- storage schema ----------------------------------------------------------
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

-- `file_size_limit` and `allowed_mime_types` are Supabase's own columns on this
-- table; a hosted project has them. They are here because `0006` sets them and
-- `50_buckets.test.sql` asserts them — without them the harness would be
-- testing a database with no ceiling while the real one has one.
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  created_at timestamptz not null default now(),
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb
);
alter table storage.objects enable row level security;
-- Real Supabase ships RLS enabled on storage.buckets with no policy for the
-- client roles, so listing or changing a bucket from a client is refused. The
-- harness has to model that: with RLS off, the grant below let an authenticated
-- user flip the private thumbnails bucket to public, and 80_storage.test.sql
-- would have been testing a strictly more permissive database than the one it
-- stands in for.
alter table storage.buckets enable row level security;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;

-- Path helper used by storage policies: 'uid/video/safe.png' -> {uid,video}
create or replace function storage.foldername(name text) returns text[]
  language plpgsql immutable
  as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1 : array_length(parts, 1) - 1];
end $$;

create or replace function storage.filename(name text) returns text
  language plpgsql immutable
  as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[array_length(parts, 1)];
end $$;

grant execute on function storage.foldername(text), storage.filename(text) to anon, authenticated, service_role;
