-- The private thumbnails bucket and its policy. Object paths are
-- {user_id}/{video_id}/{concept|wild_card|moderate|safe}.{ext}, so the policy
-- keys on the first path segment.

begin;

do $$
declare b record;
begin
  select * into b from storage.buckets where id = 'thumbnails';
  if b.id is null then raise exception 'FAILED: the thumbnails bucket was not created'; end if;
  if b.public then raise exception 'FAILED: the thumbnails bucket is public'; end if;
end $$;

-- An object already in A's folder, planted as the owner.
insert into storage.objects (bucket_id, name, owner)
values ('thumbnails', fx.user_a() || '/' || fx.video_a() || '/concept.png', fx.user_a());

select set_config('request.jwt.claims', json_build_object('sub', fx.user_b())::text, true);
set local role authenticated;

do $$
declare ok boolean := false; st text; n int;
begin
  -- B uploading into A's folder.
  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('thumbnails', fx.user_a() || '/' || fx.video_a() || '/safe.png', fx.user_b());
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: B wrote into A''s storage folder'; end if;
  if st <> '42501' then raise exception 'FAILED: expected 42501, got %', st; end if;

  -- B cannot read, rename or delete A's objects either.
  select count(*) into n from storage.objects;
  if n <> 0 then raise exception 'FAILED: B can see % of A''s objects', n; end if;

  update storage.objects set name = fx.user_b() || '/stolen.png' where bucket_id = 'thumbnails';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: B renamed % of A''s objects', n; end if;

  delete from storage.objects where bucket_id = 'thumbnails';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: B deleted % of A''s objects', n; end if;
end $$;

reset role;
select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

do $$
declare n int;
begin
  -- A owns its own folder (positive control).
  insert into storage.objects (bucket_id, name, owner)
  values ('thumbnails', fx.user_a() || '/' || fx.video_a() || '/safe.png', fx.user_a());

  select count(*) into n from storage.objects;
  if n <> 2 then raise exception 'FAILED: A should see its 2 objects, saw %', n; end if;

  delete from storage.objects
   where name = fx.user_a() || '/' || fx.video_a() || '/safe.png';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAILED: A cannot delete its own object'; end if;
end $$;

-- storage.buckets carries RLS with no policy for the client roles, so a client
-- can neither see the bucket list nor flip the private thumbnails bucket public.
do $$
declare ok boolean := false; st text; n int;
begin
  select count(*) into n from storage.buckets;
  if n <> 0 then raise exception 'FAILED: a client can list % storage buckets', n; end if;

  update storage.buckets set public = true where id = 'thumbnails';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAILED: a client made the thumbnails bucket public'; end if;

  begin
    insert into storage.buckets (id, name, public) values ('mine', 'mine', true);
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: a client created a public storage bucket'; end if;
  if st <> '42501' then raise exception 'FAILED: expected 42501, got %', st; end if;
end $$;

do $$
declare ok boolean := false; st text;
begin
  -- The policy is keyed on the bucket too: another bucket is not covered.
  -- Created as the owner, since clients cannot write storage.buckets.
  reset role;
  insert into storage.buckets (id, name, public) values ('other', 'other', false);
  set local role authenticated;
  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('other', fx.user_a() || '/x.png', fx.user_a());
  exception when others then
    get stacked diagnostics st = returned_sqlstate; ok := true;
  end;
  if not ok then raise exception 'FAILED: the storage policy is not scoped to the thumbnails bucket'; end if;
  if st <> '42501' then raise exception 'FAILED: expected 42501, got %', st; end if;
end $$;

reset role;
rollback;
