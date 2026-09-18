-- Tenant isolation: RLS plus the composite tenant FKs.
--
-- The FK check bypasses RLS, so a plain user_id policy alone would let user B
-- point a child row at user A's parent and occupy A's unique slots. Every child
-- FK is composite on user_id, so the FK itself refuses.

begin;

-- ------------------------------------------------------------- act as B ----
select set_config('request.jwt.claims', json_build_object('sub', fx.user_b())::text, true);
set local role authenticated;

do $$
declare n int;
begin
  -- B sees only B's rows.
  select count(*) into n from public.videos;
  if n <> 1 then raise exception 'FAILED: B should see exactly its own 1 video, saw %', n; end if;

  select count(*) into n from public.videos where id = fx.video_a();
  if n <> 0 then raise exception 'FAILED: B can see A''s video'; end if;

  select count(*) into n from public.channels where slug like 'a-%';
  if n <> 0 then raise exception 'FAILED: B can see A''s channels (%)', n; end if;

  select count(*) into n from public.stages where channel_id = fx.channel('a-main');
  if n <> 0 then raise exception 'FAILED: B can see A''s stages (%)', n; end if;

  select count(*) into n from public.checklist_templates;
  if n <> 0 then raise exception 'FAILED: B can see A''s checklist templates (%)', n; end if;

  select count(*) into n from public.filming_days;
  if n <> 0 then raise exception 'FAILED: B can see A''s filming days (%)', n; end if;
end $$;

do $$
declare ok boolean := false; st text; msg text;
begin
  -- The headline case: B inserts a checklist_items row against A's video,
  -- tagged with B's own user_id so RLS's WITH CHECK is satisfied. Only the
  -- composite FK (video_id, user_id) -> videos (id, user_id) can refuse it.
  begin
    insert into public.checklist_items (user_id, video_id, channel_id, stage_id, text, position)
    values (fx.user_b(), fx.video_a(), fx.channel('a-main'),
            fx.stage(fx.channel('a-main'), 'idea'), 'squatting', 1);
  exception when others then
    get stacked diagnostics st = returned_sqlstate, msg = message_text;
    ok := true;
  end;
  if not ok then
    raise exception 'FAILED: B inserted a checklist_items row against A''s video';
  end if;
  if st <> '23503' then
    raise exception 'FAILED: expected foreign_key_violation (23503), got % (%)', st, msg;
  end if;
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- Same row but claiming A's user_id: now RLS refuses it first.
  begin
    insert into public.checklist_items (user_id, video_id, channel_id, stage_id, text, position)
    values (fx.user_a(), fx.video_a(), fx.channel('a-main'),
            fx.stage(fx.channel('a-main'), 'idea'), 'squatting', 1);
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    ok := true;
  end;
  if not ok then raise exception 'FAILED: B inserted a row owned by A'; end if;
  if st <> '42501' then raise exception 'FAILED: expected RLS refusal (42501), got %', st; end if;
end $$;

do $$
declare ok boolean := false; msg text;
begin
  -- Same shape one level up: a video inside A's channel. Clients cannot INSERT
  -- into videos at all any more (capture_video is the only creation path), so
  -- the refusal comes from the function's ownership check.
  begin
    perform public.capture_video(fx.channel('a-main'), 'squatting');
  exception when others then
    get stacked diagnostics msg = message_text;
    ok := true;
  end;
  if not ok then raise exception 'FAILED: B created a video inside A''s channel'; end if;
  if msg not like '%not found for this user%' then
    raise exception 'FAILED: expected the ownership check to fire, got %', msg;
  end if;
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- And the composite FK underneath it, exercised as the table owner so RLS and
  -- the INSERT revoke are out of the way and only the constraint can refuse.
  reset role;
  begin
    insert into public.videos (user_id, channel_id, stage_id)
    values (fx.user_b(), fx.channel('a-main'), fx.stage(fx.channel('a-main'), 'idea'));
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    ok := true;
  end;
  set local role authenticated;
  if not ok then raise exception 'FAILED: a video row bridged two tenants'; end if;
  if st <> '23503' then raise exception 'FAILED: expected 23503, got %', st; end if;
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- And a thumbnail_swaps log row against A's video. Since 0006 there is no
  -- client INSERT grant on the log at all, so this is refused before the FK is
  -- reached — which is the stronger refusal, not a weaker one.
  begin
    insert into public.thumbnail_swaps (user_id, video_id, to_role, reason)
    values (fx.user_b(), fx.video_a(), 'safe', 'not mine');
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    ok := true;
  end;
  if not ok then raise exception 'FAILED: B logged a swap against A''s video'; end if;
  if st <> '42501' then raise exception 'FAILED: expected 42501, got %', st; end if;

  -- The composite FK underneath it, exercised as the table owner so the revoke
  -- is out of the way and only the constraint can refuse. This is the binding
  -- that matters for swap_thumbnail, which is security definer and therefore
  -- runs exactly here.
  ok := false;
  reset role;
  begin
    insert into public.thumbnail_swaps (user_id, video_id, to_role, reason)
    values (fx.user_b(), fx.video_a(), 'safe', 'not mine');
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    ok := true;
  end;
  set local role authenticated;
  if not ok then raise exception 'FAILED: a swap log row bridged two tenants'; end if;
  if st <> '23503' then raise exception 'FAILED: expected 23503, got %', st; end if;
end $$;

do $$
declare n int;
begin
  -- Writes aimed at A's rows touch nothing rather than erroring.
  update public.videos set title = 'hijacked' where id = fx.video_a();
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: B updated % of A''s videos', n; end if;

  delete from public.videos where id = fx.video_a();
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: B deleted % of A''s videos', n; end if;
end $$;

-- B can still work inside its own tenancy (positive control).
do $$
declare n int;
begin
  insert into public.checklist_items (user_id, video_id, channel_id, stage_id, text, position)
  values (fx.user_b(), fx.video_b(), fx.channel('b-main'),
          fx.stage(fx.channel('b-main'), 'idea'), 'mine', 1);
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: B cannot write its own checklist item'; end if;
end $$;

-- ------------------------------------------------------------- act as A ----
reset role;
select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

do $$
declare n int;
begin
  select count(*) into n from public.videos;
  if n <> 1 then raise exception 'FAILED: A should see exactly its own 1 video, saw %', n; end if;

  select count(*) into n from public.channels;
  if n <> 2 then raise exception 'FAILED: A should see its 2 channels, saw %', n; end if;
end $$;

-- --------------------------------------------------------------- anon -------
reset role;
select set_config('request.jwt.claims', '{}', true);  -- no subject
set local role anon;

do $$
declare n int;
begin
  select count(*) into n from public.videos;
  if n <> 0 then raise exception 'FAILED: anon sees % videos', n; end if;
  select count(*) into n from public.channels;
  if n <> 0 then raise exception 'FAILED: anon sees % channels', n; end if;
end $$;

reset role;
rollback;
