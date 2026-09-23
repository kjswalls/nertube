-- videos.brainstorm_last has exactly one write path, and it merges rather than
-- replaces.
--
-- The M8 review found two brainstorms in flight at once destroying each
-- other's answer: the action read the whole envelope, spent 10-40 seconds in
-- the model, and wrote back an envelope built from that stale snapshot. These
-- cases hold the fix shut from the database's side.

begin;

select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

-- 1. The column is no longer in the client's UPDATE grant (0009).
do $$
declare st text; msg text;
begin
  begin
    update public.videos set brainstorm_last = '{"v":1}'::jsonb where id = fx.video_a();
    raise exception 'FAILED: a client-side update of videos.brainstorm_last succeeded';
  exception when insufficient_privilege then
    null;
  end;
end $$;

-- 2. A second kind merges into the first rather than replacing the envelope --
--    which is the interleaving that used to lose twenty titles.
do $$
declare v public.videos;
begin
  perform public.merge_brainstorm_entry(
    fx.video_a(), 'titles',
    '{"at":"2026-01-01T00:00:00.000Z","provider":"fake","model":"fixtures",
      "voiceGuide":false,"recommended":0,"recommendedReason":null,
      "suggestions":[{"text":"A title","rationale":"because"}]}'::jsonb);

  perform public.merge_brainstorm_entry(
    fx.video_a(), 'hooks',
    '{"at":"2026-01-01T00:00:01.000Z","provider":"fake","model":"fixtures",
      "voiceGuide":false,"recommended":0,"recommendedReason":null,
      "suggestions":[{"text":"A hook","rationale":"because"}]}'::jsonb);

  select * into v from public.videos where id = fx.video_a();

  if v.brainstorm_last -> 'titles' is null then
    raise exception 'FAILED: writing hooks destroyed the stored titles';
  end if;
  if v.brainstorm_last -> 'hooks' is null then
    raise exception 'FAILED: the hooks entry was not written';
  end if;
  if (v.brainstorm_last ->> 'v') <> '1' then
    raise exception 'FAILED: the envelope version is %, expected 1', v.brainstorm_last ->> 'v';
  end if;
  if (v.brainstorm_last -> 'titles' -> 'suggestions' ->> 0) is null then
    raise exception 'FAILED: the titles entry lost its suggestions';
  end if;
end $$;

-- 3. Re-asking the same kind replaces that key and leaves the other alone.
do $$
declare v public.videos;
begin
  perform public.merge_brainstorm_entry(
    fx.video_a(), 'titles',
    '{"at":"2026-01-01T00:00:02.000Z","provider":"fake","model":"fixtures",
      "voiceGuide":true,"recommended":null,"recommendedReason":null,
      "suggestions":[{"text":"A better title","rationale":"because"}]}'::jsonb);

  select * into v from public.videos where id = fx.video_a();
  if (v.brainstorm_last -> 'titles' -> 'suggestions' -> 0 ->> 'text') <> 'A better title' then
    raise exception 'FAILED: the titles entry was not replaced';
  end if;
  if (v.brainstorm_last -> 'hooks' -> 'suggestions' -> 0 ->> 'text') <> 'A hook' then
    raise exception 'FAILED: replacing titles disturbed the hooks entry';
  end if;
end $$;

-- 4. An empty answer never reaches the column: it reads back as absent, so
--    storing one would destroy what is kept while reporting success.
do $$
begin
  begin
    perform public.merge_brainstorm_entry(
      fx.video_a(), 'titles',
      '{"at":"2026-01-01T00:00:03.000Z","provider":"fake","model":"fixtures",
        "voiceGuide":false,"recommended":null,"recommendedReason":null,
        "suggestions":[]}'::jsonb);
    raise exception 'FAILED: an entry with no suggestions was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
  end;
end $$;

-- 5. An unknown kind is refused rather than inventing a key in the envelope.
do $$
begin
  begin
    perform public.merge_brainstorm_entry(
      fx.video_a(), 'thumbnail_critique',
      '{"suggestions":[{"text":"x","rationale":"y"}]}'::jsonb);
    raise exception 'FAILED: an unknown brainstorm kind was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
  end;
end $$;

-- 6. Somebody else's video is not one you can write to, security definer or
--    not: the ownership check is the function's first act.
do $$
begin
  begin
    perform public.merge_brainstorm_entry(
      fx.video_b(), 'titles',
      '{"suggestions":[{"text":"x","rationale":"y"}]}'::jsonb);
    raise exception 'FAILED: wrote a brainstorm onto another user''s video';
  exception when raise_exception then
    if sqlerrm like 'FAILED:%' then raise; end if;
  end;
end $$;

rollback;
