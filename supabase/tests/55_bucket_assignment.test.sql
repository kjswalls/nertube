-- M5: assigning an idea to its buckets.
--
-- 50_buckets.test.sql proves the composite foreign key refuses a bucket from
-- another channel or from the wrong axis *in the vertical slot*. This file is
-- about the picker's own promises, stated as things the database will not let
-- happen whatever the browser sends:
--
--   1. one of each axis, and no second slot for either — asserted against the
--      catalogue, because "at most one vertical" is the *shape* of the schema
--      (one scalar column, one three-column FK), not a rule anything checks;
--   2. the horizontal slot is bound exactly as the vertical one is — 50 only
--      exercises the vertical, so a key written with the wrong axis column
--      would have gone unnoticed there;
--   3. clearing a bucket is an ordinary write, not a deletion;
--   4. a video cannot change channel, which is why the pickers never offer
--      one: with the buckets set, the move is refused by the bucket keys, and
--      `stage_id` is not even writable from a client;
--   5. `tags` is writable by `authenticated` and defaults to an empty array,
--      because the tag editor writes that column directly (there is no RPC).
--
-- Everything runs as the owning user through `authenticated`, which is what the
-- application is, except where it says otherwise out loud.

begin;

select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

-- 1. One slot per axis, and both of them bound through three columns ---------

do $$
declare n int; c record;
begin
  -- Exactly two references from videos to buckets. A third column (a second
  -- vertical, a "themes" slot) would make "one of each axis" untrue without a
  -- single line of application code changing.
  select count(*) into n
    from pg_constraint
   where conrelid = 'public.videos'::regclass
     and contype = 'f'
     and confrelid = 'public.buckets'::regclass;
  if n <> 2 then
    raise exception 'FAILED: videos has % foreign keys into buckets, expected 2', n;
  end if;

  for c in
    select con.conname,
           (select array_agg(a.attname::text order by k.ord)
              from unnest(con.conkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
           ) as cols,
           (select array_agg(a.attname::text order by k.ord)
              from unnest(con.confkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum
           ) as refcols
      from pg_constraint con
     where con.conrelid = 'public.videos'::regclass
       and con.contype = 'f'
       and con.confrelid = 'public.buckets'::regclass
  loop
    if array_length(c.cols, 1) <> 3 then
      raise exception 'FAILED: % references buckets on % column(s), expected 3 (id, channel, axis)',
        c.conname, array_length(c.cols, 1);
    end if;
    if c.refcols <> array['id','channel_id','axis'] then
      raise exception 'FAILED: % points at buckets %, expected (id, channel_id, axis)',
        c.conname, c.refcols;
    end if;
    if not (c.cols[2] = 'channel_id'
            and c.cols[1] in ('vertical_id','horizontal_id')
            and c.cols[3] = replace(c.cols[1], '_id', '_axis')) then
      raise exception 'FAILED: % is keyed on %, which is not (slot, channel_id, matching axis)',
        c.conname, c.cols;
    end if;
  end loop;

  -- Each slot is a single uuid column, so it cannot hold two buckets.
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'videos'
     and column_name in ('vertical_id','horizontal_id')
     and data_type = 'uuid';
  if n <> 2 then
    raise exception 'FAILED: the two bucket slots are not plain uuid columns (% of 2)', n;
  end if;
end $$;

-- 2. The happy path: one of each, on the video's own channel ------------------

do $$
declare v public.videos;
begin
  update public.videos
     set vertical_id   = fx.bucket(fx.channel('a-main'), 'vertical',   'money'),
         horizontal_id = fx.bucket(fx.channel('a-main'), 'horizontal', 'tutorial')
   where id = fx.video_a();

  select * into v from public.videos where id = fx.video_a();
  if v.vertical_id is null or v.horizontal_id is null then
    raise exception 'FAILED: a legitimate pair did not persist';
  end if;
end $$;

-- 3. The horizontal slot, refused the same three ways ------------------------

-- A horizontal bucket on the user's OTHER channel, for the cross-channel case.
insert into public.buckets (user_id, channel_id, axis, name, position)
values (fx.user_a(), fx.channel('a-side'), 'horizontal', 'review', 1);

do $$
declare ok boolean := false; st text;
begin
  -- The right channel, the wrong axis: a vertical bucket in the format slot.
  begin
    update public.videos set horizontal_id = fx.bucket(fx.channel('a-main'), 'vertical', 'money')
     where id = fx.video_a();
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a vertical bucket landed in the horizontal slot'; end if;
  if st <> '23503' then raise exception 'FAILED: expected 23503, got %', st; end if;
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- The right axis, another channel of the same user.
  begin
    update public.videos set horizontal_id = fx.bucket(fx.channel('a-side'), 'horizontal', 'review')
     where id = fx.video_a();
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a horizontal bucket from another channel was accepted'; end if;
  if st <> '23503' then raise exception 'FAILED: expected 23503, got %', st; end if;
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- The pinned axis column cannot be rewritten to make the key fit, in this
  -- slot either.
  begin
    update public.videos
       set horizontal_axis = 'vertical',
           horizontal_id = fx.bucket(fx.channel('a-main'), 'vertical', 'money')
     where id = fx.video_a();
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: the pinned horizontal_axis was rewritten'; end if;
  if st <> '23514' then raise exception 'FAILED: expected a CHECK violation (23514), got %', st; end if;
end $$;

do $$
declare v public.videos;
begin
  -- None of the three refusals left anything behind.
  select * into v from public.videos where id = fx.video_a();
  if v.horizontal_id <> fx.bucket(fx.channel('a-main'), 'horizontal', 'tutorial') then
    raise exception 'FAILED: a refused write changed the horizontal slot';
  end if;
  if v.horizontal_axis <> 'horizontal' or v.vertical_axis <> 'vertical' then
    raise exception 'FAILED: an axis column was rewritten by a refused write';
  end if;
end $$;

-- 4. Clearing one axis, and then both ----------------------------------------

do $$
declare v public.videos;
begin
  update public.videos set vertical_id = null where id = fx.video_a();
  select * into v from public.videos where id = fx.video_a();
  if v.vertical_id is not null then raise exception 'FAILED: a bucket could not be cleared'; end if;
  if v.horizontal_id is null then raise exception 'FAILED: clearing one axis cleared the other'; end if;
  if v.vertical_axis <> 'vertical' then raise exception 'FAILED: clearing rewrote the axis column'; end if;

  update public.videos set vertical_id = null, horizontal_id = null where id = fx.video_a();
  select * into v from public.videos where id = fx.video_a();
  if v.vertical_id is not null or v.horizontal_id is not null then
    raise exception 'FAILED: both slots did not clear';
  end if;
  if v.id is null then raise exception 'FAILED: clearing the buckets deleted the video'; end if;
end $$;

-- 5. A video cannot change channel -------------------------------------------

do $$
declare ok boolean := false; st text;
begin
  -- Even with both buckets clear, the stage is bound to the channel:
  -- foreign key (stage_id, channel_id) references stages (id, channel_id).
  begin
    update public.videos set channel_id = fx.channel('a-side') where id = fx.video_a();
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a video moved channel'; end if;
  if st <> '23503' then raise exception 'FAILED: expected 23503, got %', st; end if;
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- And a client cannot bring the stage along: UPDATE (stage_id) is revoked
  -- from `authenticated`, so the pair cannot be written at all. 42501 is
  -- insufficient_privilege.
  begin
    update public.videos
       set channel_id = fx.channel('a-side'),
           stage_id = fx.stage(fx.channel('a-side'), 'idea')
     where id = fx.video_a();
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a client rewrote stage_id'; end if;
  if st <> '42501' then raise exception 'FAILED: expected 42501, got %', st; end if;
end $$;

-- The same move, attempted by something that *does* hold the grant: the bucket
-- keys are what refuses it then. This is the reason the pickers never offer a
-- channel switch — if one ever existed, the buckets would have to be cleared in
-- the same statement, and the database would insist on it.
reset role;

do $$
declare ok boolean := false; st text;
begin
  update public.videos
     set vertical_id   = fx.bucket(fx.channel('a-main'), 'vertical',   'money'),
         horizontal_id = fx.bucket(fx.channel('a-main'), 'horizontal', 'tutorial')
   where id = fx.video_a();

  begin
    update public.videos
       set channel_id = fx.channel('a-side'),
           stage_id = fx.stage(fx.channel('a-side'), 'idea')
     where id = fx.video_a();
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a video with buckets moved channel'; end if;
  if st <> '23503' then raise exception 'FAILED: expected 23503, got %', st; end if;

  -- With both slots cleared in the same statement it is merely a stage
  -- question, which is what makes the refusal above about the buckets.
  update public.videos
     set channel_id = fx.channel('a-side'),
         stage_id = fx.stage(fx.channel('a-side'), 'idea'),
         vertical_id = null,
         horizontal_id = null
   where id = fx.video_a();
end $$;

set local role authenticated;

-- 6. Tags: the column the editor writes --------------------------------------

do $$
declare v public.videos; n int;
begin
  -- In the client's UPDATE grant (0001_init.sql re-grants every column except
  -- the four the SQL functions own), so the tag editor needs no RPC.
  select count(*) into n
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'videos'
     and column_name = 'tags' and privilege_type = 'UPDATE'
     and grantee = 'authenticated';
  if n <> 1 then raise exception 'FAILED: authenticated cannot update videos.tags'; end if;

  update public.videos set tags = array['index funds','review']
   where id = fx.video_a();
  select * into v from public.videos where id = fx.video_a();
  if v.tags <> array['index funds','review'] then
    raise exception 'FAILED: tags did not persist (%)', v.tags;
  end if;

  -- Emptying is an empty array, never NULL: the column is `not null default
  -- '{}'`, and every reader treats it as a list without asking.
  update public.videos set tags = '{}' where id = fx.video_a();
  select * into v from public.videos where id = fx.video_a();
  if v.tags is null or array_length(v.tags, 1) is not null then
    raise exception 'FAILED: tags did not empty cleanly';
  end if;
end $$;

rollback;
