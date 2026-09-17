-- swap_thumbnail writes the log row and the new shipped role atomically, and
-- the CHECK on videos refuses a role with no asset -- which aborts the whole
-- call, log row included.

begin;

select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

-- Uploading assets is a plain client update (recordUpload); only shipped_role
-- is off limits from the client.
update public.videos
   set thumb_moderate_path = fx.user_a() || '/' || fx.video_a() || '/moderate.png',
       thumb_safe_path     = fx.user_a() || '/' || fx.video_a() || '/safe.png'
 where id = fx.video_a();

do $$
declare v public.videos; s public.thumbnail_swaps; n int;
begin
  select * into v from public.swap_thumbnail(fx.video_a(), 'moderate', 'shipping the moderate first');
  if v.shipped_role <> 'moderate' then
    raise exception 'FAILED: shipped_role is %, expected moderate', v.shipped_role;
  end if;

  select count(*) into n from public.thumbnail_swaps where video_id = fx.video_a();
  if n <> 1 then raise exception 'FAILED: expected 1 log row, got %', n; end if;

  select * into s from public.thumbnail_swaps where video_id = fx.video_a();
  if s.from_role is not null then raise exception 'FAILED: from_role should be null on the first ship'; end if;
  if s.to_role <> 'moderate' then raise exception 'FAILED: to_role is %', s.to_role; end if;
  if s.reason <> 'shipping the moderate first' then raise exception 'FAILED: the reason was not logged'; end if;
  if s.user_id <> fx.user_a() then raise exception 'FAILED: the log row is not owned by the caller'; end if;
  if s.swapped_at is null then raise exception 'FAILED: swapped_at was not stamped'; end if;
end $$;

do $$
declare v public.videos; s public.thumbnail_swaps;
begin
  -- A real swap records where it came from.
  select * into v from public.swap_thumbnail(fx.video_a(), 'safe', 'CTR 2.1% vs 6% expected');
  if v.shipped_role <> 'safe' then raise exception 'FAILED: shipped_role is %', v.shipped_role; end if;

  -- now() is the transaction timestamp, so the two log rows tie on swapped_at:
  -- pick the one this call wrote by its role.
  select * into s from public.thumbnail_swaps
   where video_id = fx.video_a() and to_role = 'safe';
  if s.from_role <> 'moderate' or s.to_role <> 'safe' then
    raise exception 'FAILED: the swap logged % -> %', s.from_role, s.to_role;
  end if;
end $$;

do $$
declare ok boolean := false; st text; n int; role_after text;
begin
  -- A role with no asset: the CHECK refuses, and neither the role nor the log
  -- row survives.
  begin
    perform public.swap_thumbnail(fx.video_a(), 'wild_card', 'feeling brave');
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: shipped a role with no asset'; end if;
  if st <> '23514' then raise exception 'FAILED: expected 23514, got %', st; end if;

  select shipped_role into role_after from public.videos where id = fx.video_a();
  if role_after <> 'safe' then raise exception 'FAILED: shipped_role is now %', role_after; end if;

  select count(*) into n from public.thumbnail_swaps where video_id = fx.video_a();
  if n <> 2 then raise exception 'FAILED: the refused swap left % log rows (expected 2)', n; end if;
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- Swapping to the role already shipped is not a swap.
  begin
    perform public.swap_thumbnail(fx.video_a(), 'safe', 'again');
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a no-op swap was logged'; end if;
  if st <> '23514' then raise exception 'FAILED: expected 23514, got %', st; end if;
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- An empty reason.
  begin
    perform public.swap_thumbnail(fx.video_a(), 'moderate', '');
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a swap with no reason was accepted'; end if;
  if st <> '23514' then raise exception 'FAILED: expected 23514, got %', st; end if;
end $$;

-- ---------------------------------------------------------- ownership ------
reset role;
select set_config('request.jwt.claims', json_build_object('sub', fx.user_b())::text, true);
set local role authenticated;

do $$
declare ok boolean := false; msg text; n int;
begin
  begin
    perform public.swap_thumbnail(fx.video_a(), 'moderate', 'not mine');
  exception when others then
    get stacked diagnostics msg = message_text; ok := true;
  end;
  if not ok then raise exception 'FAILED: B swapped A''s thumbnail'; end if;
  if msg not like '%not found for this user%' then
    raise exception 'FAILED: expected the ownership check to fire, got %', msg;
  end if;

  -- and nothing was logged under B's name
  select count(*) into n from public.thumbnail_swaps;
  if n <> 0 then raise exception 'FAILED: B can see/created % swap rows', n; end if;
end $$;

reset role;
rollback;
