-- 0007 — the stage settings: order, on/off, and the label.
--
-- M7 is the first milestone that edits `stages` from a screen built for it,
-- and the two edits that can put a channel into a state nothing else recovers
-- from — the order of the columns and whether a column exists — move here, into
-- the database, where every other invariant of that weight in this app already
-- lives (`move_video`'s gate, the paired CHECK on the metrics, the append-only
-- swap log). `app/actions/stages.ts` has said since M4 that the "cannot disable
-- an occupied stage" rule was in the application only because moving it meant
-- revoking a column and rewriting a passing test, and that this was "M7's
-- argument to have with the whole settings screen in front of it". This is
-- that argument, settled the way the rest of the schema settles it.
--
-- Three things change, and the third is why this is a migration at all:
--
-- 1. **A stage's name cannot be blank.** The name is a label — behaviour binds
--    to `kind` — but a column with no heading is a column nobody can find, and
--    a select whose option is an empty string is a lie about where a video is.
--
-- 2. **`position` and `is_enabled` leave the client's UPDATE grant.** Only
--    `name` stays, because renaming is exactly the harmless edit PLAN.md
--    promises it is. A client that could PATCH `position` could put Editing
--    before Packaging with one request; nothing would break, because behaviour
--    compares `CORE_KIND_ORDER` and never `position`, but the board would draw
--    a pipeline that reads backwards and settings would have no way to offer
--    the move that fixes it. A client that could PATCH `is_enabled` could hide
--    every video in a stage from the board, `/now` and the sidebar's count
--    without a word.
--
-- 3. **Two functions, one write path each.** supabase-js cannot express a
--    multi-row `update … set position = case …`, and PostgREST runs each
--    request in its own transaction, so a reorder made as a sequence of
--    single-row PATCHes trips the `unique (channel_id, position)` at the first
--    commit — the constraint is DEFERRABLE INITIALLY DEFERRED precisely so that
--    ONE statement can swap rows through a colliding intermediate state.
--    `reorder_stages` is that one statement, and it refuses the order the
--    settings screen must never offer: a core stage carried across another
--    core stage. `set_stage_enabled` is the occupancy rule, with archived
--    videos not counting (PLAN.md review item 10), plus one rule the trap
--    list names outright: the last enabled stage stays on.
--
-- Same shape as move_video/swap_thumbnail/create_channel: security definer,
-- pinned search_path, owner-executed, and the first thing each one does is
-- prove the caller owns the row.

-- ------------------------------------------------------------ 1. the label --

alter table public.stages
  add constraint stages_name_not_blank check (btrim(name) <> '');

-- ------------------------------------------------------------ 2. the grant --

-- Drop and re-grant, as 0001 does: a column-level REVOKE cannot carve a hole
-- in a table-level grant. `kind`, `id` and `created_at` were already out.
revoke update on public.stages from anon, authenticated;
grant update (user_id, channel_id, name)
  on public.stages to authenticated;

-- ---------------------------------------------------- 3a. reorder_stages() --
--
-- `p_stage_ids` is the channel's stages, every one of them, enabled or not, in
-- the order they should be drawn. The whole list rather than a pair, because
-- "swap these two" cannot be checked for a core crossing without reading the
-- rest anyway, and because the function then writes positions 1..n from the
-- list and the channel can never hold a gap or a duplicate the deferred unique
-- would only report at commit.
--
-- The one UPDATE joins the list `with ordinality`, which is the same single
-- statement as `set position = case …` written for a list of unknown length.
-- The intermediate state collides; the deferred unique lets it, and the
-- function's end state is a permutation of 1..n, so the check at commit holds.

create function public.reorder_stages(p_channel uuid, p_stage_ids uuid[])
returns setof public.stages
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Order of behaviour is CORE_KIND_ORDER (lib/defaults.ts), never position.
  k_order constant text[] := array['idea','packaging','scripting','filming','editing',
                                   'publish_prep','scheduled','published','repurposed'];
  v_uid      uuid := auth.uid();
  v_expected int;
  v_given    int;
  v_matched  int;
  v_prev     int := 0;
  v_prev_name text;
  r          record;
begin
  perform 1 from public.channels where id = p_channel and user_id = v_uid;
  if not found then
    raise exception 'channel % not found for this user', p_channel;
  end if;

  -- The list is the channel's stages exactly: every one, once, nothing foreign.
  -- given = expected = distinct-matched rules out a missing id, a repeated id
  -- and an id from another channel (or another user) in one comparison.
  select count(*) into v_expected from public.stages where channel_id = p_channel;
  v_given := coalesce(array_length(p_stage_ids, 1), 0);
  if v_given <> v_expected then
    raise exception 'order:incomplete: % ids for % stages', v_given, v_expected;
  end if;
  select count(distinct s.id) into v_matched
    from public.stages s
   where s.channel_id = p_channel and s.id = any (p_stage_ids);
  if v_matched <> v_expected then
    raise exception 'order:foreign: the list names a stage that is not in this channel';
  end if;

  -- Core stages keep their relative order. Inert stages (kind null) are
  -- skipped here, so they slot anywhere.
  for r in
    select s.kind, s.name
      from unnest(p_stage_ids) with ordinality as o(id, ord)
      join public.stages s on s.id = o.id
     where s.kind is not null
     order by o.ord
  loop
    if array_position(k_order, r.kind) < v_prev then
      raise exception 'core order: % cannot come before %', v_prev_name, r.name;
    end if;
    v_prev := array_position(k_order, r.kind);
    v_prev_name := r.name;
  end loop;

  update public.stages s
     set position = o.ord
    from unnest(p_stage_ids) with ordinality as o(id, ord)
   where s.id = o.id and s.channel_id = p_channel;

  return query
    select * from public.stages where channel_id = p_channel order by position;
end;
$$;

-- ------------------------------------------------- 3b. set_stage_enabled() --
--
-- A disabled stage is filtered out of every read in the app — the board's
-- columns, `/now`'s stage list, the stage select — and `nextAction()` returns
-- null for a video whose stage it cannot find. Disabling an occupied stage
-- therefore does not hide a column; it hides the videos in it. So it is
-- refused, with the count in the message (`occupied:<n>`) so the screen can
-- say how many are in the way rather than "no".
--
-- Archived videos do not count: they are already off the board and out of
-- `/now`, so there is nothing for the switch to hide.

create function public.set_stage_enabled(p_stage uuid, p_enabled boolean)
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
    select count(*) into n
      from public.videos
     where stage_id = p_stage and archived_at is null;
    if n > 0 then
      raise exception 'occupied:%', n;
    end if;

    -- A channel with no enabled stages is a board with no columns and a
    -- `/now` with nothing to rank. Settings lists disabled stages, so the
    -- state would be recoverable — but there is no reason to allow it.
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

revoke all on function public.reorder_stages(uuid, uuid[]) from public, anon;
revoke all on function public.set_stage_enabled(uuid, boolean) from public, anon;
grant execute on function public.reorder_stages(uuid, uuid[]) to authenticated;
grant execute on function public.set_stage_enabled(uuid, boolean) to authenticated;
