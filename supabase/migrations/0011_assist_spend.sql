-- 0011 — what the brainstorm has cost, and the ceiling on it (M11).
--
-- Until now the assist had no spending ceiling (README, "Honest limits"; M8's
-- review, finding 1): every press of a pill with a key configured was a live
-- call, and nothing counted them. This adds the count and the ceiling.
--
-- ## Two tables
--
-- `assist_usage` — one row per real API call: who, when, the model that
-- actually served it (a server-side fallback can answer with a different model
-- than the one asked for), the four token counts the API reports, and the cost
-- in integer micro-dollars. A row is written *before* the call, as a
-- reservation at the call's worst case, and settled to the measured cost when
-- the response comes back (see "reserve, settle, close" below). The fixtures
-- record nothing and neither does a paste from claude.ai: neither costs this
-- account money.
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
-- server action that reserves and settles a call talks to the database with
-- the signed-in user's own session — exactly the credential the browser
-- holds. There is therefore no function the server can call that the browser
-- cannot, and a signed-in client can call these with numbers it made up. What
-- the design guarantees:
--
--   * the client holds no INSERT, UPDATE or DELETE on `assist_usage` (and no
--     TRUNCATE on anything); the functions stamp `user_id = auth.uid()` and
--     `created_at = now()`, so a row cannot be charged to somebody else or
--     backdated into last month;
--   * every number is checked non-negative and bounded, so no row carries a
--     negative cost that subtracts from the month;
--   * a *settled* row is never rewritten or removed. Only an open reservation
--     can be settled lower than its worst case, or removed — which is what a
--     reservation is for.
--
-- A client that settles its own open reservation at $0 has lowered its own
-- month; it could equally have raised or removed its cap in Settings. The cap
-- is the account holder's own ceiling, not a defence against them, and it
-- holds against everything the server itself does. Closing the gap fully
-- needs a secret the server holds and the browser does not (a service-role
-- key or a shared signing secret in the database), which this deployment
-- deliberately does not have. Recorded in docs/MILESTONES.md.
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
--
-- This file was revised by M11's adversarial review before it reached the
-- hosted database (which has 0001–0010): the first version recorded a call
-- only after it returned (`record_assist_usage`), which the review showed
-- could be passed by any number of calls started together.

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
  -- True while cost_micros is the call's worst case rather than its measured
  -- cost: a reservation still open, or a call that got no response back.
  estimated                   boolean not null default false,
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
  -- `pending` is a reservation: the call is in flight (or its server died),
  -- and cost_micros is its worst case until it is settled.
  constraint assist_usage_outcome_known check (
    outcome in ('pending', 'answered', 'failed', 'refused')
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

-- ------------------------------------------------ reserve, settle, close -----
--
-- The cap is **reserved**, not merely checked (M11's adversarial review,
-- findings 1 and 2). A check alone let every ask in flight read the same
-- pre-call spend: twenty-one asks replayed in parallel against a $1 cap at
-- $0.99 all went, and the month closed at $2.88. And a call that timed out on
-- this side wrote nothing at all, although the API may have billed it.
--
-- So a real call is three steps, each one function:
--
--   1. reserve_assist_spend() — before anything is sent. Under a per-user
--      transaction lock, it sums the window (settled calls at their measured
--      cost, open reservations at their worst case), refuses when that is at
--      or over the cap, and otherwise writes a `pending` row carrying the
--      call's worst-case cost. The next reservation, from any tab, any video,
--      any kind, waits for the lock and then sees this row. So however many
--      asks start together, at most one is let through past the line, and the
--      month can end over the cap by at most that one call's worst case.
--   2. settle_assist_spend() — when a response came back. The pending row
--      becomes the measured cost, tokens and served model.
--   3. close_assist_reservation() — when no response came back. When the
--      request may have been billed (our own timeout, a dropped connection),
--      the row stays at its worst case, marked `failed` and `estimated`; when
--      the API answered with an error status (which bills nothing), the row
--      is removed.
--
-- A row whose server died between 1 and 2 stays `pending` at its worst case
-- forever — the safe direction for a ceiling, and Settings says how many
-- calls are counted that way.

create function public.reserve_assist_spend(
  p_from                timestamptz,
  p_to                  timestamptz,
  p_video               uuid,
  p_kind                text,
  p_requested_model     text,
  p_estimate_micros     bigint,
  p_default_cap_dollars integer
) returns table (
  reservation     uuid,
  spend_micros    bigint,
  calls           integer,
  assumed_calls   integer,
  estimated_calls integer,
  cap_set         boolean,
  cap_dollars     integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_cap   integer;
  v_set   boolean;
  v_id    uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception 'assist_spend:bad_window' using errcode = '22023';
  end if;
  if p_default_cap_dollars is null or p_default_cap_dollars < 0 then
    raise exception 'assist_spend:bad_default' using errcode = '22023';
  end if;

  -- One reservation at a time per user. Released when this transaction
  -- commits, which is when the pending row below becomes visible to the next.
  perform pg_advisory_xact_lock(hashtextextended('assist_spend:' || v_uid::text, 0));

  -- Each statement below takes a fresh snapshot (plpgsql, volatile), so it
  -- sees every reservation committed while this one waited for the lock.
  select coalesce(sum(u.cost_micros), 0)::bigint,
         count(*)::integer,
         count(*) filter (where u.price_assumed)::integer,
         count(*) filter (where u.estimated)::integer
    into spend_micros, calls, assumed_calls, estimated_calls
    from public.assist_usage u
   where u.user_id = v_uid and u.created_at >= p_from and u.created_at < p_to;

  select true, c.cap_dollars into v_set, v_cap
    from public.assist_caps c where c.user_id = v_uid;
  cap_set := coalesce(v_set, false);
  cap_dollars := v_cap;
  if not cap_set then
    v_cap := p_default_cap_dollars;
  end if;

  if v_cap is not null and spend_micros >= v_cap::bigint * 1000000 then
    reservation := null;
    return next;
    return;
  end if;

  -- The owner and the time are the database's, never the caller's. The
  -- estimate is held to the table's CHECKs; another tenant's video is 23503.
  insert into public.assist_usage (
    user_id, created_at, video_id, kind, outcome, requested_model, model,
    estimated, cost_micros
  ) values (
    v_uid, now(), p_video, p_kind, 'pending', p_requested_model, p_requested_model,
    true, p_estimate_micros
  )
  returning id into v_id;

  reservation := v_id;
  return next;
end;
$$;

revoke all on function public.reserve_assist_spend(
  timestamptz, timestamptz, uuid, text, text, bigint, integer
) from public, anon;
grant execute on function public.reserve_assist_spend(
  timestamptz, timestamptz, uuid, text, text, bigint, integer
) to authenticated;

create function public.settle_assist_spend(
  p_id            uuid,
  p_outcome       text,
  p_model         text,
  p_price_assumed boolean,
  p_input         integer,
  p_output        integer,
  p_cache_read    integer,
  p_cache_write   integer,
  p_cost_micros   bigint
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('answered', 'failed', 'refused') then
    raise exception 'assist_spend:bad_outcome %', p_outcome using errcode = '22023';
  end if;

  -- Only the caller's own reservation, and only while it is still open: a
  -- settled row is never rewritten.
  update public.assist_usage
     set outcome = p_outcome,
         model = p_model,
         price_assumed = coalesce(p_price_assumed, false),
         input_tokens = coalesce(p_input, 0),
         output_tokens = coalesce(p_output, 0),
         cache_read_input_tokens = coalesce(p_cache_read, 0),
         cache_creation_input_tokens = coalesce(p_cache_write, 0),
         cost_micros = p_cost_micros,
         estimated = false
   where id = p_id and user_id = v_uid and outcome = 'pending';
  if not found then
    raise exception 'assist_spend:not_pending' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.settle_assist_spend(
  uuid, text, text, boolean, integer, integer, integer, integer, bigint
) from public, anon;
grant execute on function public.settle_assist_spend(
  uuid, text, text, boolean, integer, integer, integer, integer, bigint
) to authenticated;

create function public.close_assist_reservation(p_id uuid, p_may_have_billed boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  if coalesce(p_may_have_billed, true) then
    -- No usage came back, and the API may still have billed the call: keep
    -- the worst case, marked as a failure whose cost is an estimate.
    update public.assist_usage
       set outcome = 'failed'
     where id = p_id and user_id = v_uid and outcome = 'pending';
  else
    -- The API answered with an error status, which bills nothing.
    delete from public.assist_usage
     where id = p_id and user_id = v_uid and outcome = 'pending';
  end if;
  if not found then
    raise exception 'assist_spend:not_pending' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.close_assist_reservation(uuid, boolean) from public, anon;
grant execute on function public.close_assist_reservation(uuid, boolean) to authenticated;

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
-- Everything the page and Settings need, in one round trip: the spend and the
-- number of calls in [p_from, p_to) — open reservations and calls that got no
-- response counted at their worst case — how many were priced by assumption,
-- how many are such estimates, and the cap as stored (with whether there is a
-- row at all, which is what tells "never set" from "set to no cap"). The
-- check that holds the line is reserve_assist_spend(), which sums the same
-- way under its lock.
--
-- security invoker: it reads through the caller's own RLS, so it can only ever
-- sum the caller's rows. Nothing here needs to see past them.

create function public.assist_budget(p_from timestamptz, p_to timestamptz)
returns table (
  spend_micros  bigint,
  calls         integer,
  assumed_calls integer,
  estimated_calls integer,
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
    (select count(*) from public.assist_usage u
      where u.user_id = auth.uid() and u.estimated
        and u.created_at >= p_from and u.created_at < p_to)::integer,
    exists (select 1 from public.assist_caps c where c.user_id = auth.uid()),
    (select c.cap_dollars from public.assist_caps c where c.user_id = auth.uid());
$$;

revoke all on function public.assist_budget(timestamptz, timestamptz) from public, anon;
grant execute on function public.assist_budget(timestamptz, timestamptz) to authenticated;
