-- =====================================================================================================================================
-- 20261022000000  OFFER DISPATCH  (additive; safe to re-run; default behaviour is UNCHANGED until dispatch_mode = 'OFFER')
--
--   dispatch_mode = 'AUTO'  (default)  today's forced instant nearest-rider assignment. Nothing new happens.
--   dispatch_mode = 'OFFER'            a delivery is OFFERED to a small group of nearby riders for a short window; the first rider to accept
--                                      wins (decided by a row lock on the delivery, backed by the existing unique indexes). Unaccepted offers
--                                      expire, the next round widens the radius, and a delivery nobody takes is flagged for the operator.
--
--   Instant switch back (no schema change):   update public.delivery_config set value = 'AUTO' where key = 'dispatch_mode';
--   Full removal: supabase/rollback/20261022000000_offer_dispatch_down.sql
-- =====================================================================================================================================

-- ---- pre-flight: fail loudly if the base schema is not what we expect -------------------------------------------------------------
do $$
begin
  if to_regclass('public.deliveries') is null or to_regclass('public.riders') is null or to_regclass('public.delivery_config') is null then
    raise exception 'offer dispatch needs the rider/delivery migrations (20261011*) applied first';
  end if;
  if to_regprocedure('public._assign_nearest_rider(uuid)') is null or to_regprocedure('public._try_assign_queued_delivery(uuid)') is null then
    raise exception 'offer dispatch expects public._assign_nearest_rider(uuid) and public._try_assign_queued_delivery(uuid) to exist';
  end if;
end $$;

-- ---- configuration (never overwrites a value you already changed) -------------------------------------------------------------------
insert into public.delivery_config (key, value, description) values
  ('dispatch_mode',          'AUTO',        'AUTO = forced nearest-rider assignment (legacy). OFFER = broadcast offers to a small group, first accept wins'),
  ('offer_window_seconds',   '15',          'OFFER mode: how long a round of offers stays open'),
  ('offer_group_size',       '4',           'OFFER mode: riders offered per round (3-5 recommended)'),
  ('offer_radius_steps_km',  '3,6,12,30',   'OFFER mode: search radius per round, widening. Number of rounds = number of values. Capped by max_assign_radius_km'),
  ('offer_retry_seconds',    '30',          'OFFER mode: after every round failed, wait this long before starting a fresh cycle (the order stays flagged for the operator)'),
  ('order_cancelled_statuses','CANCELLED',  'Comma list of orders.status values that mean the customer/system cancelled: such an order is never offered')
on conflict (key) do nothing;

-- ---- columns on deliveries (nullable / defaulted: existing rows and existing code are unaffected) ------------------------------------
alter table public.deliveries
  add column if not exists dispatch_round        int not null default 0,   -- 0 = not started; 1..N = current round; N+1 = every round failed
  add column if not exists dispatch_cycles       int not null default 0,   -- bumped each time the delivery (re)enters the queue or a fresh cycle starts
  add column if not exists offer_deadline        timestamptz,              -- when the current round closes (or when the last cycle failed)
  add column if not exists dispatch_exhausted_at timestamptz;              -- set the first time every round failed; the operator's "needs a human" flag

-- ---- offers -------------------------------------------------------------------------------------------------------------------------
create table if not exists public.delivery_offers (
  id           uuid primary key default gen_random_uuid(),
  delivery_id  uuid not null references public.deliveries(id),
  rider_id     uuid not null references public.riders(id) on delete cascade,
  cycle_no     int  not null default 0,
  round_no     int  not null,
  status       text not null default 'OFFERED' check (status in ('OFFERED','ACCEPTED','DECLINED','EXPIRED','WITHDRAWN')),
  radius_km    numeric(6,2),
  distance_km  numeric(6,2),                                  -- rider -> pharmacy, at the time of the offer
  offered_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  responded_at timestamptz,
  unique (delivery_id, rider_id, cycle_no)                    -- one offer per rider per cycle: no duplicate notifications
);
-- A rider holds at most ONE live offer at a time (database-enforced, so two concurrent rounds can never double-offer a rider).
create unique index if not exists delivery_offers_one_live_per_rider on public.delivery_offers (rider_id) where status = 'OFFERED';
create index if not exists delivery_offers_delivery_idx on public.delivery_offers (delivery_id, status);
create index if not exists delivery_offers_due_idx      on public.delivery_offers (expires_at) where status = 'OFFERED';

-- ---- dispatch audit trail (offers, accepts, declines, expiries, assignment, rider cancellation, exhaustion) ---------------------------
create table if not exists public.delivery_events (
  id          bigserial primary key,
  delivery_id uuid not null,
  rider_id    uuid,
  event       text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists delivery_events_delivery_idx on public.delivery_events (delivery_id, created_at);

alter table public.delivery_offers enable row level security;
alter table public.delivery_events enable row level security;   -- deliberately no policy: written/read by the SECURITY DEFINER functions and the service key
drop policy if exists offers_read_rider on public.delivery_offers;
create policy offers_read_rider on public.delivery_offers for select to authenticated using (rider_id = (select auth.uid()));   -- lets Realtime wake the rider's app
revoke all on public.delivery_offers, public.delivery_events from public, anon, authenticated;
grant select on public.delivery_offers to authenticated;
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.delivery_offers; exception when duplicate_object then null; end;
  end if;
end $$;

-- ---- triggers: keep offers consistent with the delivery, whoever changes it ---------------------------------------------------------
-- 1) Re-entering the queue (rider cancel, pharmacy reassign, ...) starts a fresh dispatch cycle.
create or replace function public._deliveries_requeue_reset() returns trigger language plpgsql as $$
begin
  new.dispatch_round := 0; new.dispatch_cycles := old.dispatch_cycles + 1; new.offer_deadline := null; new.dispatch_exhausted_at := null;
  return new;
end $$;
drop trigger if exists deliveries_requeue_reset on public.deliveries;
create trigger deliveries_requeue_reset before update on public.deliveries for each row
  when (new.status = 'DISPATCHED' and old.status is distinct from 'DISPATCHED') execute function public._deliveries_requeue_reset();

-- 2) The moment a delivery is assigned, cancelled or otherwise leaves the queue, every still-open offer on it is withdrawn.
create or replace function public._deliveries_withdraw_offers() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.delivery_offers set status = 'WITHDRAWN', responded_at = now() where delivery_id = new.id and status = 'OFFERED';
  return null;
end $$;
drop trigger if exists deliveries_withdraw_offers on public.deliveries;
create trigger deliveries_withdraw_offers after update of status, rider_id on public.deliveries for each row
  when (new.status <> 'DISPATCHED' or new.rider_id is not null) execute function public._deliveries_withdraw_offers();

-- ---- helpers ----------------------------------------------------------------------------------------------------------------------------
create or replace function public._offer_log(p_delivery uuid, p_rider uuid, p_event text, p_detail jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.delivery_events (delivery_id, rider_id, event, detail) values (p_delivery, p_rider, p_event, coalesce(p_detail, '{}'::jsonb))
$$;

-- Marks every overdue offer expired (optionally only one delivery's). Cheap, idempotent, safe to call from anywhere.
create or replace function public._offer_expire_due(p_delivery uuid default null) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  with x as (
    update public.delivery_offers set status = 'EXPIRED', responded_at = now()
     where status = 'OFFERED' and expires_at <= now() and (p_delivery is null or delivery_id = p_delivery)
    returning delivery_id, rider_id, round_no)
  insert into public.delivery_events (delivery_id, rider_id, event, detail)
  select delivery_id, rider_id, 'OFFER_EXPIRED', jsonb_build_object('round', round_no) from x;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---- THE ROUND ENGINE ---------------------------------------------------------------------------------------------------------------
-- Idempotent: call it as often as you like (tick, lazy paths, duplicate jobs). Under the delivery's row lock it
--   * does nothing if the delivery is assigned / cancelled / being handled by another transaction,
--   * does nothing while the current round is still open,
--   * otherwise opens the next round (skipping empty radii), or flags the delivery when every round has failed.
create or replace function public._offer_round(p_delivery_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  d public.deliveries; v_ostatus text; v_geog geography;
  v_steps text[] := string_to_array(public.cfg('offer_radius_steps_km', '3,6,12,30'), ',');
  v_n int; v_win int := greatest(3, public.cfg('offer_window_seconds', '15')::int);
  v_grp int := greatest(1, public.cfg('offer_group_size', '4')::int);
  v_retry int := greatest(0, public.cfg('offer_retry_seconds', '30')::int);
  v_fresh int := public.cfg('rider_fresh_seconds', '90')::int;
  v_maxkm numeric := public.cfg('max_assign_radius_km', '30')::numeric;
  v_cash numeric := public.cfg('max_floating_cash', '2000')::numeric;
  v_round int; v_rad numeric; v_cnt int;
begin
  v_n := coalesce(array_length(v_steps, 1), 0);
  select * into d from public.deliveries where id = p_delivery_id for update skip locked;   -- skip locked: never wait (no deadlocks with accept/status changes)
  if not found then return jsonb_build_object('ok', true, 'skipped', 'busy_or_missing'); end if;
  if d.status <> 'DISPATCHED' or d.rider_id is not null then return jsonb_build_object('ok', true, 'skipped', 'not_dispatchable'); end if;

  -- a customer-cancelled order is never offered
  select o.status into v_ostatus from public.orders o where o.id = d.order_id;
  if v_ostatus is not null and v_ostatus = any (string_to_array(public.cfg('order_cancelled_statuses', 'CANCELLED'), ',')) then
    update public.deliveries set status = 'CANCELLED', cancelled_at = now(), cancel_reason = 'ORDER_CANCELLED' where id = d.id;
    update public.delivery_secrets set otp = null, pickup_token = null, return_token = null where delivery_id = d.id;
    perform public._offer_log(d.id, null, 'ORDER_CANCELLED_NOT_DISPATCHED', jsonb_build_object('orderStatus', v_ostatus));
    return jsonb_build_object('ok', true, 'skipped', 'order_cancelled');
  end if;

  perform public._offer_expire_due(null);                      -- frees riders whose offers lapsed (also on other deliveries)
  if exists (select 1 from public.delivery_offers where delivery_id = d.id and status = 'OFFERED') then
    return jsonb_build_object('ok', true, 'waiting', true);   -- the current round is still open
  end if;
  if v_n = 0 then return public._err('no_radius_configured'); end if;

  if d.dispatch_round > v_n then                               -- every round failed earlier: wait, then start a fresh cycle
    if now() < d.offer_deadline + make_interval(secs => v_retry) then return jsonb_build_object('ok', true, 'waiting', true, 'exhausted', true); end if;
    update public.deliveries set dispatch_round = 0, dispatch_cycles = dispatch_cycles + 1 where id = d.id returning * into d;
  end if;

  select p.geog into v_geog from public.pharmacy_directory p where p.id = d.pharmacy_id;
  if v_geog is null then return public._err('pharmacy_not_found'); end if;

  v_round := d.dispatch_round;
  loop
    v_round := v_round + 1;
    exit when v_round > v_n;
    v_rad := least(btrim(v_steps[v_round])::numeric, v_maxkm);
    with picked as (
      select r.id, st_distance(r.geog, v_geog) / 1000.0 as km
        from public.riders r
       where r.status = 'ONLINE' and r.verification_status = 'VERIFIED'
         and r.geog is not null and r.last_seen_at > now() - make_interval(secs => v_fresh)
         and st_dwithin(r.geog, v_geog, v_rad * 1000)
         and (d.payment_mode <> 'CASH' or r.cash_in_hand < v_cash)
         and not (r.id = any (d.excluded_rider_ids))
         and not exists (select 1 from public.deliveries x where x.rider_id = r.id
                          and x.status in ('ACCEPTED','ARRIVED_AT_PHARMACY','PICKED_UP','RETURNING_TO_PHARMACY'))
         and not exists (select 1 from public.delivery_offers x where x.rider_id = r.id and x.status = 'OFFERED')               -- already holding a live offer
         and not exists (select 1 from public.delivery_offers x where x.delivery_id = d.id and x.rider_id = r.id
                          and (x.cycle_no = d.dispatch_cycles or x.status = 'DECLINED'))                                       -- asked already this cycle / said no
       order by km asc
       limit v_grp
         for update of r skip locked),
    ins as (
      insert into public.delivery_offers (delivery_id, rider_id, cycle_no, round_no, radius_km, distance_km, expires_at)
      select d.id, p.id, d.dispatch_cycles, v_round, v_rad, round(p.km::numeric, 2), now() + make_interval(secs => v_win) from picked p
      on conflict do nothing returning 1)
    select count(*) into v_cnt from ins;
    if v_cnt > 0 then
      update public.deliveries set dispatch_round = v_round, offer_deadline = now() + make_interval(secs => v_win) where id = d.id;
      perform public._offer_log(d.id, null, 'ROUND_STARTED', jsonb_build_object('round', v_round, 'radiusKm', v_rad, 'offered', v_cnt, 'cycle', d.dispatch_cycles));
      return jsonb_build_object('ok', true, 'offered', v_cnt, 'round', v_round, 'radiusKm', v_rad);
    end if;
  end loop;

  -- nobody eligible at any radius: flag it for the operator and keep the order queued (never dropped, never marked delivered)
  update public.deliveries set dispatch_round = v_n + 1, offer_deadline = now(), dispatch_exhausted_at = coalesce(dispatch_exhausted_at, now()) where id = d.id;
  if d.dispatch_exhausted_at is null then perform public._offer_log(d.id, null, 'DISPATCH_EXHAUSTED', jsonb_build_object('rounds', v_n, 'cycle', d.dispatch_cycles)); end if;
  return jsonb_build_object('ok', true, 'exhausted', true);
end $$;

-- ---- hook the existing entry points (original bodies preserved verbatim below the mode switch) -----------------------------------------
create or replace function public._assign_nearest_rider(p_delivery_id uuid) returns uuid
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  d public.deliveries; v_geog geography; v_rider uuid;
  v_fresh int := public.cfg('rider_fresh_seconds', '90')::int;
  v_km numeric := public.cfg('max_assign_radius_km', '30')::numeric;
  v_cash numeric := public.cfg('max_floating_cash', '2000')::numeric;
begin
  if public.cfg('dispatch_mode', 'AUTO') = 'OFFER' then      -- offer mode: open a round; the rider is assigned only when someone ACCEPTS
    perform public._offer_round(p_delivery_id);
    return null;
  end if;

  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found or d.status <> 'DISPATCHED' or d.rider_id is not null then return null; end if;
  select p.geog into v_geog from public.pharmacy_directory p where p.id = d.pharmacy_id;
  if v_geog is null then return null; end if;

  select r.id into v_rider
    from public.riders r
   where r.status = 'ONLINE' and r.verification_status = 'VERIFIED'
     and r.geog is not null and r.last_seen_at > now() - make_interval(secs => v_fresh)
     and st_dwithin(r.geog, v_geog, v_km * 1000)
     and (d.payment_mode <> 'CASH' or r.cash_in_hand < v_cash)           -- over the floating-cash limit: no new COD jobs (prepaid still flow)
     and not (r.id = any (d.excluded_rider_ids))
     and not exists (select 1 from public.deliveries x where x.rider_id = r.id
                      and x.status in ('ACCEPTED','ARRIVED_AT_PHARMACY','PICKED_UP','RETURNING_TO_PHARMACY'))
   order by st_distance(r.geog, v_geog) asc
   limit 1
     for update of r skip locked;
  if v_rider is null then return null; end if;

  update public.deliveries set rider_id = v_rider, status = 'ACCEPTED', accepted_at = now() where id = d.id;
  update public.riders set status = 'ON_DELIVERY' where id = v_rider;
  return v_rider;
end $$;

create or replace function public._try_assign_queued_delivery(p_rider_id uuid) returns uuid
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  r public.riders; v_id uuid;
  v_fresh int := public.cfg('rider_fresh_seconds', '90')::int;
  v_km numeric := public.cfg('max_assign_radius_km', '30')::numeric;
  v_cash numeric := public.cfg('max_floating_cash', '2000')::numeric;
begin
  if public.cfg('dispatch_mode', 'AUTO') = 'OFFER' then      -- offer mode: a rider coming online/finishing never "takes" a job; waiting deliveries get their rounds run
    for v_id in select d.id from public.deliveries d
                 where d.status = 'DISPATCHED' and d.rider_id is null
                   and not exists (select 1 from public.delivery_offers x where x.delivery_id = d.id and x.status = 'OFFERED')
                 order by d.dispatched_at limit 5 loop
      perform public._offer_round(v_id);
    end loop;
    return null;
  end if;

  select * into r from public.riders where id = p_rider_id;
  if not found or r.status <> 'ONLINE' or r.verification_status <> 'VERIFIED' or r.geog is null
     or r.last_seen_at is null or r.last_seen_at < now() - make_interval(secs => v_fresh) then return null; end if;
  if exists (select 1 from public.deliveries x where x.rider_id = p_rider_id
              and x.status in ('ACCEPTED','ARRIVED_AT_PHARMACY','PICKED_UP','RETURNING_TO_PHARMACY')) then return null; end if;

  select d.id into v_id
    from public.deliveries d join public.pharmacy_directory p on p.id = d.pharmacy_id
   where d.status = 'DISPATCHED' and d.rider_id is null
     and not (p_rider_id = any (d.excluded_rider_ids))
     and st_dwithin(r.geog, p.geog, v_km * 1000)
     and (d.payment_mode <> 'CASH' or r.cash_in_hand < v_cash)
   order by d.dispatched_at asc
   limit 1
     for update of d skip locked;
  if v_id is null then return null; end if;

  update public.deliveries set rider_id = p_rider_id, status = 'ACCEPTED', accepted_at = now() where id = v_id;
  update public.riders set status = 'ON_DELIVERY' where id = p_rider_id;
  return v_id;
end $$;

-- ====================================================================================
-- RIDER API  (identity ALWAYS comes from auth.uid(); no function takes a rider id)
-- ====================================================================================

-- The rider's current live offer, if any. Deliberately minimal: no customer name/phone/address, no medicines, no exact coordinates.
create or replace function public.get_my_offer() returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid()); v_id uuid; v_offer jsonb;
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  if public.cfg('dispatch_mode', 'AUTO') <> 'OFFER' then return jsonb_build_object('ok', true, 'offer', null, 'serverNow', now()); end if;

  if public._offer_expire_due(null) > 0 then                   -- lazy path: a lapsed round advances even if the scheduler is late
    for v_id in select d.id from public.deliveries d
                 where d.status = 'DISPATCHED' and d.rider_id is null
                   and not exists (select 1 from public.delivery_offers x where x.delivery_id = d.id and x.status = 'OFFERED')
                 order by d.dispatched_at limit 3 loop
      perform public._offer_round(v_id);
    end loop;
  end if;

  select jsonb_build_object(
      'offerId', o.id, 'deliveryId', d.id, 'round', o.round_no,
      'expiresAt', o.expires_at, 'serverNow', now(),
      'secondsLeft', greatest(0, round(extract(epoch from (o.expires_at - now()))::numeric, 1)),
      'windowSeconds', public.cfg('offer_window_seconds', '15')::int,
      'earnings', d.estimated_earnings, 'pickupDistanceKm', o.distance_km, 'tripKm', d.distance_km,
      'requiresPrescription', d.requires_prescription, 'paymentMode', d.payment_mode, 'cashToCollect', d.cash_to_collect,
      'pharmacy', jsonb_build_object('name', p.name, 'address', p.address),
      'dropArea', left(coalesce(nullif(btrim(ord.delivery_landmark), ''), 'Customer location'), 40))
    into v_offer
    from public.delivery_offers o
    join public.deliveries d on d.id = o.delivery_id and d.status = 'DISPATCHED' and d.rider_id is null
    join public.orders ord on ord.id = d.order_id
    join public.pharmacy_directory p on p.id = d.pharmacy_id
   where o.rider_id = v_uid and o.status = 'OFFERED' and o.expires_at > now()
   limit 1;
  return jsonb_build_object('ok', true, 'offer', v_offer, 'serverNow', now());
end $$;

-- Accept. Exactly one rider can win: the delivery row is locked first, every check happens under that lock, and the unique indexes are the backstop.
create or replace function public.accept_offer(p_offer_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid()); o public.delivery_offers; d public.deliveries; r public.riders;
        v_cash numeric := public.cfg('max_floating_cash', '2000')::numeric;
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  select * into o from public.delivery_offers where id = p_offer_id;
  if not found or o.rider_id <> v_uid then return public._err('offer_not_found'); end if;       -- same answer for "not yours" and "doesn't exist"

  select * into d from public.deliveries where id = o.delivery_id for update;                  -- THE serialisation point
  select * into o from public.delivery_offers where id = p_offer_id for update;                -- re-read under the lock

  if o.status = 'ACCEPTED' and d.rider_id = v_uid then                                         -- a repeated tap / retried request: same answer, no second assignment
    return jsonb_build_object('ok', true, 'already', true, 'delivery', jsonb_build_object(
      'status', d.status, 'arrivedAtCustomer', d.arrived_customer_at is not null, 'order', public._delivery_payload(d.id)));
  end if;
  if o.status = 'WITHDRAWN' then return public._err('offer_taken'); end if;
  if o.status = 'EXPIRED'   then return public._err('offer_expired'); end if;
  if o.status <> 'OFFERED'  then return public._err('offer_closed'); end if;
  if o.expires_at <= now() then
    update public.delivery_offers set status = 'EXPIRED', responded_at = now() where id = o.id;
    perform public._offer_log(d.id, v_uid, 'OFFER_EXPIRED', jsonb_build_object('round', o.round_no, 'lateAccept', true));
    return public._err('offer_expired');
  end if;
  if d.status <> 'DISPATCHED' or d.rider_id is not null then
    update public.delivery_offers set status = 'WITHDRAWN', responded_at = now() where id = o.id;
    return public._err('offer_taken');
  end if;

  select * into r from public.riders where id = v_uid for update;
  if not found or r.verification_status <> 'VERIFIED' or r.status <> 'ONLINE' then return public._err('rider_not_available'); end if;
  if d.payment_mode = 'CASH' and r.cash_in_hand >= v_cash then return public._err('cash_limit'); end if;

  begin
    update public.delivery_offers set status = 'ACCEPTED', responded_at = now() where id = o.id;
    update public.deliveries set rider_id = v_uid, status = 'ACCEPTED', accepted_at = now() where id = d.id;   -- trigger withdraws the other riders' offers
    update public.riders set status = 'ON_DELIVERY' where id = v_uid;
  exception when unique_violation then                                                          -- the rider already holds another active job
    return public._err('already_on_delivery');
  end;
  perform public._offer_log(d.id, v_uid, 'OFFER_ACCEPTED', jsonb_build_object('round', o.round_no, 'secondsLeft', round(extract(epoch from (o.expires_at - now()))::numeric, 1)));
  perform public._offer_log(d.id, v_uid, 'RIDER_ASSIGNED', jsonb_build_object('via', 'OFFER'));

  return jsonb_build_object('ok', true, 'delivery', jsonb_build_object(
    'status', 'ACCEPTED', 'arrivedAtCustomer', false, 'order', public._delivery_payload(d.id)));
end $$;

-- Decline. Costs the rider nothing; the delivery simply moves on (immediately if this was the last open offer of the round).
create or replace function public.decline_offer(p_offer_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid()); o public.delivery_offers; d public.deliveries;
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  select * into o from public.delivery_offers where id = p_offer_id;
  if not found or o.rider_id <> v_uid then return public._err('offer_not_found'); end if;
  select * into d from public.deliveries where id = o.delivery_id for update;
  select * into o from public.delivery_offers where id = p_offer_id for update;
  if o.status = 'DECLINED' then return jsonb_build_object('ok', true, 'already', true); end if;
  if o.status <> 'OFFERED' then return public._err(case o.status when 'EXPIRED' then 'offer_expired' when 'WITHDRAWN' then 'offer_taken' else 'offer_closed' end); end if;

  update public.delivery_offers set status = 'DECLINED', responded_at = now() where id = o.id;
  perform public._offer_log(d.id, v_uid, 'OFFER_DECLINED', jsonb_build_object('round', o.round_no));
  if d.status = 'DISPATCHED' and d.rider_id is null
     and not exists (select 1 from public.delivery_offers x where x.delivery_id = d.id and x.status = 'OFFERED' and x.expires_at > now()) then
    perform public._offer_round(d.id);                          -- everybody in the round said no or lapsed: don't make the order wait out the clock
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Rider-initiated cancel, BEFORE pickup only. After pickup the medicines are in the field: use report_delivery_issue (pharmacy reassigns / starts a return).
create or replace function public.rider_cancel_delivery(p_delivery_id uuid, p_reason text, p_notes text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid()); d public.deliveries;
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  if p_reason is null or p_reason not in ('VEHICLE_ISSUE','PERSONAL_EMERGENCY','TOO_FAR','PHARMACY_DELAY','OTHER') then return public._err('invalid_reason'); end if;
  if p_notes is not null and char_length(p_notes) > 300 then return public._err('notes_too_long'); end if;
  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found or d.rider_id is distinct from v_uid then return public._err('not_authorized'); end if;       -- someone else's job looks the same as no job
  if d.status in ('PICKED_UP','RETURNING_TO_PHARMACY') then return public._err('cancel_after_pickup', jsonb_build_object('status', d.status)); end if;
  if d.status not in ('ACCEPTED','ARRIVED_AT_PHARMACY') then return public._err('invalid_state', jsonb_build_object('status', d.status)); end if;

  update public.deliveries
     set rider_id = null, status = 'DISPATCHED', accepted_at = null, arrived_pharmacy_at = null, picked_up_at = null, arrived_customer_at = null,
         pickup_method = null, excluded_rider_ids = array_append(excluded_rider_ids, v_uid), reassign_count = reassign_count + 1,
         issue_type = null, issue_notes = null, issue_reported_at = null
   where id = d.id;                                             -- dispatched_at is kept: a re-queued order keeps its place at the front
  update public.delivery_secrets set pickup_token = encode(gen_random_bytes(16), 'hex'), pickup_attempts = 0 where delivery_id = d.id;
  update public.riders set status = 'ONLINE' where id = v_uid and status = 'ON_DELIVERY';
  perform public._offer_log(d.id, v_uid, 'RIDER_CANCELLED', jsonb_build_object('reason', p_reason, 'notes', left(p_notes, 300), 'fromStatus', d.status));
  perform public._assign_nearest_rider(d.id);                   -- mode-aware: AUTO re-assigns now, OFFER opens a new cycle (the cancelling rider is excluded)
  return jsonb_build_object('ok', true, 'requeued', true);
end $$;

-- ====================================================================================
-- OPERATOR VIEW (service key only): orders no rider has taken
-- ====================================================================================
create or replace function public.admin_dispatch_stuck() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  return jsonb_build_object('ok', true, 'stuck', coalesce((
    select jsonb_agg(jsonb_build_object('deliveryId', d.id, 'orderId', d.order_id, 'pharmacyId', d.pharmacy_id,
             'waitingSince', d.dispatched_at, 'firstExhaustedAt', d.dispatch_exhausted_at, 'cycles', d.dispatch_cycles,
             'reassignCount', d.reassign_count, 'minutesWaiting', round(extract(epoch from (now() - d.dispatched_at)) / 60)) order by d.dispatched_at)
      from public.deliveries d where d.status = 'DISPATCHED' and d.rider_id is null and d.dispatch_exhausted_at is not null), '[]'::jsonb));
end $$;

-- ====================================================================================
-- EXECUTE PRIVILEGES for the new functions (same pattern as migration 2)
-- ====================================================================================
do $$
declare f record;
  rider_fns text[] := array['get_my_offer','accept_offer','decline_offer','rider_cancel_delivery'];
  svc_fns   text[] := array['admin_dispatch_stuck'];
  internal  text[] := array['_offer_log','_offer_expire_due','_offer_round','_deliveries_requeue_reset','_deliveries_withdraw_offers'];
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any (rider_fns || svc_fns || internal)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname = any (rider_fns) then execute format('grant execute on function %s to authenticated', f.sig); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $$;
