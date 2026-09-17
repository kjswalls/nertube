-- NerTube — full schema (M0).
--
-- Everything in PLAN.md's "Data model" section: tables, CHECKs, composite
-- tenant FKs, RLS policies, the column privileges that make the SQL functions
-- the only write path for stage/shipped-role changes, the private thumbnails
-- bucket and its policy, and the two plpgsql functions that own the
-- multi-row invariants (supabase-js has no transactions).
--
-- Conventions on every table: id uuid pk, user_id uuid not null default
-- auth.uid() references auth.users, created_at timestamptz not null default
-- now(). Enumerations are text + check. Only constraint-backed indexes.
--
-- Tenant binding: FK checks bypass RLS, so a second tenant could otherwise
-- occupy another tenant's unique slots by pointing a child row at a parent it
-- cannot see. Every parent therefore carries unique (id, user_id) and every
-- child FK is composite on the tenant column.

-- ---------------------------------------------------------------- channels --

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  name text not null,
  slug text not null,
  voice_guide text,
  script_template text not null,
  wip_threshold int not null default 5,
  stale_days int not null default 7,
  expected_ctr numeric(5,2),
  unique (user_id, slug),
  unique (id, user_id)
);

-- ------------------------------------------------------------------ stages --

create table public.stages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  channel_id uuid not null,
  name text not null,
  position int not null,
  -- null kind = a user-added, inert stage. Behaviour binds to kind (and to
  -- CORE_KIND_ORDER in code), never to position.
  kind text check (kind in ('idea','packaging','scripting','filming','editing',
                            'publish_prep','scheduled','published','repurposed')),
  is_enabled boolean not null default true,
  foreign key (channel_id, user_id) references public.channels (id, user_id) on delete cascade,
  unique (id, channel_id),
  unique (id, user_id),
  -- Position swaps run as one `update … set position = case …` statement.
  constraint stages_channel_id_position_key unique (channel_id, position) deferrable initially deferred
);

-- One canonical stage per kind per channel; inert stages are unconstrained.
create unique index stages_channel_id_kind_key on public.stages (channel_id, kind) where kind is not null;

-- ----------------------------------------------------------------- buckets --

create table public.buckets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  channel_id uuid not null,
  axis text not null check (axis in ('vertical','horizontal')),
  name text not null,
  position int not null,
  monthly_quota int check (monthly_quota > 0),
  foreign key (channel_id, user_id) references public.channels (id, user_id) on delete cascade,
  unique (channel_id, axis, name),
  unique (id, channel_id, axis),
  unique (id, user_id),
  constraint buckets_channel_id_axis_position_key unique (channel_id, axis, position) deferrable initially deferred
);

-- ------------------------------------------------------------ filming_days --

-- User-level and cross-channel: one creator, one camera.
create table public.filming_days (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  on_date date not null,
  notes text,
  unique (user_id, on_date),
  unique (id, user_id)
);

-- ------------------------------------------------------------------ videos --

-- Ideas included: an idea is a video in the Idea stage.
create table public.videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  channel_id uuid not null,
  stage_id uuid not null,
  stage_entered_at timestamptz not null default now(),
  updated_at timestamptz,

  -- packaging (TTH)
  title text not null default '',
  title_candidates jsonb not null default '[]',   -- [{id,text,note,chosen,source:'manual'|'ai'}]
  thumbnail_concept text,
  thumbnail_concept_path text,
  hooks jsonb not null default '[]',              -- [{id,text,chosen}]
  packaging_skipped_at timestamptz,
  packaging_skip_reason text,

  -- scripting (B-roll lives in the script template's `B-roll:` lines)
  script text,
  script_structure text check (script_structure in ('listicle','three_part','story_arc')),
  end_screen_target text,

  -- idea bank
  one_line_hook text,
  notes text,
  tags text[] not null default '{}',
  vertical_id uuid,
  horizontal_id uuid,
  -- Pinned axis columns: they exist only to be the third leg of the bucket FKs,
  -- so a video can reference only its own channel's bucket of the right axis.
  -- PLAN.md specifies `generated always as (…) stored`; Postgres 16 refuses
  -- `on delete set null` on any FK containing a generated column (even with the
  -- set-null column list), so they are plain columns pinned by a CHECK, which
  -- is the same guarantee.
  vertical_axis text not null default 'vertical' check (vertical_axis = 'vertical'),
  horizontal_axis text not null default 'horizontal' check (horizontal_axis = 'horizontal'),

  -- flow
  waiting_on text,
  filming_day_id uuid,
  target_publish_date date,
  archived_at timestamptz,

  -- thumbnails: three slots, not a list
  thumb_wild_card_path text,
  thumb_moderate_path text,
  thumb_safe_path text,
  shipped_role text check (shipped_role in ('wild_card','moderate','safe')),

  -- publish
  youtube_url text,
  published_at timestamptz,

  -- post-publish
  first24_impressions int check (first24_impressions >= 0),
  first24_ctr numeric(5,2) check (first24_ctr between 0 and 100),
  first24_views int check (first24_views >= 0),
  new_viewers_note text,
  metrics_logged_at timestamptz,
  swap_dismissed_at timestamptz,

  -- most recent brainstorm result, so closing the panel loses nothing
  brainstorm_last jsonb,

  unique (id, user_id),
  -- Composite-FK target: checklist_items binds to (video_id, channel_id) so an
  -- item can never name a stage from a different channel than its video.
  unique (id, channel_id),

  foreign key (channel_id, user_id) references public.channels (id, user_id) on delete cascade,
  foreign key (stage_id, user_id) references public.stages (id, user_id),
  -- a video can never sit in another channel's column
  foreign key (stage_id, channel_id) references public.stages (id, channel_id) on delete no action,
  foreign key (vertical_id, channel_id, vertical_axis)
    references public.buckets (id, channel_id, axis) on delete set null (vertical_id),
  foreign key (horizontal_id, channel_id, horizontal_axis)
    references public.buckets (id, channel_id, axis) on delete set null (horizontal_id),
  foreign key (filming_day_id, user_id)
    references public.filming_days (id, user_id) on delete set null (filming_day_id),

  constraint videos_title_candidates_is_array check (jsonb_typeof(title_candidates) = 'array'),
  constraint videos_hooks_is_array_max_3
    check (jsonb_typeof(hooks) = 'array' and jsonb_array_length(hooks) <= 3),
  -- a skip has a reason and a reason has a skip
  constraint videos_packaging_skip_paired
    check ((packaging_skipped_at is null) = (packaging_skip_reason is null)),
  constraint videos_packaging_skip_reason_not_blank check (packaging_skip_reason <> ''),
  -- the shipped role always has an asset
  constraint videos_shipped_role_has_asset check (
    shipped_role is null
    or (shipped_role = 'wild_card' and thumb_wild_card_path is not null)
    or (shipped_role = 'moderate'  and thumb_moderate_path  is not null)
    or (shipped_role = 'safe'      and thumb_safe_path      is not null)
  ),
  -- CTR never exists without impressions
  constraint videos_ctr_needs_impressions
    check ((first24_impressions is null) = (first24_ctr is null))
);

-- ----------------------------------------------------- checklist_templates --

-- No channel_id: the stage implies it.
create table public.checklist_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  stage_id uuid not null,
  text text not null,
  position int not null,
  est_minutes int not null,
  foreign key (stage_id, user_id) references public.stages (id, user_id) on delete cascade,
  constraint checklist_templates_stage_id_position_key unique (stage_id, position) deferrable initially deferred
);

-- --------------------------------------------------------- checklist_items --

-- Snapshot-copied from the templates on first entry to a stage (see
-- move_video). addChecklistItem inserts at the top (position = min - 1), so a
-- custom item is immediately the next action.
--
-- channel_id is not in PLAN.md's column list. It is here for the same reason
-- videos carries the composite (stage_id, channel_id) FK: the two tenant FKs
-- below stop another tenant's rows being named, but within one tenant nothing
-- otherwise stopped an item on a video in channel A from naming a stage in
-- channel B, which the stage checklist on /videos/[id] and the next-action
-- derivation on /now would then surface in the wrong channel. Binding both legs
-- to the same channel is the declarative fix.
create table public.checklist_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  video_id uuid not null,
  channel_id uuid not null,
  stage_id uuid not null,
  text text not null,
  position int not null,
  est_minutes int,          -- null reads as 10
  checked_at timestamptz,
  foreign key (video_id, user_id) references public.videos (id, user_id) on delete cascade,
  foreign key (stage_id, user_id) references public.stages (id, user_id) on delete no action,
  foreign key (video_id, channel_id) references public.videos (id, channel_id) on delete cascade,
  foreign key (stage_id, channel_id) references public.stages (id, channel_id) on delete no action
);

-- --------------------------------------------------------- thumbnail_swaps --

-- Append-only log.
create table public.thumbnail_swaps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  video_id uuid not null,
  from_role text,
  to_role text not null,
  reason text not null check (reason <> ''),
  swapped_at timestamptz not null default now(),
  foreign key (video_id, user_id) references public.videos (id, user_id) on delete cascade,
  constraint thumbnail_swaps_roles check (
    to_role in ('wild_card','moderate','safe')
    and (from_role is null or from_role in ('wild_card','moderate','safe'))
    and from_role is distinct from to_role
  )
);

-- --------------------------------------------------------------------- RLS --

alter table public.channels            enable row level security;
alter table public.stages              enable row level security;
alter table public.buckets             enable row level security;
alter table public.filming_days        enable row level security;
alter table public.videos              enable row level security;
alter table public.checklist_templates enable row level security;
alter table public.checklist_items     enable row level security;
alter table public.thumbnail_swaps     enable row level security;

-- Default: own your rows, join-free.
create policy buckets_owner on public.buckets
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy filming_days_owner on public.filming_days
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy videos_owner on public.videos
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy checklist_templates_owner on public.checklist_templates
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy checklist_items_owner on public.checklist_items
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Exception 3: thumbnail_swaps is the append-only log the detail page renders.
-- Select and insert only — no update or delete policy, so a past swap's reason
-- cannot be rewritten and the history cannot be erased.
create policy thumbnail_swaps_select on public.thumbnail_swaps
  for select using (user_id = auth.uid());
create policy thumbnail_swaps_insert on public.thumbnail_swaps
  for insert with check (user_id = auth.uid());

-- Exception 1: channels have no delete policy in v1.
create policy channels_select on public.channels
  for select using (user_id = auth.uid());
create policy channels_insert on public.channels
  for insert with check (user_id = auth.uid());
create policy channels_update on public.channels
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Exception 2: core stages (kind not null) cannot be deleted from any client.
create policy stages_select on public.stages
  for select using (user_id = auth.uid());
create policy stages_insert on public.stages
  for insert with check (user_id = auth.uid());
create policy stages_update on public.stages
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy stages_delete on public.stages
  for delete using (user_id = auth.uid() and kind is null);

-- --------------------------------------------------------- privileges ------

-- Supabase's default grants give anon, authenticated and service_role ALL
-- privileges on every table in public, and ALL includes TRUNCATE, REFERENCES
-- and TRIGGER. RLS does not apply to TRUNCATE: a client holding that privilege
-- empties a table for every tenant in one statement, policies or no policies.
-- PostgREST emits no verb that reaches TRUNCATE today, so this is a latent
-- privilege rather than a live exploit — but it is one the untrusted roles have
-- no use for, and it would survive any future direct-SQL or Realtime path.
revoke truncate, references, trigger on all tables in schema public
  from anon, authenticated;
alter default privileges in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;

-- ------------------------------------------------- column privileges (videos)

-- PLAN.md: `revoke update (stage_id, stage_entered_at, published_at,
-- shipped_role) on videos from authenticated` — those columns are written only
-- by move_video/swap_thumbnail. Supabase's default privileges grant table-level
-- UPDATE, which implies every column, and a column-level REVOKE cannot carve a
-- hole in a table-level grant (Postgres silently revokes nothing). The
-- effective form is therefore: drop the table-level grant, then re-grant every
-- column except those four.
revoke update on public.videos from anon, authenticated;
grant update (
  id, user_id, created_at,
  channel_id, updated_at,
  title, title_candidates, thumbnail_concept, thumbnail_concept_path, hooks,
  packaging_skipped_at, packaging_skip_reason,
  script, script_structure, end_screen_target,
  one_line_hook, notes, tags, vertical_id, horizontal_id, vertical_axis, horizontal_axis,
  waiting_on, filming_day_id, target_publish_date, archived_at,
  thumb_wild_card_path, thumb_moderate_path, thumb_safe_path,
  youtube_url,
  first24_impressions, first24_ctr, first24_views, new_viewers_note,
  metrics_logged_at, swap_dismissed_at,
  brainstorm_last
) on public.videos to authenticated;

-- The same treatment for INSERT, which the revoke above does not cover. Without
-- it a client simply creates a video that is already in the Published stage,
-- with an empty title, no thumbnail concept, no chosen hook and a shipped_role
-- of its choosing — exactly the state move_video's gate exists to refuse and
-- swap_thumbnail exists to log. stage_id is NOT NULL with no default, so there
-- is no column list that would leave a usable client INSERT behind: creation
-- goes through capture_video() below, which always lands the row in the
-- channel's Idea stage.
revoke insert on public.videos from anon, authenticated;

-- ------------------------------------------- column privileges (stages) -----

-- The delete policy above keys on `kind`, so `kind` has to be immutable from a
-- client: otherwise `update stages set kind = null` launders a core stage into
-- an inert one and the next statement deletes it. (It would also silently
-- relabel a core stage, and gate/badge/ordering behaviour all bind to `kind`.)
-- Same shape as videos: a column-level REVOKE cannot carve a hole in a
-- table-level grant, so drop the grant and re-grant every column but `kind`.
revoke update on public.stages from anon, authenticated;
grant update (id, user_id, created_at, channel_id, name, position, is_enabled)
  on public.stages to authenticated;

-- ---------------------------------- column privileges (thumbnail_swaps) -----

-- Append-only: no client UPDATE or DELETE at all, and swapped_at is left out of
-- the INSERT grant so only the column default (now()) can set it. Rows are
-- normally written by swap_thumbnail, which runs as the owner and is unaffected.
revoke update, delete, insert on public.thumbnail_swaps from anon, authenticated;
grant insert (id, user_id, created_at, video_id, from_role, to_role, reason)
  on public.thumbnail_swaps to authenticated;

-- ----------------------------------------------------------------- storage --

insert into storage.buckets (id, name, public)
values ('thumbnails', 'thumbnails', false)
on conflict (id) do nothing;

-- Object paths are {user_id}/{video_id}/{concept|wild_card|moderate|safe}.{ext}
-- and are uploaded with upsert:true, so re-upload replaces and nothing orphans.
create policy "thumbnails owner rw" on storage.objects
  for all to authenticated
  using      (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = auth.uid()::text);

-- ------------------------------------------------------- move_video(…) -----

-- Invariants live here, not in triggers and not in application code:
-- supabase-js has no transactions, so multi-row writes are plpgsql functions
-- called via supabase.rpc() from server actions. security definer (an invoker
-- function would itself be blocked by the column privileges above) with an
-- explicit ownership check as the first statement.
create function public.move_video(
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

  -- Snapshot the stage's checklist templates on first entry to that stage.
  insert into public.checklist_items (user_id, video_id, channel_id, stage_id, text, position, est_minutes)
  select v_uid, p_video, v_video.channel_id, p_stage, t.text, t.position, t.est_minutes
    from public.checklist_templates t
   where t.stage_id = p_stage
     and not exists (select 1
                       from public.checklist_items ci
                      where ci.video_id = p_video and ci.stage_id = p_stage);

  return v_result;
end;
$$;

-- ----------------------------------------------------- capture_video(…) -----

-- The only way a client creates a video, now that INSERT on videos is revoked.
-- It always lands the row in the channel's Idea stage, which is what capture
-- means (PLAN.md: "Saves into the channel's Idea stage") and which keeps
-- move_video the only path into every later stage — so the TTH gate cannot be
-- stepped around by creating a video on the far side of it.
create function public.capture_video(p_channel uuid, p_title text default '')
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

  insert into public.videos (user_id, channel_id, stage_id, title)
  values (v_uid, p_channel, v_stage, coalesce(p_title, ''))
  returning * into v_result;

  -- Same snapshot rule as move_video: entering a stage copies its templates.
  insert into public.checklist_items (user_id, video_id, channel_id, stage_id, text, position, est_minutes)
  select v_uid, v_result.id, p_channel, v_stage, t.text, t.position, t.est_minutes
    from public.checklist_templates t
   where t.stage_id = v_stage;

  return v_result;
end;
$$;

-- -------------------------------------------------- swap_thumbnail(…) ------

-- Writes the log row and the new shipped role atomically; the CHECK on videos
-- refuses a role with no asset, which aborts the whole call.
create function public.swap_thumbnail(
  p_video uuid,
  p_to_role text,
  p_reason text
) returns public.videos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_video  public.videos;
  v_result public.videos;
begin
  select * into v_video from public.videos where id = p_video and user_id = v_uid;
  if not found then
    raise exception 'video % not found for this user', p_video;
  end if;

  insert into public.thumbnail_swaps (user_id, video_id, from_role, to_role, reason)
  values (v_uid, p_video, v_video.shipped_role, p_to_role, p_reason);

  update public.videos v
     set shipped_role = p_to_role,
         updated_at   = now()
   where v.id = p_video and v.user_id = v_uid
   returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.move_video(uuid, uuid, timestamptz) from public, anon;
revoke all on function public.swap_thumbnail(uuid, text, text) from public, anon;
revoke all on function public.capture_video(uuid, text) from public, anon;
grant execute on function public.move_video(uuid, uuid, timestamptz) to authenticated, service_role;
grant execute on function public.swap_thumbnail(uuid, text, text) to authenticated, service_role;
grant execute on function public.capture_video(uuid, text) to authenticated, service_role;
