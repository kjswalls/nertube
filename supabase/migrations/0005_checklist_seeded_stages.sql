-- `videos.checklist_seeded_stages`: which stages this video has already entered.
--
-- PLAN.md open question 2 settles that checklist templates are snapshot-copied
-- on **first entry** to a stage. The guard implementing that in 0001_init.sql
-- infers "first entry" from a row count:
--
--   and not exists (select 1 from public.checklist_items ci
--                    where ci.video_id = p_video and ci.stage_id = p_stage)
--
-- which is a different sentence. "This stage has no rows for this video" and
-- "this video has never been here" agree right up until somebody empties a list
-- on purpose — and M3 makes that a supported, deliberate choice: every row has
-- a delete button, and `components/checklist/checklist-list.tsx` answers an
-- empty list with *"This stage has no checklist. Add what this one actually
-- needs…"*. Under the old guard, a user who cleared Packaging because those
-- eight rows did not apply to this video, moved it on and later moved it back,
-- got all eight of them silently reinstated. The UI invited a state the next
-- move quietly undid.
--
-- So entry is recorded rather than guessed. An array on the video and not a
-- `stage_entries` table because there is exactly one fact per (video, stage) —
-- "it has been here" — with no timestamp anybody reads, no second column and
-- nothing to join to: `stage_entered_at` already holds the only entry time the
-- app shows, and re-entry history is the `stage_events` table PLAN.md's review
-- log records as dropped (item 27).
--
-- Re-copying the templates on purpose is what "Reset from template" is for, and
-- that is a button the user presses.
alter table public.videos
  add column checklist_seeded_stages uuid[] not null default '{}';

-- Backfill, so this migration changes no existing video's behaviour.
--
-- A stage counts as entered if the video is in it now, or if it already holds
-- checklist rows for it — which is precisely what the old guard would have
-- answered for those rows a moment before this ran.
update public.videos v
   set checklist_seeded_stages = (
     select coalesce(array_agg(distinct s), '{}')
       from (
         select v.stage_id as s
         union
         select ci.stage_id from public.checklist_items ci where ci.video_id = v.id
       ) entered
   );

-- 0001_init.sql replaced the table-level UPDATE grant on videos with an
-- explicit column list, so a new column starts with no client UPDATE privilege
-- and stays that way unless it is named here. This one is deliberately **not**
-- granted, for the same reason `stage_id` is not: a client that could clear the
-- array could re-seed a stage it had deliberately emptied, and then the guard
-- below would be back to being advice. It is written only by `move_video` and
-- `capture_video`, which are `security definer`.

-- --------------------------------------------------- move_video(…) ---------
--
-- Unchanged except for the snapshot guard at the end, which now reads the
-- marker and writes it. Reproduced in full because `create or replace function`
-- has no way to patch a body.
create or replace function public.move_video(
  p_video uuid,
  p_stage uuid,
  p_published_at timestamptz default null
) returns public.videos
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Order of behaviour is CORE_KIND_ORDER, never stages.position.
  k_order constant text[] := array['idea','packaging','scripting','filming','editing',
                                   'publish_prep','scheduled','published','repurposed'];
  v_uid     uuid := auth.uid();
  v_video   public.videos;
  v_stage   public.stages;
  v_order   int;
  v_missing text;
  v_chosen_hooks int;
  v_script  text;
  v_result  public.videos;
begin
  select * into v_video from public.videos where id = p_video and user_id = v_uid;
  if not found then
    raise exception 'video % not found for this user', p_video;
  end if;

  select * into v_stage from public.stages where id = p_stage and user_id = v_uid;
  if not found then
    raise exception 'stage % not found for this user', p_stage;
  end if;
  if v_stage.channel_id <> v_video.channel_id then
    raise exception 'stage % belongs to another channel', p_stage;
  end if;
  if not v_stage.is_enabled then
    raise exception 'stage % is disabled', v_stage.name;
  end if;

  -- The one hard gate: into any stage after Packaging, evaluated from the
  -- fields at move time. Inert stages (kind null) have no order and no gate.
  v_order := coalesce(array_position(k_order, v_stage.kind), 0);
  if v_order > array_position(k_order, 'packaging') and v_video.packaging_skipped_at is null then
    select count(*) into v_chosen_hooks
      from jsonb_array_elements(v_video.hooks) h
      where coalesce((h ->> 'chosen')::boolean, false);
    if coalesce(v_video.title, '') = '' then
      v_missing := 'title';
    elsif coalesce(v_video.thumbnail_concept, '') = '' then
      v_missing := 'thumbnail_concept';
    elsif v_chosen_hooks <> 1 then
      v_missing := 'hook';
    end if;
    if v_missing is not null then
      raise exception 'gate:%', v_missing;
    end if;
  end if;

  -- On first entry to Scripting, fill the script from the channel template.
  if v_stage.kind = 'scripting' and v_video.script is null then
    select replace(c.script_template, '{{hook}}',
                   coalesce((select h ->> 'text'
                               from jsonb_array_elements(v_video.hooks) h
                              where coalesce((h ->> 'chosen')::boolean, false)
                              limit 1), ''))
      into v_script
      from public.channels c
     where c.id = v_video.channel_id;
  end if;

  update public.videos v
     set stage_id         = p_stage,
         stage_entered_at = now(),
         updated_at       = now(),
         script           = coalesce(v_script, v.script),
         published_at     = case
                              when v_stage.kind = 'published' and v.published_at is null
                                then coalesce(p_published_at, now())
                              else v.published_at
                            end
   where v.id = p_video and v.user_id = v_uid
   returning * into v_result;

  -- Snapshot the stage's checklist templates on **first entry** to that stage,
  -- read off the marker rather than off the row count. See the note at the top
  -- of this file. `v_video` is the row as it was before the update above, so
  -- the array is the pre-move one, which is the question being asked.
  if not (p_stage = any (v_video.checklist_seeded_stages)) then
    insert into public.checklist_items (user_id, video_id, channel_id, stage_id, text, position, est_minutes)
    select v_uid, p_video, v_video.channel_id, p_stage, t.text, t.position, t.est_minutes
      from public.checklist_templates t
     where t.stage_id = p_stage;

    update public.videos
       set checklist_seeded_stages = array_append(checklist_seeded_stages, p_stage)
     where id = p_video and user_id = v_uid
    returning * into v_result;
  end if;

  return v_result;
end;
$$;

-- ------------------------------------------------- capture_video(…) --------
--
-- Unchanged except that the Idea stage the row is created in is recorded as
-- entered, so a cleared Idea checklist is not reinstated by a later move back.
create or replace function public.capture_video(p_channel uuid, p_title text default '')
returns public.videos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_stage  uuid;
  v_result public.videos;
begin
  perform 1 from public.channels where id = p_channel and user_id = v_uid;
  if not found then
    raise exception 'channel % not found for this user', p_channel;
  end if;

  select id into v_stage
    from public.stages
   where channel_id = p_channel and kind = 'idea';
  if v_stage is null then
    raise exception 'channel % has no Idea stage', p_channel;
  end if;

  insert into public.videos (user_id, channel_id, stage_id, title, checklist_seeded_stages)
  values (v_uid, p_channel, v_stage, coalesce(p_title, ''), array[v_stage])
  returning * into v_result;

  -- Same snapshot rule as move_video: entering a stage copies its templates.
  insert into public.checklist_items (user_id, video_id, channel_id, stage_id, text, position, est_minutes)
  select v_uid, v_result.id, p_channel, v_stage, t.text, t.position, t.est_minutes
    from public.checklist_templates t
   where t.stage_id = v_stage;

  return v_result;
end;
$$;

revoke all on function public.move_video(uuid, uuid, timestamptz) from public, anon;
revoke all on function public.capture_video(uuid, text) from public, anon;
grant execute on function public.move_video(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.capture_video(uuid, text) to authenticated;
