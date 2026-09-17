-- The CHECK constraints on videos and thumbnail_swaps, exercised by direct SQL
-- as the table owner: zod and the UI are the first line, these are the floor.

begin;

do $$
declare
  -- Each case: a label, and the SET list of an update against video A.
  cases text[][] := array[
    -- post-publish pairing
    ['CTR without impressions',        $s$first24_ctr = 4.2$s$],
    ['impressions without CTR',        $s$first24_impressions = 1000$s$],
    ['negative impressions',           $s$first24_impressions = -1, first24_ctr = 4.2$s$],
    ['CTR above 100',                  $s$first24_impressions = 10, first24_ctr = 101$s$],
    ['negative views',                 $s$first24_views = -1$s$],
    -- packaging
    ['a 4th hook',                     $s$hooks = '[{"id":"1"},{"id":"2"},{"id":"3"},{"id":"4"}]'::jsonb$s$],
    ['hooks as an object',             $s$hooks = '{"id":"1"}'::jsonb$s$],
    ['title_candidates as an object',  $s$title_candidates = '{"a":1}'::jsonb$s$],
    ['a skip with no reason',          $s$packaging_skipped_at = now()$s$],
    ['a reason with no skip',          $s$packaging_skip_reason = 'because'$s$],
    ['an empty skip reason',           $s$packaging_skipped_at = now(), packaging_skip_reason = ''$s$],
    -- thumbnails: the shipped role always has an asset
    ['shipped wild_card with no asset',$s$shipped_role = 'wild_card'$s$],
    ['shipped safe with only a moderate asset',
                                       $s$thumb_moderate_path = 'u/v/moderate.png', shipped_role = 'safe'$s$],
    -- enumerations
    ['an unknown script_structure',    $s$script_structure = 'freestyle'$s$],
    ['an unknown shipped_role',        $s$shipped_role = 'spicy'$s$]
  ];
  i int; ok boolean; st text;
begin
  for i in 1 .. array_length(cases, 1) loop
    ok := false;
    begin
      execute format('update public.videos set %s where id = %L', cases[i][2], fx.video_a());
    exception when others then
      get stacked diagnostics st = returned_sqlstate; ok := true;
    end;
    if not ok then raise exception 'FAILED: % was accepted', cases[i][1]; end if;
    if st <> '23514' then
      raise exception 'FAILED: % gave % , expected a CHECK violation (23514)', cases[i][1], st;
    end if;
  end loop;
end $$;

do $$
declare v public.videos;
begin
  -- Positive controls, so the loop above is not passing for the wrong reason.
  update public.videos
     set first24_impressions = 12000, first24_ctr = 4.20, first24_views = 500,
         metrics_logged_at = now(),
         hooks = '[{"id":"1","text":"a","chosen":true},{"id":"2","text":"b"},{"id":"3","text":"c"}]'::jsonb,
         title_candidates = '[{"id":"1","text":"t","chosen":true,"source":"ai"}]'::jsonb,
         packaging_skipped_at = now(), packaging_skip_reason = 'evergreen re-cut',
         thumb_safe_path = 'u/v/safe.png', shipped_role = 'safe',
         script_structure = 'three_part'
   where id = fx.video_a()
  returning * into v;
  if v.shipped_role <> 'safe' then raise exception 'FAILED: a legitimate full row was refused'; end if;

  -- Clearing both metrics together is fine; clearing one is the case above.
  update public.videos set first24_impressions = null, first24_ctr = null where id = fx.video_a();
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- Dropping the asset out from under the shipped role is refused too.
  begin
    update public.videos set thumb_safe_path = null where id = fx.video_a();
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: the shipped role was left without an asset'; end if;
  if st <> '23514' then raise exception 'FAILED: expected 23514, got %', st; end if;
end $$;

-- ------------------------------------------------------- thumbnail_swaps ----
do $$
declare
  -- label, from_role, to_role, reason
  cases text[][] := array[
    ['an unknown to_role',   'null',   'spicy', 'why'],
    ['an unknown from_role', 'spicy',  'safe',  'why'],
    ['from_role = to_role',  'safe',   'safe',  'why'],
    ['an empty reason',      'null',   'safe',  '']
  ];
  i int; ok boolean; st text;
begin
  for i in 1 .. array_length(cases, 1) loop
    ok := false;
    begin
      insert into public.thumbnail_swaps (user_id, video_id, from_role, to_role, reason)
      values (fx.user_a(), fx.video_a(), nullif(cases[i][2], 'null'), cases[i][3], cases[i][4]);
    exception when others then
      get stacked diagnostics st = returned_sqlstate; ok := true;
    end;
    if not ok then raise exception 'FAILED: a swap row with % was accepted', cases[i][1]; end if;
    if st <> '23514' then raise exception 'FAILED: % gave %, expected 23514', cases[i][1], st; end if;
  end loop;

  -- Positive control.
  insert into public.thumbnail_swaps (user_id, video_id, from_role, to_role, reason)
  values (fx.user_a(), fx.video_a(), 'wild_card', 'safe', 'CTR 2.1% vs 6% expected');
end $$;

-- -------------------------------------------------------- checklist_items ---
do $$
declare ok boolean := false; st text; n int;
begin
  -- Within one tenant, an item must name a stage from its own video's channel:
  -- the stage checklist on /videos/[id] and the next action on /now both key on
  -- stage_id, so a mismatched pair would surface in the wrong channel.
  begin
    insert into public.checklist_items (user_id, video_id, channel_id, stage_id, text, position)
    values (fx.user_a(), fx.video_a(), fx.channel('a-main'),
            fx.stage(fx.channel('a-side'), 'filming'), 'item from the wrong channel', 1);
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: an item took a stage from another channel'; end if;
  if st <> '23503' then raise exception 'FAILED: expected 23503, got %', st; end if;

  -- Nor can the item claim a channel its video is not in.
  ok := false;
  begin
    insert into public.checklist_items (user_id, video_id, channel_id, stage_id, text, position)
    values (fx.user_a(), fx.video_a(), fx.channel('a-side'),
            fx.stage(fx.channel('a-side'), 'filming'), 'item on a foreign video', 1);
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: an item was attached across channels'; end if;
  if st <> '23503' then raise exception 'FAILED: expected 23503, got %', st; end if;

  -- Positive control: the video's own channel and one of its stages.
  insert into public.checklist_items (user_id, video_id, channel_id, stage_id, text, position)
  values (fx.user_a(), fx.video_a(), fx.channel('a-main'),
          fx.stage(fx.channel('a-main'), 'idea'), 'a legitimate item', 1);
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: a legitimate checklist item was refused'; end if;
end $$;

-- ---------------------------------------------------------- filming_days ----
do $$
declare ok boolean := false; st text;
begin
  -- unique (user_id, on_date): one filming day per date per creator.
  begin
    insert into public.filming_days (user_id, on_date) values (fx.user_a(), date '2026-01-10');
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: two filming days on one date'; end if;
  if st <> '23505' then raise exception 'FAILED: expected 23505, got %', st; end if;

  -- The other user may still have their own day on that date.
  insert into public.filming_days (user_id, on_date) values (fx.user_b(), date '2026-01-10');
end $$;

-- ------------------------------------------------------------- channels ----
do $$
declare ok boolean := false; st text;
begin
  -- unique (user_id, slug)
  begin
    insert into public.channels (user_id, name, slug, script_template)
    values (fx.user_a(), 'Duplicate', 'a-main', 'x');
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a duplicate slug was accepted'; end if;
  if st <> '23505' then raise exception 'FAILED: expected 23505, got %', st; end if;

  -- ... per user, not globally.
  insert into public.channels (user_id, name, slug, script_template)
  values (fx.user_b(), 'B also has a-main', 'a-main', 'x');
end $$;

rollback;
