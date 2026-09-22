-- Stage rules: core stages are undeletable from any client, one canonical stage
-- per kind per channel, and position swaps run as a single statement against a
-- deferred unique.

begin;

select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

do $$
declare n int;
begin
  -- The delete policy is restricted to kind is null: core stages cannot be
  -- deleted from any client. RLS filters rather than errors, so this is a
  -- silent zero-row delete. Start with a core stage holding no videos, so a
  -- loosened policy shows up here and not as some later FK error.
  delete from public.stages where channel_id = fx.channel('a-main') and kind = 'repurposed';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: the client deleted an empty core stage'; end if;

  delete from public.stages where kind is not null;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: the client deleted % core stages', n; end if;

  delete from public.stages where kind = 'idea';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: the client deleted the Idea stage'; end if;

  select count(*) into n from public.stages where channel_id = fx.channel('a-main') and kind is not null;
  if n <> 9 then raise exception 'FAILED: a-main should still have 9 core stages, has %', n; end if;

  -- Inert, user-added stages are deletable (positive control).
  delete from public.stages where channel_id = fx.channel('a-main') and kind is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: an inert stage should be deletable, deleted %', n; end if;
end $$;

-- The delete policy alone is not the guarantee: it keys on `kind`, so the two
-- statement version of the same attack is `update stages set kind = null` and
-- then delete. That is what the UPDATE revoke on stages.kind is for.
do $$
declare ok boolean := false; st text; n int;
begin
  begin
    update public.stages set kind = null
     where channel_id = fx.channel('a-main') and kind = 'repurposed';
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a core stage was laundered into an inert one'; end if;
  if st <> '42501' then raise exception 'FAILED: expected 42501, got %', st; end if;

  -- Belt and braces: even a whole-table attempt leaves all nine kinds in place,
  -- and the delete that would have followed still finds nothing to remove.
  begin
    update public.stages set kind = null where user_id = auth.uid();
  exception when others then
    null;
  end;
  delete from public.stages where channel_id = fx.channel('a-main') and kind is null;

  select count(*) into n from public.stages
   where channel_id = fx.channel('a-main') and kind is not null;
  if n <> 9 then raise exception 'FAILED: a-main is down to % core stages', n; end if;
end $$;

-- The two blocks below are about the constraint, not the grant, so they run as
-- the owner: since 0007_stage_settings.sql a client cannot write `position` at
-- all and goes through reorder_stages(), which 35_stage_settings.test.sql
-- exercises. What is proved here is the property that function relies on.
-- Since 0008_settings_boundary.sql the same is true of `kind` on INSERT: a
-- client insert may not name it (20_column_privileges.test.sql), so the
-- partial unique below is exercised as the owner too.
reset role;

do $$
declare ok boolean := false; st text;
begin
  -- Partial unique (channel_id, kind) where kind is not null.
  begin
    insert into public.stages (user_id, channel_id, name, position, kind)
    values (fx.user_a(), fx.channel('a-main'), 'Packaging again', 11, 'packaging');
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    ok := true;
  end;
  if not ok then raise exception 'FAILED: a second packaging stage was accepted'; end if;
  if st <> '23505' then raise exception 'FAILED: expected 23505, got %', st; end if;
end $$;

do $$
declare n int;
begin
  -- ... but any number of inert stages, because the unique index is partial.
  insert into public.stages (user_id, channel_id, name, position, kind) values
    (fx.user_a(), fx.channel('a-main'), 'Sponsor review', 11, null),
    (fx.user_a(), fx.channel('a-main'), 'Legal check',    12, null);
  select count(*) into n from public.stages where channel_id = fx.channel('a-main') and kind is null;
  if n <> 2 then raise exception 'FAILED: inert stages are constrained by kind, got %', n; end if;
end $$;


do $$
declare
  a uuid := fx.stage(fx.channel('a-main'), 'filming');
  b uuid := fx.stage(fx.channel('a-main'), 'editing');
  pa int; pb int;
begin
  select s.position into pa from public.stages s where s.id = a;
  select s.position into pb from public.stages s where s.id = b;

  -- A swap is ONE statement; the intermediate state collides, which only a
  -- DEFERRABLE INITIALLY DEFERRED unique tolerates.
  update public.stages s
     set position = case when s.id = a then pb else pa end
   where s.id in (a, b);

  -- Force the deferred check now rather than at commit (this test rolls back).
  set constraints all immediate;

  select s.position into pa from public.stages s where s.id = a;
  select s.position into pb from public.stages s where s.id = b;
  if pa <> 5 or pb <> 4 then
    raise exception 'FAILED: positions after the swap are %/% (expected 5/4)', pa, pb;
  end if;
  set constraints all deferred;
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- The constraint is deferred, not absent: a real duplicate still fails, just
  -- at the point the check is forced.
  update public.stages s set position = 1
   where s.channel_id = fx.channel('a-main') and s.kind = 'editing';
  begin
    set constraints all immediate;
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    ok := true;
  end;
  if not ok then raise exception 'FAILED: two stages share position 1'; end if;
  if st <> '23505' then raise exception 'FAILED: expected 23505, got %', st; end if;
end $$;

rollback;
