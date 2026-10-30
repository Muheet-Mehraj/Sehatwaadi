-- =====================================================================================================================================
-- ROLLBACK of 20261022000000_offer_dispatch.sql
--   FIRST choice (instant, loses nothing):   update public.delivery_config set value = 'AUTO' where key = 'dispatch_mode';
--   Use THIS script only to remove the feature entirely. It deletes offer history and the dispatch audit trail (delivery_offers,
--   delivery_events): export them first if you want to keep them:
--       \copy (select * from public.delivery_events order by id) to 'delivery_events.csv' csv header
-- Orders, riders, deliveries, wallets and ledgers are NOT touched. Any delivery currently waiting stays DISPATCHED and is picked up by the
-- legacy forced assignment on the next dispatch tick.
-- =====================================================================================================================================
begin;
  update public.delivery_config set value = 'AUTO' where key = 'dispatch_mode';   -- stop offer logic first

  -- restore the two original entry points (verbatim from 20261011000100)
  create or replace function public._assign_nearest_rider(p_delivery_id uuid) returns uuid
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  d public.deliveries; v_geog geography; v_rider uuid;
  v_fresh int := public.cfg('rider_fresh_seconds', '90')::int;
  v_km numeric := public.cfg('max_assign_radius_km', '30')::numeric;
  v_cash numeric := public.cfg('max_floating_cash', '2000')::numeric;
begin
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

  drop function if exists public.admin_dispatch_stuck();
  drop function if exists public.rider_cancel_delivery(uuid, text, text);
  drop function if exists public.decline_offer(uuid);
  drop function if exists public.accept_offer(uuid);
  drop function if exists public.get_my_offer();
  drop function if exists public._offer_round(uuid);
  drop function if exists public._offer_expire_due(uuid);
  drop function if exists public._offer_log(uuid, uuid, text, jsonb);

  drop trigger if exists deliveries_withdraw_offers on public.deliveries;
  drop trigger if exists deliveries_requeue_reset   on public.deliveries;
  drop function if exists public._deliveries_withdraw_offers();
  drop function if exists public._deliveries_requeue_reset();

  drop table if exists public.delivery_offers;
  drop table if exists public.delivery_events;

  alter table public.deliveries
    drop column if exists dispatch_round, drop column if exists dispatch_cycles,
    drop column if exists offer_deadline, drop column if exists dispatch_exhausted_at;

  delete from public.delivery_config where key in ('dispatch_mode','offer_window_seconds','offer_group_size','offer_radius_steps_km','offer_retry_seconds','order_cancelled_statuses');
commit;
