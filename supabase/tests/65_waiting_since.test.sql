-- `waiting_on` / `waiting_since` are set together and cleared together
-- (0004_waiting_since.sql), and a client may write both.
--
-- The pairing is what stops `/now` inventing an age: a row that says it is
-- blocked but not since when is unrepresentable, so rule 4 of the ranking can
-- render "waiting N days" from a column instead of from a guess.

begin;

-- ------------------------------------------------- the CHECK, as the owner ---

do $$
declare
  cases text[][] := array[
    ['waiting_on with no waiting_since', $s$waiting_on = 'the editor'$s$],
    ['waiting_since with no waiting_on', $s$waiting_since = now()$s$],
    ['clearing only the text',
       $s$waiting_on = null, waiting_since = now()$s$],
    ['clearing only the stamp',
       $s$waiting_on = 'the editor', waiting_since = null$s$]
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
      raise exception 'FAILED: % gave %, expected a CHECK violation (23514)', cases[i][1], st;
    end if;
  end loop;
end $$;

-- ------------------------------------------ the pair, as the signed-in user ---

select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

do $$
declare v public.videos;
begin
  -- Set: both columns, one statement. This is the write `updateVideoFlow`
  -- makes, so if the grant on waiting_since were missing this fails with 42501.
  update public.videos
     set waiting_on = 'the editor', waiting_since = now(), updated_at = now()
   where id = fx.video_a();

  select * into v from public.videos where id = fx.video_a();
  if v.waiting_on is distinct from 'the editor' then
    raise exception 'FAILED: waiting_on did not stick';
  end if;
  if v.waiting_since is null then
    raise exception 'FAILED: waiting_since did not stick';
  end if;

  -- Clear: both back to null together.
  update public.videos
     set waiting_on = null, waiting_since = null, updated_at = now()
   where id = fx.video_a();

  select * into v from public.videos where id = fx.video_a();
  if v.waiting_on is not null or v.waiting_since is not null then
    raise exception 'FAILED: clearing the block left a column behind';
  end if;
end $$;

rollback;
