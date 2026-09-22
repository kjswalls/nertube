-- 0008 — the settings boundary: what the screens refuse, the database refuses.
--
-- M7's review read the four settings screens against the tables behind them
-- and found the database wider than the screens in three ways. Each one is a
-- state no screen can produce, no screen can repair, and a forged request
-- (a PATCH straight at PostgREST with a real session token) can reach.
--
-- 1. **Invisible names.** Every "needs a name" rule — a stage, a bucket, a
--    template row, the script template — was `btrim(x) <> ''` in SQL and
--    `.trim().min(1)` in zod. Neither strips Unicode format characters
--    (U+200B zero-width space, U+FEFF, U+2060 …), so a name that renders as
--    nothing, or as an exact visual twin of an existing name, was accepted.
--    `has_visible_text()` below is the one rule, and every non-blank CHECK
--    in the schema now goes through it.
--
-- 2. **Columns the client could write that no screen writes.** `channels`
--    had the table-wide UPDATE grant, so `slug` and `name` — editable
--    nowhere in the app — could be blanked, leaving the channel unreachable
--    at `/c//board`; `stages.channel_id` could re-parent an inert stage into
--    another channel; a `stages` INSERT could name `kind` or `is_enabled`.
--    The grants are now the columns the screens write, and nothing else.
--
-- 3. **Rules with no floor.** `wip_threshold`, `stale_days`, `expected_ctr`,
--    `est_minutes` and `position` were bounded in zod only. The CHECKs here
--    mirror the schemas (`lib/channel-settings.ts`, `lib/checklist-templates.ts`)
--    so a forged write cannot put every column red or every card stale.
--
-- And two doors the occupancy rule left open. `set_stage_enabled` refuses to
-- switch off a stage holding non-archived videos — correct — but two writes
-- put a live video into a switched-off stage afterwards: restoring an
-- archived one (a plain `archived_at = null` PATCH), and capturing into an
-- Idea stage that had been switched off while empty. Both hide a video from
-- the board and from `/now`, which is exactly what the refusal says it
-- prevents. So:
--
-- - the Idea stage cannot be switched off at all (capture must always have a
--   column to land in), and `capture_video` refuses a disabled one as a
--   backstop against a hand-edited row;
-- - archive and restore go through `set_video_archived()`, which refuses a
--   restore into a switched-off stage, and `archived_at` leaves the client's
--   UPDATE grant so that function is the only way back onto the board.
--
-- Same shape as the other seven functions: security definer, pinned
-- search_path, owner-executed, ownership proved first.

-- ---------------------------------------------------- 1. visible text -----
--
-- Immutable, so it can sit inside a CHECK. The class is the format characters
-- that render as nothing (soft hyphen, the zero-width family, the bidi
-- controls, word joiner and the invisible operators, BOM) plus every kind of
-- space, so "has visible text" is the question the CHECK asks. The TypeScript
-- side (`lib/text.ts`) strips `\p{Cf}` — a superset — before validating, so
-- the application refuses first and this is the backstop.

create function public.has_visible_text(p_text text)
returns boolean
language sql
immutable
strict
parallel safe
as $$
  select regexp_replace(
           p_text,
           '[­؜᠎​-‏‪-‮⁠-⁤⁦-⁯﻿   -     　\s]',
           '', 'g') <> ''
$$;

revoke all on function public.has_visible_text(text) from public;
grant execute on function public.has_visible_text(text) to anon, authenticated;

-- ------------------------------------------------------- 2. the CHECKs ----

-- stages: the 0007 rule, restated through has_visible_text; and a position
-- that draws somewhere. reorder_stages writes 1..n; addStage writes max + 1.
alter table public.stages
  drop constraint stages_name_not_blank,
  add constraint stages_name_not_blank check (public.has_visible_text(name)),
  add constraint stages_position_positive check (position > 0);

-- buckets: a matrix heading that can be read; a position on the axis.
alter table public.buckets
  add constraint buckets_name_not_blank check (public.has_visible_text(name)),
  add constraint buckets_position_positive check (position > 0);

-- checklist_templates: words on the row, an estimate /now can compare against
-- ten minutes (1..480, the same bounds as EstMinutesSchema), a position.
alter table public.checklist_templates
  add constraint checklist_templates_text_not_blank check (public.has_visible_text(text)),
  add constraint checklist_templates_est_minutes_range check (est_minutes between 1 and 480),
  add constraint checklist_templates_position_positive check (position > 0);

-- channels: the address and the name are how the channel is found; the
-- script template is what every script starts from; the three numbers are
-- bounded as `lib/channel-settings.ts` bounds them.
alter table public.channels
  add constraint channels_slug_not_blank check (public.has_visible_text(slug)),
  add constraint channels_name_not_blank check (public.has_visible_text(name)),
  add constraint channels_script_template_not_blank check (public.has_visible_text(script_template)),
  add constraint channels_wip_threshold_range check (wip_threshold between 1 and 99),
  add constraint channels_stale_days_range check (stale_days between 1 and 365),
  add constraint channels_expected_ctr_range
    check (expected_ctr is null or expected_ctr between 0.01 and 100);

-- ------------------------------------------------------- 3. the grants ----

-- channels: the five columns /settings/channel edits. `slug` and `name` stay
-- with create_channel until a rename exists; `id`, `user_id`, `created_at`
-- were never anything a client should rewrite.
revoke update on public.channels from anon, authenticated;
grant update (voice_guide, script_template, wip_threshold, stale_days, expected_ctr)
  on public.channels to authenticated;

-- stages: UPDATE is the label and nothing else. 0007 kept `user_id` and
-- `channel_id` in the list; no action writes either, and a writable
-- `channel_id` let an inert stage — templates and all — be moved between the
-- user's channels past reorder_stages' bookkeeping.
revoke update on public.stages from anon, authenticated;
grant update (name) on public.stages to authenticated;

-- stages: INSERT is an inert stage at a position. `kind` is out, so an added
-- stage is always `kind null` (the partial unique already stopped a second
-- Packaging; this stops the column being named at all); `is_enabled` is out,
-- so it is always on until set_stage_enabled says otherwise.
revoke insert on public.stages from anon, authenticated;
grant insert (user_id, channel_id, name, position) on public.stages to authenticated;

-- videos: archive and restore go through set_video_archived() below. The
-- grant on videos is column-level since 0001, so a column-level revoke does
-- carve the hole here.
revoke update (archived_at) on public.videos from anon, authenticated;

-- ------------------------------------------- 4a. set_stage_enabled() ------
--
-- As 0007, plus: the Idea stage stays on. capture_video always lands in the
-- idea-kind stage, and a switched-off column that keeps receiving rows the
-- board cannot draw is a hidden inbox. Checked before occupancy, so the
-- sentence the settings row gets is about the rule, not about the count.

create or replace function public.set_stage_enabled(p_stage uuid, p_enabled boolean)
returns public.stages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_stage  public.stages;
  v_result public.stages;
  n        int;
begin
  select * into v_stage from public.stages where id = p_stage and user_id = v_uid;
  if not found then
    raise exception 'stage % not found for this user', p_stage;
  end if;

  if not p_enabled and v_stage.is_enabled then
    if v_stage.kind = 'idea' then
      raise exception 'idea stage: % is where capture lands and stays on', v_stage.name;
    end if;

    select count(*) into n
      from public.videos
     where stage_id = p_stage and archived_at is null;
    if n > 0 then
      raise exception 'occupied:%', n;
    end if;

    select count(*) into n
      from public.stages
     where channel_id = v_stage.channel_id and is_enabled and id <> p_stage;
    if n = 0 then
      raise exception 'last enabled stage: % is the only stage still switched on', v_stage.name;
    end if;
  end if;

  update public.stages
     set is_enabled = p_enabled
   where id = p_stage
  returning * into v_result;

  return v_result;
end;
$$;

-- ------------------------------------------------ 4b. capture_video() -----
--
-- As 0005, plus the disabled check move_video has always made. Unreachable
-- from the app once the rule above holds; kept because a hand-edited row is
-- the case a database rule exists for.

create or replace function public.capture_video(p_channel uuid, p_title text default '')
returns public.videos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_stage  public.stages;
  v_result public.videos;
begin
  perform 1 from public.channels where id = p_channel and user_id = v_uid;
  if not found then
    raise exception 'channel % not found for this user', p_channel;
  end if;

  select * into v_stage
    from public.stages
   where channel_id = p_channel and kind = 'idea';
  if v_stage.id is null then
    raise exception 'channel % has no Idea stage', p_channel;
  end if;
  if not v_stage.is_enabled then
    raise exception 'stage % is disabled', v_stage.name;
  end if;

  insert into public.videos (user_id, channel_id, stage_id, title, checklist_seeded_stages)
  values (v_uid, p_channel, v_stage.id, coalesce(p_title, ''), array[v_stage.id])
  returning * into v_result;

  -- Same snapshot rule as move_video: entering a stage copies its templates.
  insert into public.checklist_items (user_id, video_id, channel_id, stage_id, text, position, est_minutes)
  select v_uid, v_result.id, p_channel, v_stage.id, t.text, t.position, t.est_minutes
    from public.checklist_templates t
   where t.stage_id = v_stage.id;

  return v_result;
end;
$$;

-- ------------------------------------------- 4c. set_video_archived() -----
--
-- Archiving never moves a video, so a restore puts it back in the column it
-- left — and that column may have been switched off in between, because
-- archived videos do not count toward the occupancy refusal (PLAN.md review
-- item 10, and rightly). A restore into a switched-off stage is refused with
-- the stage's name, so the sentence the page prints can say where to go.

create function public.set_video_archived(p_video uuid, p_archived boolean)
returns public.videos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_video  public.videos;
  v_stage  public.stages;
  v_result public.videos;
begin
  select * into v_video from public.videos where id = p_video and user_id = v_uid;
  if not found then
    raise exception 'video % not found for this user', p_video;
  end if;

  if not p_archived and v_video.archived_at is not null then
    select * into v_stage from public.stages where id = v_video.stage_id;
    if not v_stage.is_enabled then
      raise exception 'stage disabled:%', v_stage.name;
    end if;
  end if;

  update public.videos
     set archived_at = case when p_archived then coalesce(archived_at, now()) else null end,
         updated_at  = now()
   where id = p_video and user_id = v_uid
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.set_stage_enabled(uuid, boolean) from public, anon;
revoke all on function public.capture_video(uuid, text) from public, anon;
revoke all on function public.set_video_archived(uuid, boolean) from public, anon;
grant execute on function public.set_stage_enabled(uuid, boolean) to authenticated;
grant execute on function public.capture_video(uuid, text) to authenticated;
grant execute on function public.set_video_archived(uuid, boolean) to authenticated;
