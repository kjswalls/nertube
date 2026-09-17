-- The logged-out path. PostgREST leaves request.jwt.claims as the EMPTY STRING
-- for an unauthenticated request rather than unsetting it, so auth.uid() must
-- read that as NULL. (It used to raise here, which came out of every policy and
-- every RPC and made this whole file impossible to write.)

begin;

set local request.jwt.claims = '';
set local role anon;

do $$
declare t text; n int;
begin
  if auth.uid() is not null then
    raise exception 'FAILED: auth.uid() is % with no claims', auth.uid();
  end if;

  -- Every table reads as empty: the policies compare user_id = null, which is
  -- never true.
  foreach t in array array['channels','stages','buckets','filming_days','videos',
                           'checklist_templates','checklist_items','thumbnail_swaps']
  loop
    execute format('select count(*) from public.%I', t) into n;
    if n <> 0 then raise exception 'FAILED: anon sees % rows in %', n, t; end if;
  end loop;
end $$;

-- Writes are refused rather than silently scoped: anon holds no EXECUTE on any
-- of the four functions, and nothing to insert with.
do $$
declare
  calls text[] := array[
    format('select public.move_video(%L::uuid, %L::uuid)', fx.video_a(), fx.video_a()),
    format('select public.swap_thumbnail(%L::uuid, %L, %L)', fx.video_a(), 'safe', 'why'),
    format('select public.capture_video(%L::uuid, %L)', fx.channel('a-main'), 'x'),
    'select public.create_channel(''n'', ''s'', ''t'', 5, 7, null, null, ''[]''::jsonb, ''[]''::jsonb)'
  ];
  i int; ok boolean; st text;
begin
  for i in 1 .. array_length(calls, 1) loop
    ok := false;
    begin
      execute calls[i];
    exception when others then
      get stacked diagnostics st = returned_sqlstate; ok := true;
    end;
    if not ok then raise exception 'FAILED: anon called %', calls[i]; end if;
    if st <> '42501' then raise exception 'FAILED: % gave %, expected 42501', calls[i], st; end if;
  end loop;
end $$;

-- A logged-in user is unaffected by the same empty-claims handling.
reset role;
select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

do $$
declare n int;
begin
  if auth.uid() <> fx.user_a() then raise exception 'FAILED: auth.uid() is %', auth.uid(); end if;
  select count(*) into n from public.channels;
  if n <> 2 then raise exception 'FAILED: A should see its 2 channels, saw %', n; end if;
end $$;

reset role;
rollback;
