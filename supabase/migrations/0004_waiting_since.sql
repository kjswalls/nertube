-- `videos.waiting_since`: when the current block started.
--
-- PLAN.md's `/now` ranking, rule 4: *`waiting_on` set → **Waiting**, with age,
-- `clear_waiting`*. `waiting_on` is one of the three genuinely stored inputs
-- that view reads (the rest of `/now` is derived), and the age it wants is *how
-- long this video has been blocked* — which nothing in 0001_init.sql records.
--
-- The columns that were there cannot stand in for it:
--
--   * `updated_at` is stamped by every field on the detail page, so a note
--     edited this evening would report a three-week block as "today".
--   * `stage_entered_at` is how long the card has been in its column, which is
--     a different number and is already shown as such on the card.
--
-- So the age would have to be either invented or not shown. This adds the one
-- column that makes it true, and pairs it with the text the way
-- `packaging_skipped_at` is paired with its reason in 0001_init.sql: the two
-- are set together and cleared together, and the database — not the server
-- action — is what says so. A `waiting_on` with no `waiting_since` is exactly
-- the state that would make `/now` lie about an age, so it is unrepresentable.
alter table public.videos
  add column waiting_since timestamptz;

alter table public.videos
  add constraint videos_waiting_since_paired
  check ((waiting_on is null) = (waiting_since is null));

-- 0001_init.sql replaced the table-level UPDATE grant on videos with an
-- explicit column list, so a new column starts with no client UPDATE privilege
-- at all and has to be named here. It is an ordinary user-owned field —
-- `updateVideo` writes it alongside `waiting_on` in one statement, which is
-- what the CHECK above requires — so it joins the granted list rather than the
-- revoked one.
grant update (waiting_since) on public.videos to authenticated;
