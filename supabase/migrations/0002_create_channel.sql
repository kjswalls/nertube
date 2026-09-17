-- Creating a channel is a multi-row write, so it belongs in a function.
--
-- `createChannel` (app/actions/channels.ts) used to write the channel and then
-- three more batches — stages, checklist templates, buckets. supabase-js has no
-- transactions, so a failure after the first batch left a committed, half-seeded
-- channel behind, and PLAN.md deliberately gives `channels` no delete policy, so
-- nothing could clean it up from a client.
--
-- The first attempt at fixing that was a `discard_empty_channel(p_channel)` RPC.
-- It was the wrong shape: granted to `authenticated` and exposed through
-- PostgREST like any other function, it was a channel-delete button for any
-- channel of the caller's that happened to hold no videos — including a
-- long-lived, hand-configured one with a voice guide, an edited script template
-- and its buckets. That is exactly what "no delete policy in v1" exists to
-- prevent. It is replaced here rather than guarded, because the real problem was
-- that the write was not atomic in the first place.
--
-- So: one function, one transaction. Either the channel and everything it needs
-- to be usable exist, or nothing does — and there is no delete path at all.
-- The seed content itself still lives in one place, `lib/defaults.ts`; it is
-- handed in as jsonb rather than duplicated in SQL.
--
-- p_stages:  [{"name":…,"kind":…,"position":1,
--              "templates":[{"text":…,"position":1,"est_minutes":15}]}, …]
-- p_buckets: [{"axis":"horizontal","name":…,"position":1,"monthly_quota":null}, …]
--
-- Same shape as move_video/swap_thumbnail: security definer, pinned
-- search_path, and the caller's own auth.uid() stamped on every row.

create function public.create_channel(
  p_name            text,
  p_slug            text,
  p_script_template text,
  p_wip_threshold   int,
  p_stale_days      int,
  p_expected_ctr    numeric,
  p_voice_guide     text,
  p_stages          jsonb,
  p_buckets         jsonb
) returns public.channels
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_channel public.channels;
  v_stage   uuid;
  s         jsonb;
  t         jsonb;
  b         jsonb;
begin
  if v_uid is null then
    raise exception 'not signed in';
  end if;
  if coalesce(p_name, '') = '' or coalesce(p_slug, '') = '' then
    raise exception 'a channel needs a name and a slug';
  end if;

  insert into public.channels (
    user_id, name, slug, script_template, wip_threshold, stale_days,
    expected_ctr, voice_guide
  )
  values (
    v_uid, p_name, p_slug, p_script_template, p_wip_threshold, p_stale_days,
    p_expected_ctr, p_voice_guide
  )
  returning * into v_channel;

  for s in select * from jsonb_array_elements(coalesce(p_stages, '[]'::jsonb)) loop
    insert into public.stages (user_id, channel_id, name, position, kind)
    values (v_uid, v_channel.id, s ->> 'name', (s ->> 'position')::int, s ->> 'kind')
    returning id into v_stage;

    for t in select * from jsonb_array_elements(coalesce(s -> 'templates', '[]'::jsonb)) loop
      insert into public.checklist_templates (user_id, stage_id, text, position, est_minutes)
      values (v_uid, v_stage, t ->> 'text', (t ->> 'position')::int, (t ->> 'est_minutes')::int);
    end loop;
  end loop;

  for b in select * from jsonb_array_elements(coalesce(p_buckets, '[]'::jsonb)) loop
    insert into public.buckets (user_id, channel_id, axis, name, position, monthly_quota)
    values (v_uid, v_channel.id, b ->> 'axis', b ->> 'name',
            (b ->> 'position')::int, (b ->> 'monthly_quota')::int);
  end loop;

  return v_channel;
end;
$$;

-- With create_channel in place, a client has no reason to insert a channel row
-- directly — and every reason not to: a bare channel with no stages is a dead
-- board that, having no delete policy, can never be got rid of.
revoke insert on public.channels from anon, authenticated;

revoke all on function public.create_channel(text, text, text, int, int, numeric, text, jsonb, jsonb)
  from public, anon;
grant execute on function public.create_channel(text, text, text, int, int, numeric, text, jsonb, jsonb)
  to authenticated, service_role;
