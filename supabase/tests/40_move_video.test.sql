-- move_video: ownership, channel/enabled checks, the one hard gate (compared on
-- CORE kind order, never position), stage_entered_at, the checklist snapshot,
-- the script fill and the published_at stamp.

begin;

select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

-- ------------------------------------------------------------ the gate -----
do $$
declare ok boolean := false; msg text;
begin
  -- Idea -> Scripting with nothing filled in. Scripting's kind order is past
  -- packaging, so the gate bites and the message names the missing field.
  begin
    perform public.move_video(fx.video_a(), fx.stage(fx.channel('a-main'), 'scripting'));
  exception when others then
    get stacked diagnostics msg = message_text;
    ok := true;
  end;
  if not ok then raise exception 'FAILED: moved past packaging with an empty title'; end if;
  if msg <> 'gate:title' then raise exception 'FAILED: expected gate:title, got %', msg; end if;
end $$;

do $$
declare ok boolean := false; msg text;
begin
  update public.videos set title = 'I tried X for 30 days' where id = fx.video_a();
  begin
    perform public.move_video(fx.video_a(), fx.stage(fx.channel('a-main'), 'scripting'));
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: moved past packaging with no thumbnail concept'; end if;
  if msg <> 'gate:thumbnail_concept' then
    raise exception 'FAILED: expected gate:thumbnail_concept, got %', msg;
  end if;
end $$;

do $$
declare ok boolean := false; msg text;
begin
  update public.videos set thumbnail_concept = 'Split frame, day 1 vs day 30'
   where id = fx.video_a();
  begin
    perform public.move_video(fx.video_a(), fx.stage(fx.channel('a-main'), 'scripting'));
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: moved past packaging with no hook'; end if;
  if msg <> 'gate:hook' then raise exception 'FAILED: expected gate:hook, got %', msg; end if;
end $$;

do $$
declare ok boolean := false; msg text;
begin
  -- Three hooks drafted but none chosen is still not a chosen hook.
  update public.videos
     set hooks = '[{"id":"1","text":"a","chosen":false},
                   {"id":"2","text":"b","chosen":false},
                   {"id":"3","text":"c","chosen":false}]'::jsonb
   where id = fx.video_a();
  begin
    perform public.move_video(fx.video_a(), fx.stage(fx.channel('a-main'), 'scripting'));
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: moved past packaging with no hook chosen'; end if;
  if msg <> 'gate:hook' then raise exception 'FAILED: expected gate:hook, got %', msg; end if;
end $$;

-- ------------------------------------------ the gate passes, side effects ---
do $$
declare
  before_entered timestamptz;
  v public.videos;
  n int;
begin
  select stage_entered_at into before_entered from public.videos where id = fx.video_a();

  update public.videos
     set hooks = '[{"id":"1","text":"Day 30 was not what I expected","chosen":true},
                   {"id":"2","text":"b","chosen":false}]'::jsonb
   where id = fx.video_a();

  select * into v from public.move_video(fx.video_a(), fx.stage(fx.channel('a-main'), 'scripting'));

  if v.stage_id <> fx.stage(fx.channel('a-main'), 'scripting') then
    raise exception 'FAILED: the video did not land in Scripting';
  end if;
  if v.stage_entered_at <= before_entered then
    raise exception 'FAILED: stage_entered_at was not stamped (% -> %)', before_entered, v.stage_entered_at;
  end if;

  -- The checklist template for Scripting is snapshot-copied on first entry.
  select count(*) into n from public.checklist_items ci
   where ci.video_id = fx.video_a() and ci.stage_id = fx.stage(fx.channel('a-main'), 'scripting');
  if n <> 1 then raise exception 'FAILED: expected 1 snapshotted checklist item, got %', n; end if;

  select count(*) into n from public.checklist_items ci
   where ci.video_id = fx.video_a() and ci.user_id = fx.user_a()
     and ci.text = 'Hook scripted word-for-word' and ci.est_minutes = 20 and ci.checked_at is null;
  if n <> 1 then raise exception 'FAILED: the snapshot lost text/est_minutes/user_id'; end if;

  -- The script is filled from the channel template with the chosen hook.
  if v.script is null or v.script like '%{{hook}}%' then
    raise exception 'FAILED: script was not filled from the template: %', v.script;
  end if;
  if v.script not like '%Day 30 was not what I expected%' then
    raise exception 'FAILED: the chosen hook was not substituted: %', v.script;
  end if;
end $$;

do $$
declare n int; before_script text;
begin
  -- Moving again is not a second snapshot, and does not overwrite the script.
  select script into before_script from public.videos where id = fx.video_a();
  update public.checklist_items set checked_at = now()
   where video_id = fx.video_a() and stage_id = fx.stage(fx.channel('a-main'), 'scripting');

  perform public.move_video(fx.video_a(), fx.stage(fx.channel('a-main'), 'filming'));
  perform public.move_video(fx.video_a(), fx.stage(fx.channel('a-main'), 'scripting'));

  select count(*) into n from public.checklist_items ci
   where ci.video_id = fx.video_a() and ci.stage_id = fx.stage(fx.channel('a-main'), 'scripting');
  if n <> 1 then raise exception 'FAILED: re-entering a stage re-copied the template (% items)', n; end if;

  select count(*) into n from public.checklist_items ci
   where ci.video_id = fx.video_a() and ci.checked_at is not null;
  if n <> 1 then raise exception 'FAILED: the ticked state did not survive re-entry'; end if;

  if (select script from public.videos where id = fx.video_a()) is distinct from before_script then
    raise exception 'FAILED: re-entering Scripting overwrote the script';
  end if;
end $$;

do $$
declare n int;
begin
  -- A stage the user deliberately emptied stays empty.
  --
  -- "First entry" is recorded on videos.checklist_seeded_stages, not inferred
  -- from "this stage has no rows for this video". M3 gives every row a delete
  -- button and treats a cleared list as a supported choice, so the old
  -- row-count guard silently reinstated every template row — including the ones
  -- the user had deleted because they did not apply — the next time the video
  -- came back.
  delete from public.checklist_items
   where video_id = fx.video_a() and stage_id = fx.stage(fx.channel('a-main'), 'scripting');

  select count(*) into n from public.checklist_items ci
   where ci.video_id = fx.video_a() and ci.stage_id = fx.stage(fx.channel('a-main'), 'scripting');
  if n <> 0 then raise exception 'FAILED: the Scripting list was not cleared'; end if;

  perform public.move_video(fx.video_a(), fx.stage(fx.channel('a-main'), 'filming'));
  perform public.move_video(fx.video_a(), fx.stage(fx.channel('a-main'), 'scripting'));

  select count(*) into n from public.checklist_items ci
   where ci.video_id = fx.video_a() and ci.stage_id = fx.stage(fx.channel('a-main'), 'scripting');
  if n <> 0 then
    raise exception 'FAILED: re-entering a deliberately emptied stage re-seeded it (% items)', n;
  end if;

  -- And the marker says why, rather than the row count saying it.
  if not exists (
    select 1 from public.videos
     where id = fx.video_a()
       and fx.stage(fx.channel('a-main'), 'scripting') = any (checklist_seeded_stages)
  ) then
    raise exception 'FAILED: the entry into Scripting was never recorded';
  end if;
end $$;

-- ------------------------------------------------- moves that must refuse ---
do $$
declare ok boolean := false; msg text;
begin
  -- A stage from the user's OTHER channel.
  begin
    perform public.move_video(fx.video_a(), fx.stage(fx.channel('a-side'), 'filming'));
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: a video moved into another channel''s column'; end if;
  if msg not like '%another channel%' then
    raise exception 'FAILED: expected a cross-channel refusal, got %', msg;
  end if;
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- The composite FK is the backstop for the same thing by direct SQL: only
  -- the function may write stage_id, so this runs as the table owner.
  reset role;
  begin
    update public.videos set stage_id = fx.stage(fx.channel('a-side'), 'filming')
     where id = fx.video_a();
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  set local role authenticated;
  if not ok then raise exception 'FAILED: direct SQL parked a video in another channel''s stage'; end if;
  if st <> '23503' then raise exception 'FAILED: expected 23503, got %', st; end if;
end $$;

do $$
declare ok boolean := false; msg text;
begin
  -- A disabled stage.
  update public.stages set is_enabled = false
   where channel_id = fx.channel('a-main') and kind = 'editing';
  begin
    perform public.move_video(fx.video_a(), fx.stage(fx.channel('a-main'), 'editing'));
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  update public.stages set is_enabled = true
   where channel_id = fx.channel('a-main') and kind = 'editing';
  if not ok then raise exception 'FAILED: a video moved into a disabled stage'; end if;
  if msg not like '%disabled%' then raise exception 'FAILED: expected a disabled refusal, got %', msg; end if;
end $$;

-- --------------------------------------------------------- ownership -------
reset role;
select set_config('request.jwt.claims', json_build_object('sub', fx.user_b())::text, true);
set local role authenticated;

do $$
declare ok boolean := false; msg text;
begin
  -- B calls the security definer function against A's video.
  begin
    perform public.move_video(fx.video_a(), fx.stage(fx.channel('a-main'), 'filming'));
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: B moved A''s video'; end if;
  if msg not like '%not found for this user%' then
    raise exception 'FAILED: expected the ownership check to fire, got %', msg;
  end if;
end $$;

reset role;
select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

-- ------------------------------------ gate exemptions and the publish stamp -
do $$
declare
  v_id uuid;
  v public.videos;
begin
  -- Into Packaging itself the gate does not apply (order is not past packaging).
  -- Videos are created through capture_video, which lands them in Idea.
  select id into v_id from public.capture_video(fx.channel('a-main'));

  select * into v from public.move_video(v_id, fx.stage(fx.channel('a-main'), 'packaging'));
  if v.stage_id <> fx.stage(fx.channel('a-main'), 'packaging') then
    raise exception 'FAILED: an empty video could not enter Packaging';
  end if;
  if (select count(*) from public.checklist_items where video_id = v_id) <> 2 then
    raise exception 'FAILED: the Packaging template (2 items) was not snapshotted';
  end if;

  -- An explicit skip with a reason opens the gate.
  update public.videos
     set packaging_skipped_at = now(), packaging_skip_reason = 're-upload of an old short'
   where id = v_id;

  select * into v from public.move_video(v_id, fx.stage(fx.channel('a-main'), 'scheduled'));
  if v.stage_id <> fx.stage(fx.channel('a-main'), 'scheduled') then
    raise exception 'FAILED: a skipped video was still gated';
  end if;
  if v.published_at is not null then
    raise exception 'FAILED: published_at was stamped before Published';
  end if;

  -- First entry to Published stamps published_at; confirmLive passes the
  -- scheduled date explicitly.
  select * into v from public.move_video(v_id, fx.stage(fx.channel('a-main'), 'published'),
                                         timestamptz '2026-02-03 17:00+00');
  if v.published_at <> timestamptz '2026-02-03 17:00+00' then
    raise exception 'FAILED: published_at is % , expected the passed date', v.published_at;
  end if;

  -- Re-entering Published does not re-stamp it.
  perform public.move_video(v_id, fx.stage(fx.channel('a-main'), 'repurposed'));
  select * into v from public.move_video(v_id, fx.stage(fx.channel('a-main'), 'published'));
  if v.published_at <> timestamptz '2026-02-03 17:00+00' then
    raise exception 'FAILED: published_at was re-stamped on re-entry';
  end if;
end $$;

do $$
declare v_id uuid; v public.videos;
begin
  -- An inert stage (kind null) has no order, so it is never gated.
  select id into v_id from public.capture_video(fx.channel('a-main'));

  select * into v from public.move_video(
    v_id, (select id from public.stages
            where channel_id = fx.channel('a-main') and kind is null limit 1));
  if v.stage_id is null then raise exception 'FAILED: could not move into an inert stage'; end if;
end $$;

rollback;
