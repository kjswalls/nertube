-- The stage settings (0007_stage_settings.sql): reorder_stages refuses a core
-- crossing and a forged list and writes the order in one statement;
-- set_stage_enabled refuses an occupied stage (archived videos not counting)
-- and the last enabled one; position and is_enabled are no longer client
-- columns, and a stage cannot be nameless.

begin;

select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

-- ---------------------------------------------------------- the grant -----

do $$
declare ok boolean; st text;
begin
  ok := false;
  begin
    update public.stages set position = 99
     where id = fx.stage(fx.channel('a-main'), 'repurposed');
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a client wrote stages.position directly'; end if;
  if st <> '42501' then raise exception 'FAILED: expected 42501 on position, got %', st; end if;

  ok := false;
  begin
    update public.stages set is_enabled = false
     where id = fx.stage(fx.channel('a-main'), 'repurposed');
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a client wrote stages.is_enabled directly'; end if;
  if st <> '42501' then raise exception 'FAILED: expected 42501 on is_enabled, got %', st; end if;
end $$;

-- Positive control: the label is still the client's to change.
do $$
declare n int; ok boolean := false; st text;
begin
  update public.stages set name = 'Packaging & hook'
   where id = fx.stage(fx.channel('a-main'), 'packaging');
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: a core stage could not be renamed'; end if;

  -- ... but not to nothing.
  begin
    update public.stages set name = '   '
     where id = fx.stage(fx.channel('a-main'), 'packaging');
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a stage was renamed to blank'; end if;
  if st <> '23514' then raise exception 'FAILED: expected 23514 on a blank name, got %', st; end if;
end $$;

-- ------------------------------------------------------ reorder_stages -----

-- The fixture's a-main: nine core stages at 1..9 and the inert "Sponsor
-- review" at 10. Moving the inert one between Filming (4) and Editing (5) is
-- the move settings offers; it lands at 5 and everything after it shifts.
do $$
declare
  c uuid := fx.channel('a-main');
  ids uuid[];
  inert uuid;
  n int;
begin
  select id into inert from public.stages where channel_id = c and kind is null;
  select array_agg(id order by position) into ids
    from public.stages where channel_id = c and kind is not null;
  ids := ids[1:4] || inert || ids[5:9];

  perform public.reorder_stages(c, ids);

  select position into n from public.stages where id = inert;
  if n <> 5 then raise exception 'FAILED: the inert stage should be at 5, is at %', n; end if;
  select position into n from public.stages where id = fx.stage(c, 'editing');
  if n <> 6 then raise exception 'FAILED: Editing should have shifted to 6, is at %', n; end if;
  select position into n from public.stages where id = fx.stage(c, 'filming');
  if n <> 4 then raise exception 'FAILED: Filming should still be at 4, is at %', n; end if;

  -- A permutation of 1..10, so the deferred unique holds at commit.
  set constraints all immediate;
  select count(distinct position) into n from public.stages where channel_id = c;
  if n <> 10 then raise exception 'FAILED: positions are not distinct after the reorder'; end if;
  select max(position) into n from public.stages where channel_id = c;
  if n <> 10 then raise exception 'FAILED: positions do not run 1..10 (max %)', n; end if;
  set constraints all deferred;
end $$;

-- A core stage across another core stage: refused, and nothing moved.
do $$
declare
  c uuid := fx.channel('a-main');
  ids uuid[];
  a uuid := fx.stage(c, 'filming');
  b uuid := fx.stage(c, 'editing');
  before_a int; before_b int; after_a int; after_b int;
  ok boolean := false; msg text;
begin
  select position into before_a from public.stages where id = a;
  select position into before_b from public.stages where id = b;

  select array_agg(id order by position) into ids from public.stages where channel_id = c;
  -- Swap Filming and Editing in the list.
  ids := array_replace(array_replace(array_replace(ids, a, '00000000-0000-0000-0000-000000000000'::uuid), b, a),
                       '00000000-0000-0000-0000-000000000000'::uuid, b);

  begin
    perform public.reorder_stages(c, ids);
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: Editing was carried across Filming'; end if;
  if msg not like 'core order:%' then
    raise exception 'FAILED: expected a core order refusal, got %', msg;
  end if;

  select position into after_a from public.stages where id = a;
  select position into after_b from public.stages where id = b;
  if after_a <> before_a or after_b <> before_b then
    raise exception 'FAILED: a refused reorder moved something';
  end if;
end $$;

-- An incomplete list, a list with a foreign stage in it, and another user's
-- channel: all refused.
do $$
declare
  c uuid := fx.channel('a-main');
  ids uuid[];
  ok boolean; msg text;
begin
  select array_agg(id order by position) into ids from public.stages where channel_id = c;

  ok := false;
  begin
    perform public.reorder_stages(c, ids[1:9]);
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: an incomplete list was accepted'; end if;
  if msg not like 'order:incomplete%' then raise exception 'FAILED: expected order:incomplete, got %', msg; end if;

  ok := false;
  begin
    -- Nine of a-main's stages plus one of a-side's: same length, wrong set.
    perform public.reorder_stages(c, ids[1:9] || fx.stage(fx.channel('a-side'), 'idea'));
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: a foreign stage id was accepted'; end if;
  if msg not like 'order:foreign%' then raise exception 'FAILED: expected order:foreign, got %', msg; end if;

  ok := false;
  begin
    -- A repeated id in place of a missing one: same length, still wrong.
    perform public.reorder_stages(c, ids[1:9] || ids[1]);
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: a list with a duplicate was accepted'; end if;
  if msg not like 'order:foreign%' then raise exception 'FAILED: expected order:foreign for a duplicate, got %', msg; end if;
end $$;

-- User B cannot reorder A's channel, even with A's real ids.
select set_config('request.jwt.claims', json_build_object('sub', fx.user_b())::text, true);
do $$
declare ids uuid[]; ok boolean := false; msg text;
begin
  select array_agg(id order by position) into ids from public.stages where channel_id = fx.channel('a-main');
  begin
    perform public.reorder_stages(fx.channel('a-main'), ids);
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: user B reordered user A''s stages'; end if;
  if msg not like '%not found for this user%' then raise exception 'FAILED: expected not found, got %', msg; end if;
end $$;
select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);

-- --------------------------------------------------- set_stage_enabled -----

-- An empty lane switches off and back on.
do $$
declare s public.stages;
begin
  select * into s from public.set_stage_enabled(fx.stage(fx.channel('a-main'), 'repurposed'), false);
  if s.is_enabled then raise exception 'FAILED: Repurposed did not switch off'; end if;
  select * into s from public.set_stage_enabled(fx.stage(fx.channel('a-main'), 'repurposed'), true);
  if not s.is_enabled then raise exception 'FAILED: Repurposed did not switch back on'; end if;
end $$;

-- An occupied one is refused, with the count; archiving the video clears it.
do $$
declare ok boolean := false; msg text; s public.stages;
begin
  -- video_a is in a-main's Idea stage.
  begin
    perform public.set_stage_enabled(fx.stage(fx.channel('a-main'), 'idea'), false);
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: an occupied stage was switched off'; end if;
  if msg <> 'occupied:1' then raise exception 'FAILED: expected occupied:1, got %', msg; end if;

  select * into s from public.stages where id = fx.stage(fx.channel('a-main'), 'idea');
  if not s.is_enabled then raise exception 'FAILED: a refused switch-off still wrote'; end if;

  -- Archived videos do not count (PLAN.md review item 10).
  update public.videos set archived_at = now() where id = fx.video_a();
  select * into s from public.set_stage_enabled(fx.stage(fx.channel('a-main'), 'idea'), false);
  if s.is_enabled then raise exception 'FAILED: an archived video blocked the switch'; end if;
  select * into s from public.set_stage_enabled(fx.stage(fx.channel('a-main'), 'idea'), true);
  update public.videos set archived_at = null where id = fx.video_a();
end $$;

-- The last enabled stage stays on.
do $$
declare
  c uuid := fx.channel('a-side');
  r record; ok boolean := false; msg text; n int;
begin
  -- a-side holds no videos, so everything but Idea can go.
  for r in select id from public.stages where channel_id = c and kind <> 'idea' loop
    perform public.set_stage_enabled(r.id, false);
  end loop;
  select count(*) into n from public.stages where channel_id = c and is_enabled;
  if n <> 1 then raise exception 'FAILED: expected 1 enabled stage left, got %', n; end if;

  begin
    perform public.set_stage_enabled(fx.stage(c, 'idea'), false);
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: the last enabled stage was switched off'; end if;
  if msg not like 'last enabled stage%' then raise exception 'FAILED: expected last enabled stage, got %', msg; end if;
end $$;

-- Another user's stage: not found, not refused-with-a-count.
select set_config('request.jwt.claims', json_build_object('sub', fx.user_b())::text, true);
do $$
declare ok boolean := false; msg text;
begin
  begin
    perform public.set_stage_enabled(fx.stage(fx.channel('a-main'), 'repurposed'), false);
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: user B switched off user A''s stage'; end if;
  if msg not like '%not found for this user%' then raise exception 'FAILED: expected not found, got %', msg; end if;
end $$;

rollback;
