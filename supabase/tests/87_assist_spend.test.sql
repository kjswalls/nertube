-- What the brainstorm has cost, and the cap on it (0011).
--
-- assist_usage is append-only from the client's side: readable by its owner,
-- never inserted, edited or deleted directly, written only by
-- record_assist_usage(), which stamps the owner and the time itself. The cap
-- is written only by set_assist_cap(). assist_budget() sums a window the
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

-- 3. The function records a call, as the caller, now — whatever it is told.
do $$
declare v_id uuid; r public.assist_usage;
begin
  v_id := public.record_assist_usage(
    fx.video_a(), 'titles', 'answered', 'claude-opus-5', 'claude-opus-4-8', false,
    1200, 900, 300, 0, 28650);
  select * into r from public.assist_usage where id = v_id;
  if r.user_id <> fx.user_a() then raise exception 'FAILED: the row belongs to %', r.user_id; end if;
  if r.created_at <> now() then raise exception 'FAILED: the row is stamped %, not now()', r.created_at; end if;
  if r.model <> 'claude-opus-4-8' or r.requested_model <> 'claude-opus-5' then
    raise exception 'FAILED: the served model was not kept apart from the requested one';
  end if;
  if r.cost_micros <> 28650 or r.cache_read_input_tokens <> 300 then
    raise exception 'FAILED: the numbers were not stored as sent';
  end if;

  -- A call with no video (none today, but the column allows it).
  perform public.record_assist_usage(
    null, 'thumbnail_critique', 'refused', 'claude-opus-5', 'mystery-model', true,
    10, 5, 0, 0, 1350);
end $$;

-- 4. The row cannot then be lowered, edited or removed by its owner.
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

-- 5. What the function refuses: another tenant's video, a negative or absurd
--    number, a kind or outcome that does not exist.
do $$
declare
  calls text[] := array[
    format($f$select public.record_assist_usage(%L::uuid, 'titles', 'answered', 'm', 'm', false, 1, 1, 0, 0, 1)$f$, fx.video_b()),
    $f$select public.record_assist_usage(null, 'titles', 'answered', 'm', 'm', false, 1, 1, 0, 0, -5000)$f$,
    $f$select public.record_assist_usage(null, 'titles', 'answered', 'm', 'm', false, -1, 1, 0, 0, 1)$f$,
    $f$select public.record_assist_usage(null, 'titles', 'answered', 'm', 'm', false, 1, 1, -300, 0, 1)$f$,
    $f$select public.record_assist_usage(null, 'titles', 'answered', 'm', 'm', false, 99999999, 1, 0, 0, 1)$f$,
    $f$select public.record_assist_usage(null, 'titles', 'answered', 'm', 'm', false, 1, 1, 0, 0, 5000000000)$f$,
    $f$select public.record_assist_usage(null, 'essays', 'answered', 'm', 'm', false, 1, 1, 0, 0, 1)$f$,
    $f$select public.record_assist_usage(null, 'titles', 'maybe', 'm', 'm', false, 1, 1, 0, 0, 1)$f$,
    $f$select public.record_assist_usage(null, 'titles', 'answered', '', 'm', false, 1, 1, 0, 0, 1)$f$,
    $f$select public.record_assist_usage(null, 'titles', 'answered', 'm', 'm', false, 1, 1, 0, 0, null)$f$
  ];
  expected text[] := array['23503', '23514', '23514', '23514', '23514', '23514',
                           '23514', '23514', '23514', '23502'];
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
  if b.spend_micros <> 30000 or b.calls <> 2 or b.assumed_calls <> 1 then
    raise exception 'FAILED: budget is % micros / % calls / % assumed, expected 30000 / 2 / 1',
      b.spend_micros, b.calls, b.assumed_calls;
  end if;
  -- The window is half-open: a window ending at now() excludes a row stamped now().
  select * into b from public.assist_budget(now() - interval '1 day', now());
  if b.calls <> 0 then raise exception 'FAILED: [from, to) included a row stamped at to'; end if;
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
  perform public.record_assist_usage(fx.video_b(), 'hooks', 'answered', 'claude-opus-5', 'claude-opus-5', false, 1, 1, 0, 0, 30);
  perform public.set_assist_cap(3);
end $$;

-- ------------------------------------------------------------- anonymous ---
reset role;
set local request.jwt.claims = '';
set local role anon;

-- 9. Signed out, nothing: no rows, and none of the three functions.
do $$
declare
  calls text[] := array[
    $f$select public.record_assist_usage(null, 'titles', 'answered', 'm', 'm', false, 1, 1, 0, 0, 1)$f$,
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
  if n <> 2 then raise exception 'FAILED: A has % usage rows after B wrote', n; end if;
  select cap_dollars into n from public.assist_caps where user_id = fx.user_a();
  if n <> 25 then raise exception 'FAILED: A''s cap is % after B set one', n; end if;
end $$;

-- 11. A deleted video keeps its spend: the reference is cleared, the row stays.
do $$
declare n int; c bigint;
begin
  delete from public.videos where id = fx.video_a();
  select count(*), sum(cost_micros) into n, c from public.assist_usage where user_id = fx.user_a();
  if n <> 2 or c <> 30000 then raise exception 'FAILED: deleting a video removed spend (% rows, % micros)', n, c; end if;
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
