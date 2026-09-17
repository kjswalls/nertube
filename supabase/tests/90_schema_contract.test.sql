-- The shape PLAN.md's data model promises, asserted against the catalogue:
-- the table set, the common columns, RLS on everything, unique (id, user_id) on
-- every parent, and the four SQL functions being security definer with a pinned
-- search_path. Plus the delete cascades.

begin;

do $$
declare
  expected text[] := array['buckets','channels','checklist_items','checklist_templates',
                           'filming_days','stages','thumbnail_swaps','videos'];
  actual text[];
  t text;
  n int;
begin
  select array_agg(c.relname order by c.relname) into actual
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'r';
  if actual is distinct from expected then
    raise exception 'FAILED: public tables are %, expected %', actual, expected;
  end if;

  foreach t in array expected loop
    -- id uuid pk default gen_random_uuid(), user_id uuid not null default
    -- auth.uid() references auth.users, created_at timestamptz not null now()
    select count(*) into n from information_schema.columns
     where table_schema = 'public' and table_name = t
       and ((column_name = 'id' and data_type = 'uuid' and column_default like 'gen_random_uuid%')
         or (column_name = 'user_id' and data_type = 'uuid' and is_nullable = 'NO'
             and column_default like '%auth.uid()%')
         or (column_name = 'created_at' and data_type = 'timestamp with time zone'
             and is_nullable = 'NO' and column_default like 'now()%'));
    if n <> 3 then raise exception 'FAILED: %.{id,user_id,created_at} is wrong (% of 3)', t, n; end if;

    if not (select c.relrowsecurity from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
             where ns.nspname = 'public' and c.relname = t) then
      raise exception 'FAILED: RLS is not enabled on %', t;
    end if;

    -- user_id must point at auth.users, or a deleted account leaves rows behind
    select count(*) into n from pg_constraint con
     where con.conrelid = format('public.%I', t)::regclass and con.contype = 'f'
       and con.confrelid = 'auth.users'::regclass;
    if n <> 1 then raise exception 'FAILED: %.user_id does not reference auth.users', t; end if;
  end loop;

  -- Every parent of a composite tenant FK carries unique (id, user_id).
  foreach t in array array['channels','stages','buckets','videos','filming_days'] loop
    select count(*) into n from pg_constraint con
     where con.conrelid = format('public.%I', t)::regclass and con.contype = 'u'
       and con.conkey = (select array_agg(a.attnum order by a.attname)
                           from pg_attribute a
                          where a.attrelid = con.conrelid and a.attname in ('id','user_id'));
    if n < 1 then raise exception 'FAILED: % has no unique (id, user_id)', t; end if;
  end loop;
end $$;

do $$
declare f record; n int := 0;
begin
  for f in select p.proname, p.prosecdef, p.proconfig
             from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public'
              and p.proname in ('move_video','swap_thumbnail','capture_video','create_channel')
  loop
    n := n + 1;
    if not f.prosecdef then raise exception 'FAILED: %() is not security definer', f.proname; end if;
    if f.proconfig is null or not ('search_path=public' = any(f.proconfig)) then
      raise exception 'FAILED: %() does not pin search_path (%)', f.proname, f.proconfig;
    end if;
  end loop;
  if n <> 4 then raise exception 'FAILED: expected 4 SQL functions, found %', n; end if;
end $$;

do $$
declare n int;
begin
  -- anon can call none of them; every call goes through a server action.
  if has_function_privilege('anon', 'public.move_video(uuid,uuid,timestamptz)', 'execute') then
    raise exception 'FAILED: anon can execute move_video';
  end if;
  if not has_function_privilege('authenticated', 'public.swap_thumbnail(uuid,text,text)', 'execute') then
    raise exception 'FAILED: authenticated cannot execute swap_thumbnail';
  end if;

  -- The policy set: stages has its own delete policy, channels has none.
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'stages' and cmd = 'DELETE';
  if n <> 1 then raise exception 'FAILED: stages should have exactly 1 delete policy, has %', n; end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'channels' and (cmd = 'DELETE' or cmd = 'ALL');
  if n <> 0 then raise exception 'FAILED: channels must have no delete policy in v1'; end if;

  select count(*) into n from pg_policies where schemaname = 'storage' and tablename = 'objects';
  if n <> 1 then raise exception 'FAILED: expected 1 storage.objects policy, found %', n; end if;

  -- thumbnail_swaps is append-only: select and insert policies, nothing else.
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'thumbnail_swaps'
     and cmd in ('UPDATE','DELETE','ALL');
  if n <> 0 then raise exception 'FAILED: thumbnail_swaps has % update/delete policies', n; end if;

  -- No client may create a channel except through create_channel(), which seeds
  -- it in the same transaction -- an unseeded channel could never be removed.
  if has_table_privilege('authenticated', 'public.channels', 'INSERT') then
    raise exception 'FAILED: a client can insert a channel row directly';
  end if;
  if has_table_privilege('authenticated', 'public.videos', 'INSERT') then
    raise exception 'FAILED: a client can insert a video row directly';
  end if;
  if has_function_privilege('anon',
       'public.create_channel(text,text,text,int,int,numeric,text,jsonb,jsonb)', 'execute') then
    raise exception 'FAILED: anon can execute create_channel';
  end if;
  if has_function_privilege('anon', 'public.capture_video(uuid,text)', 'execute') then
    raise exception 'FAILED: anon can execute capture_video';
  end if;
end $$;

-- ------------------------------------------------------------- cascades ----
do $$
declare v_id uuid; n int;
begin
  -- A video takes its checklist items and swap log with it.
  insert into public.videos (user_id, channel_id, stage_id, thumb_safe_path)
  values (fx.user_a(), fx.channel('a-main'), fx.stage(fx.channel('a-main'), 'idea'), 'p/safe.png')
  returning id into v_id;   -- as the owner: clients go through capture_video

  insert into public.checklist_items (user_id, video_id, channel_id, stage_id, text, position)
  values (fx.user_a(), v_id, fx.channel('a-main'), fx.stage(fx.channel('a-main'), 'idea'), 'item', 1);
  insert into public.thumbnail_swaps (user_id, video_id, to_role, reason)
  values (fx.user_a(), v_id, 'safe', 'first ship');

  delete from public.videos where id = v_id;

  select count(*) into n from public.checklist_items where video_id = v_id;
  if n <> 0 then raise exception 'FAILED: % checklist items outlived their video', n; end if;
  select count(*) into n from public.thumbnail_swaps where video_id = v_id;
  if n <> 0 then raise exception 'FAILED: % swap rows outlived their video', n; end if;
end $$;

do $$
declare n int;
begin
  -- A channel takes its stages, buckets, videos and templates with it. (There
  -- is no client delete policy for channels; this is the owner-side behaviour.)
  delete from public.channels where id = fx.channel('a-main');

  select count(*) into n from public.stages where channel_id = fx.channel('a-main');
  if n <> 0 then raise exception 'FAILED: % stages outlived their channel', n; end if;
  select count(*) into n from public.buckets where channel_id = fx.channel('a-main');
  if n <> 0 then raise exception 'FAILED: % buckets outlived their channel', n; end if;
  select count(*) into n from public.videos where id = fx.video_a();
  if n <> 0 then raise exception 'FAILED: the video outlived its channel'; end if;
  select count(*) into n from public.checklist_templates;
  if n <> 0 then raise exception 'FAILED: % checklist templates outlived their stage', n; end if;
end $$;

do $$
declare n int;
begin
  -- And deleting the account leaves nothing behind.
  delete from auth.users where id = fx.user_a();
  select count(*) into n from public.videos where user_id = fx.user_a();
  if n <> 0 then raise exception 'FAILED: % videos outlived their user', n; end if;
  select count(*) into n from public.channels where user_id = fx.user_a();
  if n <> 0 then raise exception 'FAILED: % channels outlived their user', n; end if;
  select count(*) into n from public.filming_days where user_id = fx.user_a();
  if n <> 0 then raise exception 'FAILED: % filming days outlived their user', n; end if;
end $$;

rollback;
