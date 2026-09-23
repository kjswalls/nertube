-- 0010 — the user's time zone, so "today" is their day and not the UTC day.
--
-- Until M10 every "today" in the application — the calendar's ring, `/now`'s
-- go-live check, the board's filming badge, the matrix's month — was the UTC
-- calendar day, because there was nowhere to keep a zone (`lib/calendar-dates.ts`
-- and M6's decisions record why). A viewer in Los Angeles saw tomorrow arrive
-- at five in the afternoon.
--
-- The zone lives here, per user, in the database rather than in a cookie or in
-- the browser, so the phone and the laptop agree about what day it is.
--
-- ## The table
--
-- `profiles` is the smallest thing that fits the schema's conventions: one row
-- per user (`unique (user_id)`), the three columns every table has (`id`,
-- `user_id` referencing auth.users with cascade, `created_at`), RLS on, and a
-- select policy scoped to `auth.uid()`. It has no children, so it needs no
-- `unique (id, user_id)`; nothing can point at another tenant's profile.
--
-- ## One write path
--
-- The client can read its own row and write nothing. `set_time_zone()` is the
-- only writer, for the same reason `create_channel()` and `move_video()` are:
-- the validation that matters ("is this a real IANA zone?") needs the
-- catalogue, and a CHECK constraint cannot consult it (`pg_timezone_names` is
-- not immutable). So the column carries the *shape* as a CHECK, and the
-- function carries the *existence* test.
--
-- The zone name is an IANA name ("Europe/London", "America/Argentina/Cordoba",
-- "Etc/GMT+5") or exactly "UTC". POSIX strings ("EST5EDT", "+05:30"), the
-- tzdata housekeeping entries ("posixrules", "localtime", "Factory") and
-- anything the server's tz database does not know are refused, because
-- `Intl.DateTimeFormat` in the browser and in Node has to be able to use what
-- is stored here and an offset string is not a zone (it has no DST).
--
-- ## Detected, then chosen
--
-- `time_zone_source` records who decided. The application records the
-- browser's zone on first use (`'detected'`), and Settings writes `'chosen'`.
-- `p_detected => true` never overwrites an existing row: a laptop that signs in
-- after the user picked a zone on their phone must not quietly change it back.
--
-- ## The first zone re-reads the target dates already stamped
--
-- Before M10, "Confirm live" stamped `published_at` with the target date at
-- midnight **UTC** (`${date}T00:00:00Z`), because no zone was known. From M10
-- it stamps the user's own midnight. Left alone, every video confirmed before
-- M10 would show as published the day *before* its target date anywhere west
-- of UTC, the moment that user's zone is known. So the first time a user's
-- zone is recorded — and only then — each of their `published_at` values that
-- is exactly a UTC midnight (the shape only that stamp produces; a drag into
-- Published stamps `now()`, to the microsecond) is moved to the same date's
-- midnight in the new zone. A later change of zone moves nothing: those are
-- instants, and an instant does not change because the viewer moved.
--
-- Same shape as the other functions: security definer, pinned search_path,
-- EXECUTE for authenticated only.

-- ----------------------------------------------------------- profiles -----

create table public.profiles (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid()
                     references auth.users (id) on delete cascade,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  time_zone        text not null,
  time_zone_source text not null,
  constraint profiles_user_unique unique (user_id),
  -- An IANA-shaped name or exactly UTC, at most 64 characters (the longest
  -- real one is 30). Existence is `set_time_zone`'s job; see the header.
  constraint profiles_time_zone_shape check (
    length(time_zone) <= 64
    and time_zone ~ '^(UTC|[A-Z][A-Za-z_-]*(/[A-Za-z0-9_+-]+)+)$'
  ),
  constraint profiles_time_zone_source_known check (
    time_zone_source in ('detected', 'chosen')
  )
);

alter table public.profiles enable row level security;

create policy profiles_select on public.profiles
  for select using (user_id = auth.uid());

-- Supabase's default privileges grant everything on a new table to anon and
-- authenticated. Take it all back and give the one thing a client needs.
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

-- ------------------------------------------------------ set_time_zone -----

create function public.set_time_zone(
  p_zone     text,
  p_detected boolean default false
) returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_row   public.profiles;
  v_first boolean;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  if p_zone is null
     or length(p_zone) > 64
     or p_zone !~ '^(UTC|[A-Z][A-Za-z_-]*(/[A-Za-z0-9_+-]+)+)$'
     or not exists (select 1 from pg_timezone_names where name = p_zone)
  then
    raise exception 'timezone:unknown %', coalesce(p_zone, '<null>')
      using errcode = '22023';
  end if;

  v_first := not exists (select 1 from public.profiles where user_id = v_uid);

  if coalesce(p_detected, false) then
    insert into public.profiles (user_id, time_zone, time_zone_source)
    values (v_uid, p_zone, 'detected')
    on conflict (user_id) do nothing;
  else
    insert into public.profiles (user_id, time_zone, time_zone_source)
    values (v_uid, p_zone, 'chosen')
    on conflict (user_id) do update
      set time_zone        = excluded.time_zone,
          time_zone_source = 'chosen',
          updated_at       = now();
  end if;

  -- The one-time re-reading of pre-M10 "Confirm live" stamps (see header).
  if v_first then
    update public.videos v
       set published_at = ((v.published_at at time zone 'UTC')::date)::timestamp
                            at time zone p_zone
     where v.user_id = v_uid
       and v.published_at is not null
       and v.published_at = ((v.published_at at time zone 'UTC')::date)::timestamp
                              at time zone 'UTC';
  end if;

  select * into v_row from public.profiles where user_id = v_uid;
  return v_row;
end;
$$;

revoke all on function public.set_time_zone(text, boolean) from public, anon;
grant execute on function public.set_time_zone(text, boolean) to authenticated, service_role;
