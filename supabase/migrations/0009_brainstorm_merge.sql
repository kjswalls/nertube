-- 0009 — one atomic write for videos.brainstorm_last.
--
-- M8's review found that two brainstorms in flight at once silently destroy
-- each other's stored answer while both report success. `app/actions/assist.ts`
-- read the whole `brainstorm_last` envelope at the start of the call, spent
-- ten to forty seconds in the model, and then wrote back an envelope rebuilt
-- from that snapshot. The later writer therefore overwrote the earlier
-- writer's key with whatever had been in the column *before* the earlier call
-- ran, and the action still answered `persisted: true`, because the UPDATE
-- succeeded. Reproduced against the real stack with two adjacent clicks
-- ("Generate 20", then "Draft a third"): both said they were kept, and only
-- one was.
--
-- That is the one job PLAN.md gives the column — "the most recent brainstorm
-- result, so closing the panel loses nothing" — so the merge moves into the
-- database, where the read and the write are one statement. The application
-- sends the kind and that kind's entry, never the whole envelope, so there is
-- no snapshot to go stale and nothing a slow call can clobber.
--
-- Same shape as the other eight functions: security definer (the column
-- privileges below would block an invoker function), pinned search_path,
-- ownership proved first, and the client's column grant removed afterwards so
-- this is the only way in.

-- --------------------------------------------- merge_brainstorm_entry -----

create function public.merge_brainstorm_entry(
  p_video uuid,
  p_kind  text,
  p_entry jsonb
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  -- The three text assists. The thumbnail critique is deliberately not stored
  -- at all (it judges bytes that can be replaced), so it has no key here.
  if p_kind is null or p_kind not in ('titles', 'concepts', 'hooks') then
    raise exception 'unknown brainstorm kind %', coalesce(p_kind, '<null>');
  end if;

  if p_entry is null or jsonb_typeof(p_entry) <> 'object' then
    raise exception 'a brainstorm entry must be a json object';
  end if;

  -- An entry with no suggestions reads back as *absent* on the application
  -- side, so writing one does not store an empty answer: it destroys whatever
  -- was being kept, while the call reports success. `lib/assist/clamp.ts`
  -- refuses to produce one and `components/assist/stored.ts` refuses to write
  -- one; this is the backstop at the column itself.
  if jsonb_typeof(p_entry -> 'suggestions') <> 'array'
     or jsonb_array_length(p_entry -> 'suggestions') = 0 then
    raise exception 'a brainstorm entry must carry at least one suggestion';
  end if;

  update public.videos
     set brainstorm_last =
           case
             when jsonb_typeof(brainstorm_last) = 'object' then brainstorm_last
             else '{}'::jsonb
           end
           || jsonb_build_object('v', 1)
           || jsonb_build_object(p_kind, p_entry)
   where id = p_video
     and user_id = v_uid;

  if not found then
    raise exception 'video % not found for this user', p_video;
  end if;

  return true;
end;
$$;

-- `from public, anon`, not `from public` alone: Supabase's default privileges
-- grant EXECUTE to anon directly at creation time, and a revoke from PUBLIC
-- does not touch a direct grant. Every other function here says the same.
revoke all on function public.merge_brainstorm_entry(uuid, text, jsonb) from public, anon;
grant execute on function public.merge_brainstorm_entry(uuid, text, jsonb) to authenticated;

-- ------------------------------------------------- column privileges -----
--
-- 0001 dropped the table-level UPDATE grant on videos and re-granted the
-- columns one by one, so a column-level revoke bites here (it would silently
-- do nothing against a table-level grant). With `brainstorm_last` out of the
-- list the function above is the only write path, which is what makes the
-- atomicity a property of the schema rather than a convention in one action.
revoke update (brainstorm_last) on public.videos from authenticated;
