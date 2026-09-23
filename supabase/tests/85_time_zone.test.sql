-- The user's time zone (0010): one row per user, readable by its owner only,
-- written only through set_time_zone(), and only with a zone the server's tz
-- database knows.

begin;

-- ------------------------------------------------------------- act as A ----
select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

-- 1. A client cannot write the table directly, in any of the three ways.
do $$
begin
  begin
    insert into public.profiles (user_id, time_zone, time_zone_source)
    values (fx.user_a(), 'Europe/London', 'chosen');
    raise exception 'FAILED: a client inserted a profiles row directly';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 2. A detected zone is recorded when there is none yet.
do $$
declare r public.profiles;
begin
  r := public.set_time_zone('Pacific/Auckland', true);
  if r.time_zone <> 'Pacific/Auckland' or r.time_zone_source <> 'detected' then
    raise exception 'FAILED: detection stored % (%)', r.time_zone, r.time_zone_source;
  end if;
  if r.user_id <> fx.user_a() then
    raise exception 'FAILED: the row belongs to %, not the caller', r.user_id;
  end if;
end $$;

-- 3. A second detection (another device) never overwrites what is there.
do $$
declare r public.profiles;
begin
  r := public.set_time_zone('America/Los_Angeles', true);
  if r.time_zone <> 'Pacific/Auckland' then
    raise exception 'FAILED: a later detection overwrote the zone with %', r.time_zone;
  end if;
end $$;

-- 4. A choice does, and says so; a detection after a choice changes nothing.
do $$
declare r public.profiles; n int;
begin
  r := public.set_time_zone('America/Los_Angeles');
  if r.time_zone <> 'America/Los_Angeles' or r.time_zone_source <> 'chosen' then
    raise exception 'FAILED: choosing stored % (%)', r.time_zone, r.time_zone_source;
  end if;

  r := public.set_time_zone('Asia/Kolkata', true);
  if r.time_zone <> 'America/Los_Angeles' or r.time_zone_source <> 'chosen' then
    raise exception 'FAILED: a detection overwrote a chosen zone (% / %)', r.time_zone, r.time_zone_source;
  end if;

  r := public.set_time_zone('UTC');
  if r.time_zone <> 'UTC' then raise exception 'FAILED: UTC was not accepted'; end if;

  r := public.set_time_zone('America/Argentina/Cordoba');
  if r.time_zone <> 'America/Argentina/Cordoba' then
    raise exception 'FAILED: a three-part IANA name was refused';
  end if;

  select count(*) into n from public.profiles;
  if n <> 1 then raise exception 'FAILED: A should have exactly one profile row, has %', n; end if;
end $$;

-- 5. A direct UPDATE is refused even on the caller's own row.
do $$
begin
  begin
    update public.profiles set time_zone = 'Europe/Paris' where user_id = fx.user_a();
    raise exception 'FAILED: a client updated its own profile directly';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.profiles where user_id = fx.user_a();
    raise exception 'FAILED: a client deleted its own profile directly';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 6. Anything that is not a real IANA zone is refused with 22023, and the
--    stored zone is untouched.
do $$
declare
  bad text;
  st text;
  refused boolean;
  r public.profiles;
begin
  foreach bad in array array[
    'Mars/Olympus_Mons',      -- IANA-shaped, not in the database
    'Europe/Londn',           -- a typo
    'europe/london',          -- the wrong case: not the name the catalogue holds
    '+05:30',                 -- an offset is not a zone
    'EST5EDT',                -- a POSIX rule
    'posixrules',             -- tzdata housekeeping
    'localtime',
    'Factory',
    '',
    'UTC; drop table public.profiles'
  ] loop
    refused := false;
    begin
      perform public.set_time_zone(bad);
    exception when others then
      get stacked diagnostics st = returned_sqlstate;
      refused := true;
    end;
    if not refused then raise exception 'FAILED: % was accepted as a time zone', bad; end if;
    if st <> '22023' then raise exception 'FAILED: % refused with %, expected 22023', bad, st; end if;
  end loop;

  refused := false;
  begin
    perform public.set_time_zone(null);
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    refused := true;
  end;
  if not refused or st <> '22023' then raise exception 'FAILED: a null zone was not refused'; end if;

  select * into r from public.profiles where user_id = fx.user_a();
  if r.time_zone <> 'America/Argentina/Cordoba' then
    raise exception 'FAILED: a refused write changed the stored zone to %', r.time_zone;
  end if;
end $$;

-- 6b. The first zone re-reads pre-M10 "Confirm live" stamps (a UTC midnight)
--     as the same date's midnight there; nothing else, and only once.
reset role;
do $$
declare
  v_confirmed timestamptz;
  v_dragged   timestamptz;
  r public.profiles;
begin
  -- B has no zone yet. Two published videos: one confirmed live before M10
  -- (target 3 March, stamped midnight UTC), one dragged into Published
  -- (stamped with the moment, to the microsecond).
  update public.videos
     set published_at = '2026-03-03T00:00:00Z'
   where id = fx.video_b();
  insert into public.videos (id, user_id, channel_id, stage_id, title, published_at)
  values ('d0000000-0000-4000-8000-0000000000dc', fx.user_b(), fx.channel('b-main'),
          fx.stage(fx.channel('b-main'), 'idea'), 'dragged', '2026-03-03T17:42:05.123456Z');

  perform set_config('request.jwt.claims', json_build_object('sub', fx.user_b())::text, true);
  set local role authenticated;
  r := public.set_time_zone('America/Los_Angeles', true);
  reset role;

  select published_at into v_confirmed from public.videos where id = fx.video_b();
  select published_at into v_dragged from public.videos where id = 'd0000000-0000-4000-8000-0000000000dc';
  if v_confirmed <> '2026-03-03T08:00:00Z' then
    raise exception 'FAILED: a pre-M10 confirm stamp became %, expected LA midnight (08:00Z)', v_confirmed;
  end if;
  if v_dragged <> '2026-03-03T17:42:05.123456Z' then
    raise exception 'FAILED: a stamp that was not a UTC midnight moved to %', v_dragged;
  end if;

  -- A second zone moves nothing.
  perform set_config('request.jwt.claims', json_build_object('sub', fx.user_b())::text, true);
  set local role authenticated;
  r := public.set_time_zone('Pacific/Auckland');
  reset role;
  select published_at into v_confirmed from public.videos where id = fx.video_b();
  if v_confirmed <> '2026-03-03T08:00:00Z' then
    raise exception 'FAILED: a later zone change moved published_at to %', v_confirmed;
  end if;

  -- Put B back as it was, for the isolation checks below.
  delete from public.profiles where user_id = fx.user_b();
  delete from public.videos where id = 'd0000000-0000-4000-8000-0000000000dc';
  update public.videos set published_at = null where id = fx.video_b();
end $$;

-- ------------------------------------------------------------- act as B ----
reset role;
select set_config('request.jwt.claims', json_build_object('sub', fx.user_b())::text, true);
set local role authenticated;

-- 7. Tenant isolation: B cannot see A's row, and B's own write touches only B.
do $$
declare n int; r public.profiles;
begin
  select count(*) into n from public.profiles;
  if n <> 0 then raise exception 'FAILED: B can see % profile row(s) before having one', n; end if;

  select count(*) into n from public.profiles where user_id = fx.user_a();
  if n <> 0 then raise exception 'FAILED: B can see A''s profile'; end if;

  r := public.set_time_zone('Europe/London');
  if r.user_id <> fx.user_b() then raise exception 'FAILED: B''s write landed on %', r.user_id; end if;

  select count(*) into n from public.profiles;
  if n <> 1 then raise exception 'FAILED: B should see exactly its own row, sees %', n; end if;
end $$;

reset role;

do $$
declare r public.profiles;
begin
  select * into r from public.profiles where user_id = fx.user_a();
  if r.time_zone <> 'America/Argentina/Cordoba' then
    raise exception 'FAILED: B''s write changed A''s zone to %', r.time_zone;
  end if;
end $$;

-- ----------------------------------------------------------- act as anon --
select set_config('request.jwt.claims', '', true);
set local role anon;

-- 8. Signed out: no rows, and no way to call the function.
do $$
begin
  begin
    perform 1 from public.profiles;
    raise exception 'FAILED: anon can read profiles';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.set_time_zone('Europe/London');
    raise exception 'FAILED: anon can call set_time_zone';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- 9. The column's CHECK is a backstop for a write that skips the function
--    (the owner, here): the shape is enforced even there.
do $$
begin
  delete from public.profiles where user_id = fx.user_b();
  begin
    insert into public.profiles (user_id, time_zone, time_zone_source)
    values (fx.user_b(), '+05:30', 'chosen');
    raise exception 'FAILED: the shape CHECK let an offset through';
  exception when check_violation then null;
  end;
  begin
    insert into public.profiles (user_id, time_zone, time_zone_source)
    values (fx.user_b(), 'Europe/London', 'guessed');
    raise exception 'FAILED: an unknown source was accepted';
  exception when check_violation then null;
  end;
  insert into public.profiles (user_id, time_zone, time_zone_source)
  values (fx.user_b(), 'Europe/London', 'chosen');
end $$;

-- 10. The row goes with the user.
do $$
declare n int;
begin
  delete from auth.users where id = fx.user_b();
  select count(*) into n from public.profiles where user_id = fx.user_b();
  if n <> 0 then raise exception 'FAILED: deleting the user left its profile behind'; end if;
end $$;

rollback;
