-- Fixture shared by every later *.test.sql, plus assertions that the seed
-- shape the app relies on is actually expressible.
--
-- This file COMMITS: it is the only test file that leaves rows behind. Every
-- other file runs inside begin/rollback, so the fixture stays pristine.
--
-- Two users. User A has two channels (a-main, a-side) and one video; user B has
-- one channel and one video. Everything here is inserted as the database owner,
-- which bypasses RLS on purpose — the fixture is the "already existing data"
-- that the policy tests then try to reach across.

create schema fx;

create function fx.user_a() returns uuid language sql immutable
  as $$ select 'a0000000-0000-4000-8000-00000000000a'::uuid $$;
create function fx.user_b() returns uuid language sql immutable
  as $$ select 'b0000000-0000-4000-8000-00000000000b'::uuid $$;
create function fx.video_a() returns uuid language sql immutable
  as $$ select 'd0000000-0000-4000-8000-0000000000da'::uuid $$;
create function fx.video_b() returns uuid language sql immutable
  as $$ select 'd0000000-0000-4000-8000-0000000000db'::uuid $$;

-- security definer so a test running as `authenticated` can still look up ids
-- it is not allowed to SELECT; the helper is harness plumbing, not app code.
create function fx.channel(p_slug text) returns uuid
  language sql stable security definer set search_path = public
  as $$ select id from public.channels where slug = p_slug $$;

create function fx.stage(p_channel uuid, p_kind text) returns uuid
  language sql stable security definer set search_path = public
  as $$ select id from public.stages where channel_id = p_channel and kind = p_kind $$;

create function fx.bucket(p_channel uuid, p_axis text, p_name text) returns uuid
  language sql stable security definer set search_path = public
  as $$ select id from public.buckets
        where channel_id = p_channel and axis = p_axis and name = p_name $$;

grant usage on schema fx to anon, authenticated, service_role;
grant execute on all functions in schema fx to anon, authenticated, service_role;

insert into auth.users (id, email) values
  (fx.user_a(), 'a@example.test'),
  (fx.user_b(), 'b@example.test');

insert into public.channels (id, user_id, name, slug, script_template, expected_ctr) values
  ('c1000000-0000-4000-8000-0000000000c1', fx.user_a(), 'A Main', 'a-main',
   E'## Hook (verbatim)\n{{hook}}\nB-roll:\n\n## Body (bullets)\nStructure:\nB-roll:\n\n## End screen -> [named video]\n', 6.00),
  ('c2000000-0000-4000-8000-0000000000c2', fx.user_a(), 'A Side', 'a-side',
   E'## Hook (verbatim)\n{{hook}}\n', null),
  ('cb000000-0000-4000-8000-0000000000cb', fx.user_b(), 'B Main', 'b-main',
   E'## Hook (verbatim)\n{{hook}}\n', null);

-- The nine seed stages, positions 1-9, for each channel.
do $$
declare
  kinds text[] := array['idea','packaging','scripting','filming','editing',
                        'publish_prep','scheduled','published','repurposed'];
  names text[] := array['Idea','Packaging (TTH)','Scripting','Filming','Editing',
                        'Publish Prep','Scheduled','Published','Repurposed'];
  c record;
  i int;
begin
  for c in select id, user_id from public.channels loop
    for i in 1 .. array_length(kinds, 1) loop
      insert into public.stages (user_id, channel_id, name, position, kind)
      values (c.user_id, c.id, names[i], i, kinds[i]);
    end loop;
  end loop;
end $$;

-- One inert, user-added stage on a-main (kind null, so it is deletable).
insert into public.stages (user_id, channel_id, name, position, kind)
values (fx.user_a(), fx.channel('a-main'), 'Sponsor review', 10, null);

insert into public.buckets (user_id, channel_id, axis, name, position, monthly_quota) values
  (fx.user_a(), fx.channel('a-main'), 'vertical',   'money',    1, 2),
  (fx.user_a(), fx.channel('a-main'), 'horizontal', 'tutorial', 1, null),
  (fx.user_a(), fx.channel('a-side'), 'vertical',   'gear',     1, null),
  (fx.user_b(), fx.channel('b-main'), 'vertical',   'money',    1, null);

insert into public.checklist_templates (user_id, stage_id, text, position, est_minutes) values
  (fx.user_a(), fx.stage(fx.channel('a-main'), 'packaging'), 'Generated 10-20 title candidates, not 3', 1, 15),
  (fx.user_a(), fx.stage(fx.channel('a-main'), 'packaging'), 'Searched YouTube for this topic', 2, 15),
  (fx.user_a(), fx.stage(fx.channel('a-main'), 'scripting'), 'Hook scripted word-for-word', 1, 20);

insert into public.videos (id, user_id, channel_id, stage_id, title) values
  (fx.video_a(), fx.user_a(), fx.channel('a-main'), fx.stage(fx.channel('a-main'), 'idea'), ''),
  (fx.video_b(), fx.user_b(), fx.channel('b-main'), fx.stage(fx.channel('b-main'), 'idea'), '');

insert into public.filming_days (user_id, on_date, notes)
values (fx.user_a(), date '2026-01-10', 'batch day');

do $$
declare n int;
begin
  select count(*) into n from public.stages where channel_id = fx.channel('a-main');
  if n <> 10 then
    raise exception 'fixture: expected 10 stages on a-main (9 core + 1 inert), got %', n;
  end if;

  select count(*) into n from public.videos;
  if n <> 2 then raise exception 'fixture: expected 2 videos, got %', n; end if;

  -- The seeded script template must carry the placeholder move_video replaces.
  select count(*) into n from public.channels
   where slug = 'a-main' and script_template like '%{{hook}}%';
  if n <> 1 then raise exception 'fixture: a-main script_template lost its {{hook}} placeholder'; end if;

  -- Defaults from PLAN.md: wip_threshold 5, stale_days 7, voice_guide null.
  select count(*) into n from public.channels
   where slug = 'a-main' and wip_threshold = 5 and stale_days = 7 and voice_guide is null;
  if n <> 1 then raise exception 'fixture: channel defaults are wrong'; end if;
end $$;
