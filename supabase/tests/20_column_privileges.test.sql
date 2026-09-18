-- The column privileges on videos are what make move_video / swap_thumbnail the
-- only write path for stage and shipped-role changes -- enforced by the
-- database, not by grep.

begin;

select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

do $$
declare
  cols text[] := array['stage_id','stage_entered_at','published_at','shipped_role'];
  vals text[] := array[
    format('%L::uuid', fx.stage(fx.channel('a-main'), 'packaging')),
    'now()', 'now()', $q$'safe'$q$];
  i int; ok boolean; st text; msg text;
begin
  for i in 1 .. array_length(cols, 1) loop
    ok := false;
    begin
      execute format('update public.videos set %I = %s where id = %L', cols[i], vals[i], fx.video_a());
    exception when others then
      get stacked diagnostics st = returned_sqlstate, msg = message_text;
      ok := true;
    end;
    if not ok then
      raise exception 'FAILED: a client-side update of videos.% succeeded', cols[i];
    end if;
    if st <> '42501' then
      raise exception 'FAILED: updating videos.% gave % (%), expected 42501', cols[i], st, msg;
    end if;
  end loop;
end $$;

-- videos.checklist_seeded_stages (0005): the marker that decides whether
-- entering a stage copies its templates. A client that could clear it could
-- re-seed a stage it had deliberately emptied, which is the whole defect that
-- migration exists to close -- so it is not in the granted column list.
do $$
declare ok boolean := false; st text; msg text;
begin
  begin
    update public.videos set checklist_seeded_stages = '{}'::uuid[]
     where id = fx.video_a();
  exception when others then
    get stacked diagnostics st = returned_sqlstate, msg = message_text;
    ok := true;
  end;
  if not ok then
    raise exception 'FAILED: a client cleared videos.checklist_seeded_stages';
  end if;
  if st <> '42501' then
    raise exception 'FAILED: updating checklist_seeded_stages gave % (%), expected 42501', st, msg;
  end if;
end $$;

-- Identity columns: a client may not rewrite a row's primary key or its
-- creation time (0003_identity_columns.sql). RLS and the composite FKs do not
-- cover these two, so the grant is what has to.
do $$
declare
  rows_ text[] := array['videos', 'stages'];
  cols text[] := array['id', 'created_at'];
  target uuid;
  t text; c text; ok boolean; st text; msg text;
begin
  foreach t in array rows_ loop
    target := case when t = 'videos' then fx.video_a()
                   else fx.stage(fx.channel('a-main'), 'idea') end;
    foreach c in array cols loop
      ok := false;
      begin
        execute format(
          'update public.%I set %I = %s where id = %L',
          t, c,
          case when c = 'id' then quote_literal(gen_random_uuid()) || '::uuid'
               else $q$'1999-01-01T00:00:00Z'::timestamptz$q$ end,
          target);
      exception when others then
        get stacked diagnostics st = returned_sqlstate, msg = message_text;
        ok := true;
      end;
      if not ok then
        raise exception 'FAILED: a client rewrote %.%', t, c;
      end if;
      if st <> '42501' then
        raise exception 'FAILED: updating %.% gave % (%), expected 42501', t, c, st, msg;
      end if;
    end loop;
  end loop;
end $$;

do $$
declare n int;
begin
  -- Positive control: the columns the client is supposed to own still work,
  -- otherwise this test would pass with UPDATE revoked altogether.
  -- `waiting_since` is paired with `waiting_on` by a CHECK since
  -- 0004_waiting_since.sql, so the two are written together here; that the
  -- client may write the new column at all is the point of including it.
  -- 65_waiting_since.test.sql is where the pairing itself is exercised.
  update public.videos
     set title = 'Working title',
         thumbnail_concept = 'Phone-tile readable',
         waiting_on = 'editor',
         waiting_since = now(),
         updated_at = now()
   where id = fx.video_a();
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: client cannot update the packaging fields (% rows)', n; end if;

  -- And capture still works — through capture_video, which is now the only way
  -- a client creates a video (see the INSERT block below).
  perform public.capture_video(fx.channel('a-main'), 'captured');
  select count(*) into n from public.videos where title = 'captured';
  if n <> 1 then raise exception 'FAILED: client cannot capture a video'; end if;
end $$;

-- The same four columns over INSERT. Revoking UPDATE alone would leave the gate
-- open on the other side: a client would simply create a video that is already
-- Published, with an empty title and a shipped_role of its choosing.
do $$
declare ok boolean := false; st text;
begin
  begin
    insert into public.videos (user_id, channel_id, stage_id, title, thumb_safe_path,
                               shipped_role, published_at, stage_entered_at)
    values (fx.user_a(), fx.channel('a-main'), fx.stage(fx.channel('a-main'), 'published'),
            '', 'u/v/safe.png', 'safe', now(), now());
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a client inserted a video straight into Published'; end if;
  if st <> '42501' then raise exception 'FAILED: expected 42501, got %', st; end if;
end $$;

-- capture_video always lands the row in the Idea stage, whatever it is asked for.
do $$
declare v public.videos;
begin
  select * into v from public.capture_video(fx.channel('a-main'), 'an idea');
  if v.stage_id <> fx.stage(fx.channel('a-main'), 'idea') then
    raise exception 'FAILED: capture_video did not use the Idea stage';
  end if;
  if v.published_at is not null or v.shipped_role is not null then
    raise exception 'FAILED: capture_video set a protected column';
  end if;
end $$;

-- stages.kind is immutable from a client, so the delete policy that keys on it
-- cannot be talked around by laundering a core stage into an inert one first.
do $$
declare ok boolean := false; st text; n int;
begin
  begin
    update public.stages set kind = null where channel_id = fx.channel('a-main');
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a client nulled stages.kind'; end if;
  if st <> '42501' then raise exception 'FAILED: expected 42501, got %', st; end if;

  -- Renaming and disabling a core stage still work (PLAN.md: "Core stages may
  -- be renamed and disabled, never deleted").
  update public.stages set name = 'Packaging', is_enabled = false
   where channel_id = fx.channel('a-main') and kind = 'packaging';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: a core stage could not be renamed'; end if;
end $$;

-- thumbnail_swaps is an append-only log with exactly one writer.
--
-- 0006 revoked the client INSERT grant as well. Until then the table was
-- append-only against *edits* but not against forgery: a client could write a
-- row describing a swap that never happened, without going through
-- swap_thumbnail and without shipped_role moving — and M4 reads this log as
-- truth (`/now` stops asking when a swap is logged after the metrics, and the
-- live slot prints its reason). The only writer now is swap_thumbnail, which is
-- security definer and runs as the owner.
do $$
declare ok boolean := false; st text;
begin
  begin
    insert into public.thumbnail_swaps (user_id, video_id, to_role, reason)
    values (fx.user_a(), fx.video_a(), 'moderate', 'a swap that never happened');
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a client forged a swap log row'; end if;
  if st <> '42501' then raise exception 'FAILED: expected 42501, got %', st; end if;
end $$;

-- The rest of the append-only claim, against a row the *owner* planted, since
-- a client can no longer make one: no UPDATE, no DELETE, and swapped_at is not
-- in any grant, so only the default now() can set it.
reset role;
insert into public.thumbnail_swaps (user_id, video_id, to_role, reason)
values (fx.user_a(), fx.video_a(), 'safe', 'first ship');
set local role authenticated;

do $$
declare ok boolean; st text; ts timestamptz;
begin
  ok := false;
  begin
    update public.thumbnail_swaps set reason = 'rewritten' where video_id = fx.video_a();
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a logged swap was rewritten'; end if;
  if st <> '42501' then raise exception 'FAILED: expected 42501, got %', st; end if;

  ok := false;
  begin
    delete from public.thumbnail_swaps where video_id = fx.video_a();
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: the swap log was erased'; end if;
  if st <> '42501' then raise exception 'FAILED: expected 42501, got %', st; end if;

  -- Refused twice over now: swapped_at was never in the column list, and since
  -- 0006 there is no client INSERT grant on the table at all. Kept because the
  -- column-list half is the one a future re-grant could quietly undo.
  ok := false;
  begin
    insert into public.thumbnail_swaps (user_id, video_id, to_role, reason, swapped_at)
    values (fx.user_a(), fx.video_a(), 'moderate', 'backdated', timestamptz '2020-01-01');
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a client backdated swapped_at'; end if;
  if st <> '42501' then raise exception 'FAILED: expected 42501, got %', st; end if;

  select swapped_at into ts from public.thumbnail_swaps where video_id = fx.video_a();
  if ts < now() - interval '1 minute' then
    raise exception 'FAILED: swapped_at was not stamped by the default';
  end if;
end $$;

-- The privilege is column-level, so it must survive an update that touches an
-- allowed column and a revoked one in the same statement.
do $$
declare ok boolean := false; st text;
begin
  begin
    update public.videos set title = 'x', shipped_role = 'safe' where id = fx.video_a();
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    ok := true;
  end;
  if not ok then raise exception 'FAILED: mixed allowed/revoked update succeeded'; end if;
  if st <> '42501' then raise exception 'FAILED: expected 42501, got %', st; end if;
end $$;

-- The catalogue itself: the four columns carry no UPDATE grant for authenticated.
reset role;
do $$
declare n int;
begin
  select count(*) into n
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'videos'
     and privilege_type = 'UPDATE' and grantee = 'authenticated'
     and column_name in ('stage_id','stage_entered_at','published_at','shipped_role');
  if n <> 0 then raise exception 'FAILED: % protected video columns are still UPDATE-grantable', n; end if;

  select count(*) into n
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'videos'
     and privilege_type = 'UPDATE' and grantee = 'authenticated';
  if n < 30 then raise exception 'FAILED: only % video columns are updatable; the re-grant is incomplete', n; end if;

  -- And the identity columns (0003_identity_columns.sql), on both tables.
  select count(*) into n
    from information_schema.column_privileges
   where table_schema = 'public' and table_name in ('videos', 'stages')
     and privilege_type = 'UPDATE' and grantee = 'authenticated'
     and column_name in ('id', 'created_at');
  if n <> 0 then raise exception 'FAILED: % identity columns are still UPDATE-grantable', n; end if;

  -- stages: every column but kind, id and created_at is updatable.
  select count(*) into n
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'stages'
     and privilege_type = 'UPDATE' and grantee = 'authenticated' and column_name = 'kind';
  if n <> 0 then raise exception 'FAILED: stages.kind is still UPDATE-grantable'; end if;

  select count(*) into n
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'stages'
     and privilege_type = 'UPDATE' and grantee = 'authenticated';
  if n <> 5 then raise exception 'FAILED: % stage columns are updatable, expected 5', n; end if;
end $$;

-- TRUNCATE is not subject to RLS, so a role holding it empties a table for every
-- tenant in one statement. Neither untrusted role may hold it (nor REFERENCES or
-- TRIGGER, which they equally have no use for).
do $$
declare r record;
begin
  for r in
    select c.relname, p.privilege, g.grantee
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     cross join unnest(array['TRUNCATE','REFERENCES','TRIGGER']) as p(privilege)
     cross join unnest(array['anon','authenticated'])            as g(grantee)
     where n.nspname = 'public' and c.relkind = 'r'
       and has_table_privilege(g.grantee, c.oid, p.privilege)
  loop
    raise exception 'FAILED: % still holds % on public.%', r.grantee, r.privilege, r.relname;
  end loop;
end $$;

rollback;
