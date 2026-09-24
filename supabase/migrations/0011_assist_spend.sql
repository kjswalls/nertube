-- 0011 — what the brainstorm has cost, and the ceiling on it (M11).
--
-- Until now the assist had no spending ceiling (README, "Honest limits"; M8's
-- review, finding 1): every press of a pill with a key configured was a live
-- call, and nothing counted them. This adds the count and the ceiling.
--
-- ## Two tables
--
-- `assist_usage` — one row per real API call that billed something: who, when,
-- the model that actually served it (a server-side fallback can answer with a
-- different model than the one asked for), the four token counts the API
-- reports, and the cost in integer micro-dollars. The fixtures record nothing
-- and neither does a paste from claude.ai: neither costs this account money.
--
-- `assist_caps` — the per-user monthly cap, in whole dollars. A sibling of
-- `profiles` rather than a column on it, deliberately: `set_time_zone()` reads
-- "a profiles row exists" as "a zone has been recorded", and a detected zone
-- never overwrites an existing row. A cap saved before any zone would have
-- created that row and silently switched detection off. The cap has three
-- states, and the row says which:
--   no row                → never set: the application's default ($10) applies;
--   row, cap_dollars null → set to "no cap";
--   row, cap_dollars n    → n dollars a calendar month.
-- The default lives in the application (`lib/assist/spend.ts`), not here, so
-- the one sentence that states it and the one number that enforces it are in
-- the same file.
--
-- ## Who can forge a row
--
-- The app has no service-role key (README, "Environment variables"), so the
-- server action that records a call talks to the database with the signed-in
-- user's own session — exactly the credential the browser holds. There is
-- therefore no function the server can call that the browser cannot, and a
-- signed-in client can always call `record_assist_usage` with numbers it made
-- up. What the design guarantees instead is that a forged row can only hurt
-- the person who forged it:
--
--   * the client holds no INSERT, UPDATE or DELETE on `assist_usage` (and no
--     TRUNCATE on anything), so a real row, once written, cannot be lowered,
--     edited or removed — the month's spend can only go up;
--   * `record_assist_usage` writes `user_id = auth.uid()` and
--     `created_at = now()`, so a row cannot be charged to somebody else or
--     backdated into last month;
--   * every number is checked non-negative and bounded, so a row cannot carry
--     a negative cost that subtracts from the month.
--
-- A forged row adds spend to the forger's own month and can at worst lock
-- them out of their own API calls — which the cap field in Settings undoes.
-- Closing the gap fully needs a secret the server holds and the browser does
-- not (a service-role key or a shared signing secret in the database), which
-- this deployment deliberately does not have. Recorded in docs/MILESTONES.md.
--
-- ## The month
--
-- "This month" is the calendar month in the user's own zone. The application
-- computes the two instants that bound it (`lib/calendar-dates.ts`, the one
-- date interpretation) and asks `assist_budget(from, to)` for the sum. The
-- function takes instants rather than a zone so there is one place that turns
-- a zone into a month, and it is the one the rest of the app already trusts.
--
-- Same shape as the other functions: security definer where it writes, pinned
-- search_path, EXECUTE for authenticated only.

-- ------------------------------------------------------- assist_usage -----

create table public.assist_usage (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null default auth.uid()
                                references auth.users (id) on delete cascade,
  created_at                  timestamptz not null default now(),
  -- The video the call was about, when there was one. Tenant-bound like every
  -- other child: a call can only be filed against the caller's own video. A
  -- deleted video (the owner's own cascade; clients cannot delete videos)
  -- keeps its spend: the column is cleared, the row and its cost stay.
  video_id                    uuid,
  kind                        text not null,
  outcome                     text not null,
  requested_model             text not null,
  model                       text not null,
  -- True when the served model was not in the application's price table and
  -- was priced at the most expensive entry instead. Settings says so.
  price_assumed               boolean not null default false,
  input_tokens                integer not null default 0,
  output_tokens               integer not null default 0,
  cache_read_input_tokens     integer not null default 0,
  cache_creation_input_tokens integer not null default 0,
  cost_micros                 bigint not null,
  constraint assist_usage_video_fk foreign key (video_id, user_id)
    references public.videos (id, user_id) on delete set null (video_id),
  constraint assist_usage_kind_known check (
    kind in ('titles', 'concepts', 'hooks', 'thumbnail_critique')
  ),
  constraint assist_usage_outcome_known check (
    outcome in ('answered', 'failed', 'refused')
  ),
  constraint assist_usage_models_shape check (
    length(requested_model) between 1 and 100 and length(model) between 1 and 100
  ),
  -- Ten million tokens of any kind is far past a 1M-token context and a 128k
  -- output; a larger number is a made-up one.
  constraint assist_usage_tokens_bounded check (
    input_tokens between 0 and 10000000
    and output_tokens between 0 and 10000000
    and cache_read_input_tokens between 0 and 10000000
    and cache_creation_input_tokens between 0 and 10000000
  ),
  -- Never negative (a negative row would subtract from the month), and at
  -- most $1,000 for one call — a full context and a full output on the most
  -- expensive model is about $17.
  constraint assist_usage_cost_bounded check (cost_micros between 0 and 1000000000)
);

create index assist_usage_user_created on public.assist_usage (user_id, created_at);

alter table public.assist_usage enable row level security;

create policy assist_usage_select on public.assist_usage
  for select using (user_id = auth.uid());

revoke all on public.assist_usage from anon, authenticated;
grant select on public.assist_usage to authenticated;

-- --------------------------------------------------------- assist_caps -----

create table public.assist_caps (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid()
                references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Whole dollars a calendar month; null means "no cap", chosen.
  cap_dollars integer,
  constraint assist_caps_user_unique unique (user_id),
  constraint assist_caps_dollars_range check (cap_dollars between 0 and 100000)
);

alter table public.assist_caps enable row level security;

create policy assist_caps_select on public.assist_caps
  for select using (user_id = auth.uid());

revoke all on public.assist_caps from anon, authenticated;
grant select on public.assist_caps to authenticated;

-- ------------------------------------------------- record_assist_usage -----

create function public.record_assist_usage(
  p_video           uuid,
  p_kind            text,
  p_outcome         text,
  p_requested_model text,
  p_model           text,
  p_price_assumed   boolean,
  p_input           integer,
  p_output          integer,
  p_cache_read      integer,
  p_cache_write     integer,
  p_cost_micros     bigint
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- The owner and the time are the database's, never the caller's (header).
  -- Everything else is held to the table's CHECKs and the tenant-bound
  -- foreign key, which is what refuses somebody else's video (23503).
  insert into public.assist_usage (
    user_id, created_at, video_id, kind, outcome, requested_model, model,
    price_assumed, input_tokens, output_tokens, cache_read_input_tokens,
    cache_creation_input_tokens, cost_micros
  ) values (
    v_uid, now(), p_video, p_kind, p_outcome, p_requested_model, p_model,
    coalesce(p_price_assumed, false), coalesce(p_input, 0), coalesce(p_output, 0),
    coalesce(p_cache_read, 0), coalesce(p_cache_write, 0), p_cost_micros
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.record_assist_usage(
  uuid, text, text, text, text, boolean, integer, integer, integer, integer, bigint
) from public, anon;
grant execute on function public.record_assist_usage(
  uuid, text, text, text, text, boolean, integer, integer, integer, integer, bigint
) to authenticated;

-- ------------------------------------------------------ set_assist_cap -----

create function public.set_assist_cap(p_dollars integer)
returns public.assist_caps
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.assist_caps;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_dollars is not null and (p_dollars < 0 or p_dollars > 100000) then
    raise exception 'assist_cap:out_of_range %', p_dollars using errcode = '22023';
  end if;

  insert into public.assist_caps (user_id, cap_dollars)
  values (v_uid, p_dollars)
  on conflict (user_id) do update
    set cap_dollars = excluded.cap_dollars,
        updated_at  = now();

  select * into v_row from public.assist_caps where user_id = v_uid;
  return v_row;
end;
$$;

revoke all on function public.set_assist_cap(integer) from public, anon;
grant execute on function public.set_assist_cap(integer) to authenticated;

-- ------------------------------------------------------- assist_budget -----
--
-- Everything the pre-call check and Settings need, in one round trip: the
-- spend and the number of calls in [p_from, p_to), how many of those were
-- priced by assumption, and the cap as stored (with whether there is a row at
-- all, which is what tells "never set" from "set to no cap").
--
-- security invoker: it reads through the caller's own RLS, so it can only ever
-- sum the caller's rows. Nothing here needs to see past them.

create function public.assist_budget(p_from timestamptz, p_to timestamptz)
returns table (
  spend_micros  bigint,
  calls         integer,
  assumed_calls integer,
  cap_set       boolean,
  cap_dollars   integer
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce((select sum(u.cost_micros) from public.assist_usage u
               where u.user_id = auth.uid()
                 and u.created_at >= p_from and u.created_at < p_to), 0)::bigint,
    (select count(*) from public.assist_usage u
      where u.user_id = auth.uid()
        and u.created_at >= p_from and u.created_at < p_to)::integer,
    (select count(*) from public.assist_usage u
      where u.user_id = auth.uid() and u.price_assumed
        and u.created_at >= p_from and u.created_at < p_to)::integer,
    exists (select 1 from public.assist_caps c where c.user_id = auth.uid()),
    (select c.cap_dollars from public.assist_caps c where c.user_id = auth.uid());
$$;

revoke all on function public.assist_budget(timestamptz, timestamptz) from public, anon;
grant execute on function public.assist_budget(timestamptz, timestamptz) to authenticated;
