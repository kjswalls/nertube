-- create_channel(): a channel and its whole seed in one transaction, and no
-- other way for a client to make one. PLAN.md gives `channels` no delete policy,
-- so a channel that arrives half-built can never be cleaned up -- which is why
-- it must not be possible to build one half way.

begin;

select set_config('request.jwt.claims',
                  json_build_object('sub', 'a0000000-0000-4000-8000-00000000000a')::text, true);
set local role authenticated;

-- The happy path, with the seed shaped the way lib/defaults.ts hands it over.
do $$
declare c public.channels; n int; v_stage uuid;
begin
  select * into c from public.create_channel(
    'Third Channel', 'third-channel', E'## Hook (verbatim)\n{{hook}}\n',
    5, 7, null, null,
    '[{"name":"Idea","kind":"idea","position":1,"templates":[]},
      {"name":"Packaging (TTH)","kind":"packaging","position":2,
       "templates":[{"text":"Generated 10-20 title candidates, not 3","position":1,"est_minutes":15},
                    {"text":"Searched YouTube for this topic","position":2,"est_minutes":15}]},
      {"name":"Published","kind":"published","position":3,"templates":[]}]'::jsonb,
    '[{"axis":"horizontal","name":"tutorial","position":1,"monthly_quota":null},
      {"axis":"vertical","name":"money","position":1,"monthly_quota":2}]'::jsonb);

  if c.user_id <> fx.user_a() then raise exception 'FAILED: the channel is not owned by the caller'; end if;
  if c.slug <> 'third-channel' then raise exception 'FAILED: slug is %', c.slug; end if;
  if c.wip_threshold <> 5 or c.stale_days <> 7 then
    raise exception 'FAILED: channel defaults were not applied';
  end if;

  select count(*) into n from public.stages where channel_id = c.id;
  if n <> 3 then raise exception 'FAILED: % stages seeded, expected 3', n; end if;

  select id into v_stage from public.stages where channel_id = c.id and kind = 'packaging';
  select count(*) into n from public.checklist_templates where stage_id = v_stage;
  if n <> 2 then raise exception 'FAILED: % packaging templates seeded, expected 2', n; end if;

  select count(*) into n from public.buckets where channel_id = c.id;
  if n <> 2 then raise exception 'FAILED: % buckets seeded, expected 2', n; end if;

  select count(*) into n from public.buckets
   where channel_id = c.id and axis = 'vertical' and monthly_quota = 2;
  if n <> 1 then raise exception 'FAILED: monthly_quota was lost in the jsonb round trip'; end if;

  -- Every seeded row is stamped with the caller, never left to a default.
  select count(*) into n from public.stages where channel_id = c.id and user_id <> fx.user_a();
  if n <> 0 then raise exception 'FAILED: % seeded stages are owned by someone else', n; end if;
end $$;

-- All or nothing: a seed that violates a constraint takes the channel with it.
do $$
declare ok boolean := false; st text; n int;
begin
  begin
    perform public.create_channel(
      'Doomed', 'doomed', 'x', 5, 7, null, null,
      -- two stages of the same kind: the partial unique (channel_id, kind) bites
      '[{"name":"Idea","kind":"idea","position":1},
        {"name":"Idea again","kind":"idea","position":2}]'::jsonb,
      '[]'::jsonb);
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a duplicate core stage was seeded'; end if;
  if st <> '23505' then raise exception 'FAILED: expected 23505, got %', st; end if;

  -- and the channel row did not survive the failed seed
  select count(*) into n from public.channels where slug = 'doomed';
  if n <> 0 then raise exception 'FAILED: a half-seeded channel was left behind'; end if;
end $$;

-- The duplicate-slug case the action reports back to the user.
do $$
declare ok boolean := false; st text;
begin
  begin
    perform public.create_channel('A Main again', 'a-main', 'x', 5, 7, null, null,
                                  '[]'::jsonb, '[]'::jsonb);
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a duplicate slug was accepted'; end if;
  if st <> '23505' then raise exception 'FAILED: expected 23505, got %', st; end if;
end $$;

-- There is no other route: a bare channel insert is refused outright, so an
-- unseeded (and therefore undeletable) channel cannot be created at all.
do $$
declare ok boolean := false; st text;
begin
  begin
    insert into public.channels (name, slug, script_template) values ('Bare', 'bare', 'x');
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a client inserted a channel directly'; end if;
  if st <> '42501' then raise exception 'FAILED: expected 42501, got %', st; end if;
end $$;

-- And still no way to delete one.
do $$
declare n int;
begin
  delete from public.channels where slug = 'third-channel';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: a client deleted % channels', n; end if;
end $$;

rollback;
