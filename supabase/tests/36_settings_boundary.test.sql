-- The settings boundary (0008_settings_boundary.sql): every "needs a name"
-- rule refuses an invisible name; the numbers the screens bound are bounded
-- here too; a restore into a switched-off stage is refused; capture into a
-- switched-off Idea stage is refused.

begin;

select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

-- ------------------------------------------------ has_visible_text() -----

do $$
begin
  if public.has_visible_text(E'​') then raise exception 'FAILED: a zero-width space is visible text'; end if;
  if public.has_visible_text(E'﻿⁠‍') then raise exception 'FAILED: BOM/word joiner/ZWJ count as text'; end if;
  if public.has_visible_text(E'  \t\n') then raise exception 'FAILED: whitespace counts as text'; end if;
  if public.has_visible_text('') then raise exception 'FAILED: the empty string has visible text'; end if;
  if not public.has_visible_text(E'Mo​ney') then raise exception 'FAILED: a real name was refused'; end if;
  if not public.has_visible_text('x') then raise exception 'FAILED: one letter is not visible'; end if;
end $$;

-- ------------------------------------------------- invisible names ------

-- One helper, four tables. Each write is a client write under the grant the
-- screen uses, so the CHECK is what refuses it (23514), not the grant.
do $$
declare
  probes text[] := array[E'​', E'﻿', E'  ⁠  ', E' '];
  probe text; ok boolean; st text;
begin
  foreach probe in array probes loop
    ok := false;
    begin
      update public.stages set name = probe where id = fx.stage(fx.channel('a-main'), 'filming');
    exception when others then
      get stacked diagnostics st = returned_sqlstate; ok := true;
    end;
    if not ok then raise exception 'FAILED: a stage was renamed to an invisible name'; end if;
    if st <> '23514' then raise exception 'FAILED: expected 23514 on an invisible stage name, got %', st; end if;

    ok := false;
    begin
      insert into public.buckets (channel_id, axis, name, position)
      values (fx.channel('a-main'), 'vertical', probe, 50);
    exception when others then
      get stacked diagnostics st = returned_sqlstate; ok := true;
    end;
    if not ok then raise exception 'FAILED: a bucket with an invisible name was inserted'; end if;
    if st <> '23514' then raise exception 'FAILED: expected 23514 on an invisible bucket name, got %', st; end if;

    ok := false;
    begin
      insert into public.checklist_templates (stage_id, text, position, est_minutes)
      values (fx.stage(fx.channel('a-main'), 'packaging'), probe, 50, 5);
    exception when others then
      get stacked diagnostics st = returned_sqlstate; ok := true;
    end;
    if not ok then raise exception 'FAILED: a template row with invisible text was inserted'; end if;
    if st <> '23514' then raise exception 'FAILED: expected 23514 on invisible template text, got %', st; end if;

    ok := false;
    begin
      update public.channels set script_template = probe where id = fx.channel('a-main');
    exception when others then
      get stacked diagnostics st = returned_sqlstate; ok := true;
    end;
    if not ok then raise exception 'FAILED: the script template was blanked invisibly'; end if;
    if st <> '23514' then raise exception 'FAILED: expected 23514 on an invisible script template, got %', st; end if;
  end loop;

  -- Positive controls: the same writes with visible text land.
  update public.stages set name = E'Filming​' where id = fx.stage(fx.channel('a-main'), 'filming');
  insert into public.buckets (channel_id, axis, name, position)
  values (fx.channel('a-main'), 'vertical', 'gear', 50);
  insert into public.checklist_templates (stage_id, text, position, est_minutes)
  values (fx.stage(fx.channel('a-main'), 'packaging'), 'A real row', 50, 5);
  update public.channels set script_template = '## Hook' where id = fx.channel('a-main');
end $$;

-- ------------------------------------------------------ the floors ------

do $$
declare
  stmts text[] := array[
    format('update public.channels set wip_threshold = 0 where id = %L', fx.channel('a-main')),
    format('update public.channels set wip_threshold = 100 where id = %L', fx.channel('a-main')),
    format('update public.channels set stale_days = 0 where id = %L', fx.channel('a-main')),
    format('update public.channels set stale_days = 366 where id = %L', fx.channel('a-main')),
    format('update public.channels set expected_ctr = 0 where id = %L', fx.channel('a-main')),
    format('update public.channels set expected_ctr = 100.5 where id = %L', fx.channel('a-main')),
    format('insert into public.checklist_templates (stage_id, text, position, est_minutes) values (%L, ''x'', 60, 0)',
           fx.stage(fx.channel('a-main'), 'packaging')),
    format('insert into public.checklist_templates (stage_id, text, position, est_minutes) values (%L, ''x'', 61, 481)',
           fx.stage(fx.channel('a-main'), 'packaging')),
    format('insert into public.checklist_templates (stage_id, text, position, est_minutes) values (%L, ''x'', 0, 5)',
           fx.stage(fx.channel('a-main'), 'packaging')),
    format('insert into public.buckets (channel_id, axis, name, position) values (%L, ''vertical'', ''zero'', 0)',
           fx.channel('a-main')),
    format('insert into public.stages (channel_id, name, position) values (%L, ''Forged neg'', -7)',
           fx.channel('a-main'))
  ];
  stmt text; ok boolean; st text;
begin
  foreach stmt in array stmts loop
    ok := false;
    begin
      execute stmt;
    exception when others then
      get stacked diagnostics st = returned_sqlstate; ok := true;
    end;
    if not ok then raise exception 'FAILED: accepted: %', stmt; end if;
    if st <> '23514' then raise exception 'FAILED: expected 23514 for [%], got %', stmt, st; end if;
  end loop;

  -- The bounds are inclusive: what the screens allow, the database allows.
  update public.channels set wip_threshold = 99, stale_days = 365, expected_ctr = 0.01
   where id = fx.channel('a-main');
  update public.channels set wip_threshold = 1, stale_days = 1, expected_ctr = 100
   where id = fx.channel('a-main');
  update public.channels set expected_ctr = null where id = fx.channel('a-main');
  insert into public.checklist_templates (stage_id, text, position, est_minutes)
  values (fx.stage(fx.channel('a-main'), 'packaging'), 'one minute', 70, 1),
         (fx.stage(fx.channel('a-main'), 'packaging'), 'a working day', 71, 480);
end $$;

-- --------------------------------------------- set_video_archived() -----

do $$
declare v public.videos; ok boolean := false; msg text; s public.stages;
begin
  -- Archive, restore: the row and nothing else about it.
  select * into v from public.set_video_archived(fx.video_a(), true);
  if v.archived_at is null then raise exception 'FAILED: archive did not stamp archived_at'; end if;
  if v.updated_at is null then raise exception 'FAILED: archive did not touch updated_at'; end if;
  select * into v from public.set_video_archived(fx.video_a(), false);
  if v.archived_at is not null then raise exception 'FAILED: restore did not clear archived_at'; end if;
  if v.stage_id <> fx.stage(fx.channel('a-main'), 'idea') then
    raise exception 'FAILED: archiving moved the video';
  end if;

  -- Archiving twice keeps the first stamp.
  select * into v from public.set_video_archived(fx.video_a(), true);
  perform pg_sleep(0.01);
  if (select archived_at from public.set_video_archived(fx.video_a(), true)) <> v.archived_at then
    raise exception 'FAILED: a second archive re-stamped archived_at';
  end if;
  perform public.set_video_archived(fx.video_a(), false);
end $$;

-- archive -> switch the stage off -> restore: the door the review found.
do $$
declare
  p uuid := fx.stage(fx.channel('a-main'), 'packaging');
  v public.videos; s public.stages; ok boolean := false; msg text;
begin
  perform public.move_video(fx.video_a(), p);
  perform public.set_video_archived(fx.video_a(), true);
  -- Allowed: archived videos do not count (PLAN.md review item 10).
  select * into s from public.set_stage_enabled(p, false);
  if s.is_enabled then raise exception 'FAILED: Packaging did not switch off'; end if;

  begin
    perform public.set_video_archived(fx.video_a(), false);
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: a video was restored into a switched-off stage'; end if;
  if msg <> 'stage disabled:Packaging (TTH)' then
    raise exception 'FAILED: expected "stage disabled:Packaging (TTH)", got %', msg;
  end if;
  select * into v from public.videos where id = fx.video_a();
  if v.archived_at is null then raise exception 'FAILED: a refused restore still cleared archived_at'; end if;

  -- Switch the stage back on and the same restore lands.
  perform public.set_stage_enabled(p, true);
  select * into v from public.set_video_archived(fx.video_a(), false);
  if v.archived_at is not null then raise exception 'FAILED: restore failed after the stage came back'; end if;
end $$;

-- Another user's video: not found, whatever the flag.
select set_config('request.jwt.claims', json_build_object('sub', fx.user_b())::text, true);
do $$
declare ok boolean := false; msg text;
begin
  begin
    perform public.set_video_archived(fx.video_a(), true);
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: user B archived user A''s video'; end if;
  if msg not like '%not found for this user%' then raise exception 'FAILED: expected not found, got %', msg; end if;
end $$;
select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);

-- ----------------------------------- capture into a switched-off Idea ----

-- set_stage_enabled refuses to switch Idea off, so the row is hand-edited by
-- the owner: the case a backstop in capture_video exists for.
reset role;
update public.stages set is_enabled = false where id = fx.stage(fx.channel('a-side'), 'idea');
set local role authenticated;

do $$
declare ok boolean := false; msg text; n int;
begin
  begin
    perform public.capture_video(fx.channel('a-side'), 'ghost idea');
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: a video was captured into a switched-off Idea stage'; end if;
  if msg <> 'stage Idea is disabled' then raise exception 'FAILED: expected "stage Idea is disabled", got %', msg; end if;
  select count(*) into n from public.videos where title = 'ghost idea';
  if n <> 0 then raise exception 'FAILED: the refused capture wrote a row'; end if;

  -- And the switch back on is the one thing set_stage_enabled allows for Idea.
  perform public.set_stage_enabled(fx.stage(fx.channel('a-side'), 'idea'), true);
  perform public.capture_video(fx.channel('a-side'), 'real idea');
  select count(*) into n from public.videos where title = 'real idea';
  if n <> 1 then raise exception 'FAILED: capture into the re-enabled Idea stage did not land'; end if;
end $$;

rollback;
