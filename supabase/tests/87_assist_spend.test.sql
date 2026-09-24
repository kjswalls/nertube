-- What the brainstorm has cost, and the cap on it (0011).
--
-- assist_usage is readable by its owner and never inserted, edited or deleted
-- directly. A call is reserved at its worst case by reserve_assist_spend()
-- (under a per-user lock, refused at the cap), then settled to its measured
-- cost by settle_assist_spend() or closed by close_assist_reservation(); the
-- functions stamp the owner and the time, and a settled row is never
-- rewritten. The cap is written only by set_assist_cap(). assist_budget() sums a window the
-- application computes in the user's zone; the last block walks one month
-- boundary in the farthest-east and farthest-west zones.

begin;

-- ------------------------------------------------------------- act as A ----
select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

-- 1. A client cannot write either table directly, in any of the three ways.
do $$
begin
  begin
    insert into public.assist_usage (user_id, kind, outcome, requested_model, model, cost_micros)
    values (fx.user_a(), 'titles', 'answered', 'claude-opus-5', 'claude-opus-5', 1);
    raise exception 'FAILED: a client inserted an assist_usage row directly';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.assist_caps (user_id, cap_dollars) values (fx.user_a(), 5);
    raise exception 'FAILED: a client inserted an assist_caps row directly';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 2. With nothing recorded and nothing set: zero spend, zero calls, no cap row.
do $$
declare b record;
begin
  select * into b from public.assist_budget('-infinity', 'infinity');
  if b.spend_micros <> 0 or b.calls <> 0 or b.assumed_calls <> 0 then
    raise exception 'FAILED: an empty account reports % micros over % calls', b.spend_micros, b.calls;
  end if;
  if b.cap_set or b.cap_dollars is not null then
    raise exception 'FAILED: a cap is reported (%/%) before one was set', b.cap_set, b.cap_dollars;
  end if;
end $$;

-- 3. A reservation is written before the call, as the caller, now, at the
--    worst case; settling it writes the measured numbers over it.
do $$
declare r record; v_id uuid; u public.assist_usage; n int;
begin
  select * into r from public.reserve_assist_spend(
    '-infinity', 'infinity', fx.video_a(), 'titles', 'claude-opus-5', 900000, 10);
  if r.reservation is null then raise exception 'FAILED: an empty month refused a reservation'; end if;
  if r.spend_micros <> 0 or r.calls <> 0 or r.cap_set then
    raise exception 'FAILED: the reservation reported % / % / % before itself', r.spend_micros, r.calls, r.cap_set;
  end if;
  v_id := r.reservation;
  select * into u from public.assist_usage where id = v_id;
  if u.user_id <> fx.user_a() or u.created_at <> now() then
    raise exception 'FAILED: the reservation belongs to % at %', u.user_id, u.created_at;
  end if;
  if u.outcome <> 'pending' or not u.estimated or u.cost_micros <> 900000 or u.model <> 'claude-opus-5' then
    raise exception 'FAILED: the reservation is % / % / % / %', u.outcome, u.estimated, u.cost_micros, u.model;
  end if;

  -- The advisory lock that serialises reservations is held by this transaction.
  select count(*) into n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted;
  if n < 1 then raise exception 'FAILED: reserve_assist_spend() took no advisory lock'; end if;

  perform public.settle_assist_spend(v_id, 'answered', 'claude-opus-4-8', false, 1200, 900, 300, 0, 28650);
  select * into u from public.assist_usage where id = v_id;
  if u.outcome <> 'answered' or u.estimated or u.model <> 'claude-opus-4-8' or u.requested_model <> 'claude-opus-5' then
    raise exception 'FAILED: settled as % / % / % / %', u.outcome, u.estimated, u.model, u.requested_model;
  end if;
  if u.cost_micros <> 28650 or u.cache_read_input_tokens <> 300 or u.input_tokens <> 1200 then
    raise exception 'FAILED: the measured numbers were not stored as sent';
  end if;

  -- A settled row is never rewritten: not settled again, not closed.
  begin
    perform public.settle_assist_spend(v_id, 'answered', 'm', false, 0, 0, 0, 0, 0);
    raise exception 'FAILED: a settled row was settled again';
  exception when sqlstate 'P0002' then null;
  end;
  begin
    perform public.close_assist_reservation(v_id, false);
    raise exception 'FAILED: a settled row was closed (removed)';
  exception when sqlstate 'P0002' then null;
  end;

  -- A call with no video, priced by assumption and refused mid-answer.
  select * into r from public.reserve_assist_spend(
    '-infinity', 'infinity', null, 'thumbnail_critique', 'claude-opus-5', 500000, 10);
  perform public.settle_assist_spend(r.reservation, 'refused', 'mystery-model', true, 10, 5, 0, 0, 1350);
end $$;

-- 4. The rows cannot be lowered, edited or removed by their owner directly.
do $$
begin
  begin
    update public.assist_usage set cost_micros = 0 where user_id = fx.user_a();
    raise exception 'FAILED: a client zeroed its own usage';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.assist_usage where user_id = fx.user_a();
    raise exception 'FAILED: a client deleted its own usage';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 5. What the functions refuse: another tenant's video, a negative or absurd
--    estimate, a kind that does not exist, an empty model, a window that is
--    not one, no default, and a settle to an outcome that is not final.
do $$
declare
  calls text[] := array[
    format($f$select * from public.reserve_assist_spend('-infinity', 'infinity', %L::uuid, 'titles', 'm', 1, 10)$f$, fx.video_b()),
    $f$select * from public.reserve_assist_spend('-infinity', 'infinity', null, 'titles', 'm', -5000, 10)$f$,
    $f$select * from public.reserve_assist_spend('-infinity', 'infinity', null, 'titles', 'm', 5000000000, 10)$f$,
    $f$select * from public.reserve_assist_spend('-infinity', 'infinity', null, 'essays', 'm', 1, 10)$f$,
    $f$select * from public.reserve_assist_spend('-infinity', 'infinity', null, 'titles', '', 1, 10)$f$,
    $f$select * from public.reserve_assist_spend('-infinity', 'infinity', null, 'titles', 'm', null, 10)$f$,
    $f$select * from public.reserve_assist_spend('infinity', '-infinity', null, 'titles', 'm', 1, 10)$f$,
    $f$select * from public.reserve_assist_spend('-infinity', 'infinity', null, 'titles', 'm', 1, null)$f$,
    $f$select public.settle_assist_spend(gen_random_uuid(), 'pending', 'm', false, 0, 0, 0, 0, 0)$f$,
    $f$select public.settle_assist_spend(gen_random_uuid(), 'answered', 'm', false, 0, 0, 0, 0, 0)$f$,
    $f$select public.close_assist_reservation(gen_random_uuid(), true)$f$
  ];
  expected text[] := array['23503', '23514', '23514', '23514', '23514', '23502',
                           '22023', '22023', '22023', 'P0002', 'P0002'];
  i int; ok boolean; st text; n int;
begin
  for i in 1 .. array_length(calls, 1) loop
    ok := false;
    begin
      execute calls[i];
    exception when others then
      get stacked diagnostics st = returned_sqlstate; ok := true;
    end;
    if not ok then raise exception 'FAILED: accepted %', calls[i]; end if;
    if st <> expected[i] then
      raise exception 'FAILED: % refused with %, expected %', calls[i], st, expected[i];
    end if;
  end loop;

  select count(*) into n from public.assist_usage;
  if n <> 2 then raise exception 'FAILED: A should have exactly 2 usage rows, has %', n; end if;
end $$;

-- 6. The budget sums them, and counts the one priced by assumption.
do $$
declare b record;
begin
  select * into b from public.assist_budget(now() - interval '1 minute', now() + interval '1 minute');
  if b.spend_micros <> 30000 or b.calls <> 2 or b.assumed_calls <> 1 or b.estimated_calls <> 0 then
    raise exception 'FAILED: budget is % micros / % calls / % assumed / % estimated, expected 30000 / 2 / 1 / 0',
      b.spend_micros, b.calls, b.assumed_calls, b.estimated_calls;
  end if;
  -- The window is half-open: a window ending at now() excludes a row stamped now().
  select * into b from public.assist_budget(now() - interval '1 day', now());
  if b.calls <> 0 then raise exception 'FAILED: [from, to) included a row stamped at to'; end if;
end $$;

-- 6b. A call that got no response: kept at its worst case when it may have
--     been billed, removed when the API answered with an error status.
do $$
declare r record; u public.assist_usage; b record; n int;
begin
  select * into r from public.reserve_assist_spend('-infinity', 'infinity', null, 'hooks', 'claude-opus-5', 400000, 10);
  perform public.close_assist_reservation(r.reservation, true);
  select * into u from public.assist_usage where id = r.reservation;
  if u.outcome <> 'failed' or not u.estimated or u.cost_micros <> 400000 then
    raise exception 'FAILED: a timed-out call was kept as % / % / %', u.outcome, u.estimated, u.cost_micros;
  end if;

  select * into r from public.reserve_assist_spend('-infinity', 'infinity', null, 'hooks', 'claude-opus-5', 400000, 10);
  -- While it is open, the reservation counts at its worst case.
  select * into b from public.assist_budget('-infinity', 'infinity');
  if b.spend_micros <> 830000 or b.estimated_calls <> 2 then
    raise exception 'FAILED: an open reservation is not counted (% micros, % estimated)', b.spend_micros, b.estimated_calls;
  end if;
  perform public.close_assist_reservation(r.reservation, false);
  select count(*) into n from public.assist_usage where id = r.reservation;
  if n <> 0 then raise exception 'FAILED: a call the API refused with a status was kept'; end if;

  select * into b from public.assist_budget('-infinity', 'infinity');
  if b.spend_micros <> 430000 or b.calls <> 3 or b.estimated_calls <> 1 then
    raise exception 'FAILED: after closing, the budget is % / % / %', b.spend_micros, b.calls, b.estimated_calls;
  end if;
end $$;

-- 6c. The line: at or over the cap nothing is reserved; under it one call is
--     let through, and its worst case is then counted against the next.
do $$
declare r record; n int;
begin
  -- $0.43 so far. A $1 default: the first reservation (worst case $0.60)
  -- goes, and takes the month to $1.03; the second is refused, and reports
  -- the month as it stands.
  select * into r from public.reserve_assist_spend('-infinity', 'infinity', null, 'titles', 'claude-opus-5', 600000, 1);
  if r.reservation is null then raise exception 'FAILED: $0.43 of $1 refused a call'; end if;
  select * into r from public.reserve_assist_spend('-infinity', 'infinity', null, 'titles', 'claude-opus-5', 600000, 1);
  if r.reservation is not null then raise exception 'FAILED: a second call passed a reached cap'; end if;
  if r.spend_micros <> 1030000 or r.calls <> 4 or r.cap_set or r.cap_dollars is not null then
    raise exception 'FAILED: the refusal reported % / % / % / %', r.spend_micros, r.calls, r.cap_set, r.cap_dollars;
  end if;
  select count(*) into n from public.assist_usage where outcome = 'pending';
  if n <> 1 then raise exception 'FAILED: % open reservations, expected 1', n; end if;

  -- A chosen cap outranks the default; "no cap" refuses nothing; $0 refuses all.
  perform public.set_assist_cap(null);
  select * into r from public.reserve_assist_spend('-infinity', 'infinity', null, 'titles', 'claude-opus-5', 600000, 1);
  if r.reservation is null or not r.cap_set then raise exception 'FAILED: no cap refused a call'; end if;
  perform public.set_assist_cap(0);
  select * into r from public.reserve_assist_spend('-infinity', 'infinity', null, 'titles', 'claude-opus-5', 1, 1000);
  if r.reservation is not null or r.cap_dollars <> 0 then raise exception 'FAILED: a $0 cap let a call through'; end if;

  -- Tidy the open reservations away for the blocks below (as the API refusing them would).
  for r in select id from public.assist_usage where outcome = 'pending' loop
    perform public.close_assist_reservation(r.id, false);
  end loop;
  select count(*) into n from public.assist_usage;
  if n <> 3 then raise exception 'FAILED: A should have 3 usage rows, has %', n; end if;
end $$;

-- 7. The cap: set, changed to "no cap", refused out of range.
do $$
declare r public.assist_caps; b record; st text; ok boolean;
begin
  r := public.set_assist_cap(25);
  if r.cap_dollars <> 25 or r.user_id <> fx.user_a() then raise exception 'FAILED: cap stored as %', r.cap_dollars; end if;
  select * into b from public.assist_budget('-infinity', 'infinity');
  if not b.cap_set or b.cap_dollars <> 25 then raise exception 'FAILED: budget reports cap %/%', b.cap_set, b.cap_dollars; end if;

  r := public.set_assist_cap(null);
  select * into b from public.assist_budget('-infinity', 'infinity');
  if not b.cap_set or b.cap_dollars is not null then
    raise exception 'FAILED: "no cap" did not read back as a set row with no amount (%/%)', b.cap_set, b.cap_dollars;
  end if;

  r := public.set_assist_cap(0);
  if r.cap_dollars <> 0 then raise exception 'FAILED: a $0 cap was not stored'; end if;

  foreach st in array array['-1', '100001'] loop
    ok := false;
    begin
      perform public.set_assist_cap(st::integer);
    exception when sqlstate '22023' then ok := true;
    end;
    if not ok then raise exception 'FAILED: a cap of % was accepted', st; end if;
  end loop;

  begin
    update public.assist_caps set cap_dollars = 99999 where user_id = fx.user_a();
    raise exception 'FAILED: a client updated its cap directly';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.assist_caps where user_id = fx.user_a();
    raise exception 'FAILED: a client deleted its cap directly';
  exception when insufficient_privilege then null;
  end;

  r := public.set_assist_cap(25);
end $$;

-- ------------------------------------------------------------- act as B ----
reset role;
select set_config('request.jwt.claims', json_build_object('sub', fx.user_b())::text, true);
set local role authenticated;

-- 8. B sees none of A's rows, none of A's cap, and a budget of nothing.
do $$
declare n int; b record;
begin
  select count(*) into n from public.assist_usage;
  if n <> 0 then raise exception 'FAILED: B can read % of A''s usage rows', n; end if;
  select count(*) into n from public.assist_caps;
  if n <> 0 then raise exception 'FAILED: B can read A''s cap'; end if;
  select * into b from public.assist_budget('-infinity', 'infinity');
  if b.spend_micros <> 0 or b.calls <> 0 or b.cap_set then
    raise exception 'FAILED: B''s budget includes A''s (% micros, % calls, cap %)', b.spend_micros, b.calls, b.cap_set;
  end if;

  -- And B's own write is B's alone.
  perform public.settle_assist_spend(
    (select reservation from public.reserve_assist_spend('-infinity', 'infinity', fx.video_b(), 'hooks', 'claude-opus-5', 100, 10)),
    'answered', 'claude-opus-5', false, 1, 1, 0, 0, 30);

  -- B cannot settle or close A's rows, even knowing nothing but that they exist.
  begin
    perform public.close_assist_reservation(gen_random_uuid(), false);
    raise exception 'FAILED: closed a reservation that is not B''s';
  exception when sqlstate 'P0002' then null;
  end;
  perform public.set_assist_cap(3);
end $$;

-- ------------------------------------------------------------- anonymous ---
reset role;
set local request.jwt.claims = '';
set local role anon;

-- 9. Signed out, nothing: no rows, and none of the functions.
do $$
declare
  calls text[] := array[
    $f$select * from public.reserve_assist_spend('-infinity', 'infinity', null, 'titles', 'm', 1, 10)$f$,
    $f$select public.settle_assist_spend(gen_random_uuid(), 'answered', 'm', false, 0, 0, 0, 0, 0)$f$,
    $f$select public.close_assist_reservation(gen_random_uuid(), true)$f$,
    $f$select public.set_assist_cap(5)$f$,
    $f$select * from public.assist_budget('-infinity', 'infinity')$f$,
    $f$select count(*) from public.assist_usage$f$
  ];
  i int; ok boolean; st text;
begin
  for i in 1 .. array_length(calls, 1) loop
    ok := false;
    begin
      execute calls[i];
    exception when others then
      get stacked diagnostics st = returned_sqlstate; ok := true;
    end;
    if not ok then raise exception 'FAILED: anon ran %', calls[i]; end if;
    if st <> '42501' then raise exception 'FAILED: % gave %, expected 42501', calls[i], st; end if;
  end loop;
end $$;

-- ------------------------------------------------------ as the owner -------
reset role;

-- 10. A's cap and usage are untouched by B.
do $$
declare n int;
begin
  select count(*) into n from public.assist_usage where user_id = fx.user_a();
  if n <> 3 then raise exception 'FAILED: A has % usage rows after B wrote', n; end if;
  select cap_dollars into n from public.assist_caps where user_id = fx.user_a();
  if n <> 25 then raise exception 'FAILED: A''s cap is % after B set one', n; end if;
end $$;

-- 11. A deleted video keeps its spend: the reference is cleared, the row stays.
do $$
declare n int; c bigint;
begin
  delete from public.videos where id = fx.video_a();
  select count(*), sum(cost_micros) into n, c from public.assist_usage where user_id = fx.user_a();
  if n <> 3 or c <> 430000 then raise exception 'FAILED: deleting a video removed spend (% rows, % micros)', n, c; end if;
  select count(*) into n from public.assist_usage where user_id = fx.user_a() and video_id is not null;
  if n <> 0 then raise exception 'FAILED: the deleted video is still referenced'; end if;
end $$;

-- 12. The month boundary, at both ends of the clock.
--
-- The application asks for [first instant of the month, first instant of the
-- next month) in the user's zone (lib/calendar-dates.ts `monthInstants`, whose
-- unit test pins the same six instants). Four calls straddle the turn of
-- September into October 2026:
--
--   t1 2026-09-30 09:59Z   Kiritimati (UTC+14): 30 Sep 23:59   Pago Pago (UTC-11): 29 Sep 22:59
--   t2 2026-09-30 10:00Z   Kiritimati:          1 Oct 00:00    Pago Pago:          29 Sep 23:00
--   t3 2026-10-01 10:59Z   Kiritimati:          2 Oct 00:59    Pago Pago:          30 Sep 23:59
--   t4 2026-10-01 11:00Z   Kiritimati:          2 Oct 01:00    Pago Pago:           1 Oct 00:00
delete from public.assist_usage where user_id = fx.user_a();
insert into public.assist_usage (user_id, created_at, kind, outcome, requested_model, model, cost_micros) values
  (fx.user_a(), '2026-09-30 09:59:00+00', 'titles', 'answered', 'm', 'm', 1),
  (fx.user_a(), '2026-09-30 10:00:00+00', 'titles', 'answered', 'm', 'm', 10),
  (fx.user_a(), '2026-10-01 10:59:00+00', 'titles', 'answered', 'm', 'm', 100),
  (fx.user_a(), '2026-10-01 11:00:00+00', 'titles', 'answered', 'm', 'm', 1000);

select set_config('request.jwt.claims', json_build_object('sub', fx.user_a())::text, true);
set local role authenticated;

do $$
declare
  zones text[] := array['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC'];
  -- The first instant of September, October and November in each zone.
  sep timestamptz[] := array['2026-08-31 10:00+00', '2026-09-01 11:00+00', '2026-09-01 00:00+00']::timestamptz[];
  oct timestamptz[] := array['2026-09-30 10:00+00', '2026-10-01 11:00+00', '2026-10-01 00:00+00']::timestamptz[];
  nov timestamptz[] := array['2026-10-31 10:00+00', '2026-11-01 11:00+00', '2026-11-01 00:00+00']::timestamptz[];
  want_sep bigint[] := array[1, 111, 11];
  want_oct bigint[] := array[1110, 1000, 1100];
  i int; b record;
begin
  for i in 1 .. array_length(zones, 1) loop
    -- The bounds are what the zone says they are (the helper's arithmetic, cross-checked).
    if ('2026-09-01'::timestamp at time zone zones[i]) <> sep[i]
       or ('2026-10-01'::timestamp at time zone zones[i]) <> oct[i]
       or ('2026-11-01'::timestamp at time zone zones[i]) <> nov[i] then
      raise exception 'FAILED: the month bounds in % are not the ones pinned here', zones[i];
    end if;

    select * into b from public.assist_budget(sep[i], oct[i]);
    if b.spend_micros <> want_sep[i] then
      raise exception 'FAILED: September in % sums to %, expected %', zones[i], b.spend_micros, want_sep[i];
    end if;
    select * into b from public.assist_budget(oct[i], nov[i]);
    if b.spend_micros <> want_oct[i] then
      raise exception 'FAILED: October in % sums to %, expected %', zones[i], b.spend_micros, want_oct[i];
    end if;
  end loop;
end $$;

reset role;
rollback;
