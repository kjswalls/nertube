-- 0006 — close two doors M0 left ajar, both of which M4 is the first milestone
-- to depend on.
--
-- Nothing in the application used either of them; both are removals, and the
-- application needs no change. They are here rather than edited into
-- `0001_init.sql` because a migration that has been applied is history.

-- ------------------------------------------------- 1. the swap log ---------
--
-- `thumbnail_swaps` was append-only against *edits* — no UPDATE, no DELETE,
-- and `swapped_at` kept out of the INSERT grant so only the column default can
-- set it — but a direct INSERT grant remained. That let a client write log rows
-- describing swaps that never happened: a row saying wild card → moderate,
-- with a reason, without going through `swap_thumbnail` and without
-- `shipped_role` moving at all.
--
-- Before M4 nothing read the log, so it was a tidy table with a hole in it.
-- M4 reads it as truth in two places: `lib/now-data.ts` derives `lastSwapAt`
-- from it to stop `/now` asking about a swap that has already happened, and the
-- Thumbnails section prints "Live since <date> — <reason>" on the live slot
-- from its newest matching row. A forged row silences the prompt and mislabels
-- the live variant.
--
-- `swap_thumbnail` is `security definer` and runs as the function's owner,
-- which is also the table's owner, so it is unaffected by a revoke aimed at the
-- client roles — exactly the shape `public.videos` already uses for INSERT.
-- After this the log has precisely one writer.
revoke insert on public.thumbnail_swaps from anon, authenticated;

-- The policy went with the grant. A policy that permits an INSERT no role may
-- perform is a statement about the system that is no longer true, and reading
-- it later as "clients may append to the log" is exactly the mistake this
-- migration is correcting.
drop policy if exists thumbnail_swaps_insert on public.thumbnail_swaps;

-- --------------------------------------------- 2. the bucket's ceiling -----
--
-- `lib/storage.ts` refuses a non-image or anything over 5 MB in the browser and
-- says, in its own doc comment, that this *is not security* — it runs where the
-- person can skip it, and the server action that follows never sees the bytes,
-- so it cannot re-check them. It then points at the `thumbnails owner rw`
-- policy as the real boundary. That policy decides **who** may write **where**;
-- it has never had an opinion about **what**. So a user's own token could put
-- 20 MB of `text/html` at a legitimate variant path, and the signed URL served
-- it back with that type.
--
-- The bucket row is where Storage itself enforces the rule, and these are the
-- same number and the same list `MAX_SKETCH_BYTES` and `CONCEPT_SKETCH_TYPES`
-- already hold. With this, the browser check becomes the fast, legible half of
-- a rule that is actually enforced somewhere.
--
-- Guarded, because the two columns belong to Supabase's own Storage schema:
-- a hosted project has them, and the SQL harness's stand-in gains them in
-- `supabase/tests/shim.sql`. Where they are absent this is a no-op rather than
-- a migration that will not apply.
do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'storage'
       and table_name = 'buckets'
       and column_name = 'file_size_limit'
  ) and exists (
    select 1
      from information_schema.columns
     where table_schema = 'storage'
       and table_name = 'buckets'
       and column_name = 'allowed_mime_types'
  ) then
    execute $q$
      update storage.buckets
         set file_size_limit = 5242880,
             allowed_mime_types = array[
               'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'
             ]
       where id = 'thumbnails'
    $q$;
  end if;
end
$$;
