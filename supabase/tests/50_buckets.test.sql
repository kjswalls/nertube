-- Buckets are bound to a channel AND to an axis through the composite FK
-- (bucket_id, channel_id, axis) -> buckets (id, channel_id, axis): a video can
-- only ever reference its own channel's bucket of the right axis.

begin;

select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

do $$
declare ok boolean := false; st text;
begin
  -- A bucket belonging to the user's OTHER channel.
  begin
    update public.videos set vertical_id = fx.bucket(fx.channel('a-side'), 'vertical', 'gear')
     where id = fx.video_a();
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a video took a bucket from another channel'; end if;
  if st <> '23503' then raise exception 'FAILED: expected 23503, got %', st; end if;
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- The right channel, the wrong axis: a horizontal bucket in the vertical slot.
  begin
    update public.videos set vertical_id = fx.bucket(fx.channel('a-main'), 'horizontal', 'tutorial')
     where id = fx.video_a();
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a horizontal bucket landed in the vertical slot'; end if;
  if st <> '23503' then raise exception 'FAILED: expected 23503, got %', st; end if;
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- Another tenant's bucket entirely.
  begin
    update public.videos set vertical_id = fx.bucket(fx.channel('b-main'), 'vertical', 'money')
     where id = fx.video_a();
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a video took another tenant''s bucket'; end if;
  if st <> '23503' then raise exception 'FAILED: expected 23503, got %', st; end if;
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- The axis columns are pinned, so the FK cannot be talked around by
  -- rewriting the axis to match a foreign bucket.
  begin
    update public.videos
       set vertical_axis = 'horizontal',
           vertical_id = fx.bucket(fx.channel('a-main'), 'horizontal', 'tutorial')
     where id = fx.video_a();
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: the pinned vertical_axis was rewritten'; end if;
  if st <> '23514' then raise exception 'FAILED: expected a CHECK violation (23514), got %', st; end if;
end $$;

do $$
declare n int; v public.videos;
begin
  -- Positive control: the channel's own buckets, right axis each.
  update public.videos
     set vertical_id   = fx.bucket(fx.channel('a-main'), 'vertical',   'money'),
         horizontal_id = fx.bucket(fx.channel('a-main'), 'horizontal', 'tutorial')
   where id = fx.video_a();
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: a legitimate bucket pair was refused'; end if;

  -- Deleting a bucket clears the reference instead of deleting the video.
  delete from public.buckets where id = fx.bucket(fx.channel('a-main'), 'vertical', 'money');
  select * into v from public.videos where id = fx.video_a();
  if v.id is null then raise exception 'FAILED: deleting a bucket deleted the video'; end if;
  if v.vertical_id is not null then raise exception 'FAILED: vertical_id was not set null'; end if;
  if v.horizontal_id is null then raise exception 'FAILED: the horizontal reference was collateral damage'; end if;
  if v.vertical_axis <> 'vertical' then raise exception 'FAILED: vertical_axis was nulled/rewritten'; end if;
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- unique (channel_id, axis, name)
  begin
    insert into public.buckets (user_id, channel_id, axis, name, position)
    values (fx.user_a(), fx.channel('a-main'), 'horizontal', 'tutorial', 9);
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a duplicate bucket name was accepted'; end if;
  if st <> '23505' then raise exception 'FAILED: expected 23505, got %', st; end if;
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- monthly_quota > 0
  begin
    insert into public.buckets (user_id, channel_id, axis, name, position, monthly_quota)
    values (fx.user_a(), fx.channel('a-main'), 'horizontal', 'review', 2, 0);
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: monthly_quota = 0 was accepted'; end if;
  if st <> '23514' then raise exception 'FAILED: expected 23514, got %', st; end if;
end $$;

do $$
declare ok boolean := false; st text; p int;
begin
  -- Bucket positions swap in one statement too (deferred unique).
  insert into public.buckets (user_id, channel_id, axis, name, position)
  values (fx.user_a(), fx.channel('a-main'), 'horizontal', 'review', 2);

  update public.buckets b
     set position = case when b.name = 'tutorial' then 2 else 1 end
   where b.channel_id = fx.channel('a-main') and b.axis = 'horizontal';
  set constraints all immediate;

  select b.position into p from public.buckets b
   where b.channel_id = fx.channel('a-main') and b.axis = 'horizontal' and b.name = 'review';
  if p <> 1 then raise exception 'FAILED: bucket positions did not swap (review is %)', p; end if;
  set constraints all deferred;
end $$;

rollback;
