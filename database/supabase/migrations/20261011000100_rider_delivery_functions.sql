-- =====================================================================================
-- SehatWaadi delivery network -- 2/4: server-side logic (every write goes through here)
-- =====================================================================================
-- Every function returns jsonb { ok: true, ... } | { ok: false, error: '<code>', ... }.
-- Rider functions identify the caller ONLY through auth.uid(). There is deliberately NO rider-side
-- accept / decline / cancel: assignment is forced, and only the chemist (or the service key) can
-- cancel, reassign or start a return.
-- =====================================================================================

create or replace function public._err(p_code text, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql immutable as $$ select jsonb_build_object('ok', false, 'error', p_code) || p_extra $$;

create or replace function public._safe_num(p text) returns numeric language plpgsql immutable as $$
begin return nullif(btrim(p), '')::numeric; exception when others then return null; end $$;

create or replace function public._qr_ok(p_qr text, p_prefix text, p_delivery_id uuid, p_token text) returns boolean
language plpgsql immutable as $$
declare v text[];
begin
  v := string_to_array(coalesce(p_qr, ''), '.');
  return coalesce(array_length(v, 1), 0) = 3 and v[1] = p_prefix and v[2] = p_delivery_id::text
         and p_token is not null and v[3] = p_token;
end $$;

-- orders.status sync must never be able to roll back a delivery that really happened
create or replace function public._sync_order_status(p_order_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public._has_col('orders', 'updated_at') then
    execute 'update public.orders set status = $1, updated_at = now() where id = $2' using p_status, p_order_id;
  else
    execute 'update public.orders set status = $1 where id = $2' using p_status, p_order_id;
  end if;
exception when others then
  raise warning 'could not sync orders.status for %: %', p_order_id, sqlerrm;
end $$;

-- what the rider app needs once a job is theirs (customer address/phone are revealed ONLY here)
create or replace function public._delivery_payload(p_delivery_id uuid) returns jsonb
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select jsonb_build_object(
    'orderId', d.order_id, 'deliveryId', d.id, 'status', d.status,
    'earnings', d.estimated_earnings, 'requiresPrescription', d.requires_prescription,
    'cashToCollect', d.cash_to_collect, 'manualPickupAllowed', public.cfg('allow_manual_pickup', 'false') = 'true',
    'payment', jsonb_build_object(
        'mode', d.payment_mode, 'verified', d.payment_verified_at is not null,
        'orderSubtotal', d.order_subtotal, 'deliveryFee', d.delivery_fee, 'amountCollected', d.amount_collected,
        -- for a CASH job: the rider keeps the fee and the subtotal is added to their floating cash
        'floatingCashAdds', case when d.payment_mode = 'CASH' then d.order_subtotal else 0 end),
    'issue', case when d.issue_type is null then null else jsonb_build_object('type', d.issue_type, 'reportedAt', d.issue_reported_at) end,
    'returnReason', d.return_reason,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(i ->> 'name', i #>> '{}'),
                                                           'qty', coalesce((i ->> 'quantity')::int, 1))), '[]'::jsonb)
              from jsonb_array_elements(case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) i),
    'pharmacy', jsonb_build_object('name', p.name, 'address', p.address, 'phone', p.phone, 'lat', d.pickup_lat, 'lng', d.pickup_lng),
    'customer', jsonb_build_object('name', o.contact_name, 'address', o.delivery_address, 'landmark', o.delivery_landmark,
                                   'phone', o.contact_phone, 'lat', d.dropoff_lat, 'lng', d.dropoff_lng, 'area', o.delivery_landmark))
  from public.deliveries d
  join public.orders o on o.id = d.order_id
  join public.pharmacy_directory p on p.id = d.pharmacy_id
  where d.id = p_delivery_id
$$;

-- ====================================================================================
-- SINGLE-CHEMIST CART FULFILMENT  (an order is NEVER split between two pharmacies)
-- ====================================================================================
-- p_items: [{ "medicine_id": "<uuid>" | "name": "Paracetamol 500mg", "quantity": 2 }, ...]
-- Relational division: keep a pharmacy only if NO cart line is missing or short, then order by distance.
-- Stock is summed across batches; expired batches don't count (when pharmacy_inventory has expiry_date).
do $install$
declare v_exp text := case when public._has_col('pharmacy_inventory', 'expiry_date')
                           then 'and coalesce(public._safe_date(inv.expiry_date::text) >= current_date, true)' else '' end;
begin
  execute format($fn$
    create or replace function public.find_eligible_pharmacies(
      p_customer_lat double precision, p_customer_lng double precision, p_items jsonb, p_max_km numeric default 15)
    returns table (pharmacy_id uuid, name text, distance_km numeric)
    language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
    declare v_cust geography := st_setsrid(st_makepoint(p_customer_lng, p_customer_lat), 4326)::geography;
    begin
      if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then return; end if;
      return query
      with raw as (
        select coalesce(e ->> 'medicine_id', e ->> 'medicineId', e ->> 'id') as mid_txt, e ->> 'name' as nm,
               greatest(coalesce(nullif(e ->> 'quantity', '')::int, nullif(e ->> 'qty', '')::int, 1), 1) as qty
          from jsonb_array_elements(p_items) e
      ), resolved as (
        select coalesce(case when r.mid_txt ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then r.mid_txt::uuid end,
                        gm.id) as medicine_id, r.qty
          from raw r left join public.global_medicines gm on r.mid_txt is null and lower(gm.name) = lower(r.nm)
      ), cart as (
        select medicine_id, sum(qty)::int as qty from resolved where medicine_id is not null group by medicine_id
      )
      select d.id, d.name::text, round((st_distance(d.geog, v_cust) / 1000)::numeric, 2)
        from public.pharmacy_directory d
       where not exists (select 1 from resolved where medicine_id is null)                -- an unknown medicine can't be fulfilled
         and st_dwithin(d.geog, v_cust, p_max_km * 1000)
         and not exists (                                                                  -- no cart line may be missing or short
               select 1 from cart c
                where coalesce((select sum(inv.quantity) from public.pharmacy_inventory inv
                                 where inv.pharmacy_id = d.id and inv.medicine_id = c.medicine_id %s), 0) < c.qty)
       order by st_distance(d.geog, v_cust) asc;
    end $$;
  $fn$, v_exp);
end $install$;

-- ====================================================================================
-- ASSIGNMENT (forced, instant, nearest rider)
-- ====================================================================================
-- Locks the nearest eligible rider onto a queued delivery. Returns the rider id, or null (stays queued).
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

-- A rider who just came online / reported a position / finished a drop-off picks up the OLDEST waiting delivery in range.
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

-- ====================================================================================
-- RIDER ACCOUNT
-- ====================================================================================
create or replace function public.register_rider(p_full_name text, p_vehicle_type text, p_vehicle_number text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid()); v_phone text;
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  if char_length(btrim(coalesce(p_full_name, ''))) < 2 then return public._err('invalid_name'); end if;
  if p_vehicle_type is null or p_vehicle_type not in ('BICYCLE','SCOOTER','MOTORCYCLE','EV_SCOOTER') then return public._err('invalid_vehicle'); end if;
  select regexp_replace(coalesce(u.phone, ''), '\D', '', 'g') into v_phone from auth.users u where u.id = v_uid;
  if v_phone is null or v_phone !~ '^[0-9]{10,15}$' then return public._err('phone_missing'); end if;
  if exists (select 1 from public.riders where id = v_uid) then return public._err('already_registered'); end if;
  begin
    insert into public.riders (id, full_name, phone, vehicle_type, vehicle_number)
    values (v_uid, btrim(p_full_name), v_phone, p_vehicle_type, nullif(btrim(coalesce(p_vehicle_number, '')), ''));
  exception when unique_violation then return public._err('phone_in_use'); end;
  return jsonb_build_object('ok', true, 'verificationStatus', 'PENDING');
end $$;

create or replace function public.get_my_rider() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select jsonb_build_object('ok', true, 'rider', jsonb_build_object(
        'id', r.id, 'fullName', r.full_name, 'phone', r.phone, 'vehicleType', r.vehicle_type, 'vehicleNumber', r.vehicle_number,
        'verificationStatus', r.verification_status, 'status', r.status,
        'earningsBalance', r.earnings_balance, 'cashInHand', r.cash_in_hand,
        'maxFloatingCash', public.cfg('max_floating_cash', '2000')::numeric,
        'pendingSettlement', coalesce((select sum(s.amount) from public.cash_settlements s where s.rider_id = r.id and s.status = 'PENDING'), 0),
        'codBlocked', r.cash_in_hand >= public.cfg('max_floating_cash', '2000')::numeric))
     from public.riders r where r.id = (select auth.uid())),
    jsonb_build_object('ok', true, 'rider', null))
$$;

create or replace function public.set_rider_status(p_status text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid()); v_rider public.riders; v_assigned uuid;
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  if p_status not in ('ONLINE', 'OFFLINE') then return public._err('invalid_status'); end if;
  select * into v_rider from public.riders where id = v_uid for update;
  if not found then return public._err('not_a_rider'); end if;
  if v_rider.verification_status <> 'VERIFIED' then return public._err('not_verified'); end if;
  if exists (select 1 from public.deliveries where rider_id = v_uid and status in ('ACCEPTED','ARRIVED_AT_PHARMACY','PICKED_UP','RETURNING_TO_PHARMACY')) then
    return public._err('on_delivery');
  end if;
  update public.riders set status = p_status, last_seen_at = case when p_status = 'ONLINE' then now() else last_seen_at end where id = v_uid;
  if p_status = 'ONLINE' then v_assigned := public._try_assign_queued_delivery(v_uid); end if;   -- first rider online takes the waiting order
  return jsonb_build_object('ok', true, 'status', case when v_assigned is not null then 'ON_DELIVERY' else p_status end,
                            'assignedDeliveryId', v_assigned);
end $$;

create or replace function public.server_time() returns timestamptz language sql stable as $$ select now() $$;

-- ====================================================================================
-- LOCATION (batch upload, safe to retry)
-- ====================================================================================
create or replace function public.push_locations(p_points jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_uid uuid := (select auth.uid()); v_rider public.riders; v_n int; v_valid int; v_stored int;
  v_t timestamptz; v_lat double precision; v_lng double precision; v_bearing real; v_acc real; v_assigned uuid;
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  select * into v_rider from public.riders where id = v_uid;
  if not found then return public._err('not_a_rider'); end if;
  if v_rider.verification_status = 'SUSPENDED' then return public._err('suspended'); end if;
  if p_points is null or jsonb_typeof(p_points) <> 'array' then return public._err('invalid_points'); end if;
  v_n := jsonb_array_length(p_points);
  if v_n = 0 then
    update public.riders set last_seen_at = now() where id = v_uid;
    return jsonb_build_object('ok', true, 'accepted', 0, 'stored', 0, 'rejected', 0);
  end if;
  if v_n > 500 then return public._err('batch_too_large', jsonb_build_object('max', 500)); end if;

  begin
    with parsed as (
      select case when jsonb_typeof(e -> 't') = 'number' then to_timestamp(((e ->> 't')::double precision) / 1000.0)
                  else (e ->> 't')::timestamptz end as t,
             (e ->> 'lat')::double precision as lat, (e ->> 'lng')::double precision as lng,
             nullif(e ->> 'bearing', '')::real as bearing, nullif(e ->> 'speed', '')::real as speed, nullif(e ->> 'accuracy', '')::real as accuracy
        from jsonb_array_elements(p_points) e
    ), valid as (
      select * from parsed where t is not null and lat between -90 and 90 and lng between -180 and 180
         and t > now() - interval '24 hours' and t < now() + interval '5 minutes'
    ), attributed as (
      select v.*, (select d.id from public.deliveries d
                    where d.rider_id = v_uid and d.accepted_at is not null and d.accepted_at <= v.t
                      and v.t <= coalesce(d.delivered_at, d.cancelled_at, d.returned_at, now())
                    order by d.accepted_at desc limit 1) as delivery_id
        from valid v
    ), ins as (
      insert into public.rider_locations (rider_id, delivery_id, recorded_at, lat, lng, bearing, speed, accuracy)
      select v_uid, delivery_id, t, lat, lng, bearing, speed, accuracy from attributed where delivery_id is not null
      on conflict (rider_id, recorded_at) do nothing returning 1
    ), newest as (select t, lat, lng, bearing, accuracy from valid order by t desc limit 1)
    select (select count(*) from valid), (select count(*) from ins), n.t, n.lat, n.lng, n.bearing, n.accuracy
      into v_valid, v_stored, v_t, v_lat, v_lng, v_bearing, v_acc
      from (select 1) one left join newest n on true;
  exception when others then return public._err('invalid_points'); end;

  update public.riders set last_seen_at = now() where id = v_uid;
  if v_t is not null then
    update public.riders set last_lat = v_lat, last_lng = v_lng, last_bearing = v_bearing, last_accuracy = v_acc,
           geog = st_setsrid(st_makepoint(v_lng, v_lat), 4326)::geography, last_position_at = v_t
     where id = v_uid and (last_position_at is null or v_t > last_position_at);
  end if;
  if v_rider.status = 'ONLINE' then v_assigned := public._try_assign_queued_delivery(v_uid); end if;   -- a position fix can make a rider eligible
  return jsonb_build_object('ok', true, 'accepted', v_valid, 'stored', v_stored, 'rejected', v_n - v_valid, 'assignedDeliveryId', v_assigned);
end $$;

-- ====================================================================================
-- DISPATCH  (called once the chemist has accepted the order and printed the receipt)
-- ====================================================================================
-- Service key (Express/Hub/Edge) or the order's own pharmacy staff. Amounts and payment mode come from the
-- ORDER ROW; only the service key may override them (a chemist must not be able to inflate their own receivable).
create or replace function public.dispatch_order(p_order_id uuid, p_order_subtotal numeric default null,
                                                 p_payment_mode text default null, p_pharmacy_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  o public.orders; oj jsonb; v_svc boolean := public.is_service_role(); v_pharm uuid; v_sub numeric; v_mode text;
  v_fee numeric := public.cfg('delivery_fee', '40')::numeric; v_pct numeric := public.cfg('commission_pct', '10')::numeric;
  v_comm numeric; v_pg geography; v_drop geography; v_km numeric; v_existing public.deliveries; v_id uuid; v_b bytea; v_otp text;
  v_rider uuid; v_rinfo jsonb;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then return public._err('order_not_found'); end if;
  oj := to_jsonb(o);
  v_pharm := coalesce(case when v_svc then p_pharmacy_id end, nullif(oj ->> 'current_pharmacy_id', '')::uuid, nullif(oj ->> 'pharmacy_id', '')::uuid);
  if v_pharm is null then return public._err('order_has_no_pharmacy'); end if;
  if not (v_svc or public.is_pharmacy_member(v_pharm)) then return public._err('not_authorized'); end if;
  if not (o.status = any (string_to_array(public.cfg('dispatchable_order_statuses', 'ACCEPTED'), ','))) then return public._err('order_not_accepted'); end if;
  if o.customer_lat is null or o.customer_lng is null then return public._err('order_has_no_location'); end if;

  select * into v_existing from public.deliveries where order_id = p_order_id and status not in ('DELIVERED','CANCELLED','RETURNED');
  if found then return jsonb_build_object('ok', true, 'deliveryId', v_existing.id, 'already', true, 'assigned', v_existing.rider_id is not null); end if;

  v_sub := case when v_svc and p_order_subtotal is not null then p_order_subtotal
                else coalesce(public._safe_num(oj ->> 'subtotal'), public._safe_num(oj ->> 'total_amount'), public._safe_num(oj ->> 'order_total')) end;
  if v_sub is null or v_sub < 0 or v_sub > 100000 then return public._err('order_amount_missing'); end if;
  v_mode := upper(coalesce(case when v_svc then nullif(p_payment_mode, '') end, nullif(oj ->> 'payment_mode', ''), 'CASH'));
  if v_mode = 'COD' then v_mode := 'CASH'; end if;
  if v_mode not in ('CASH', 'UPI_QR', 'PREPAID') then return public._err('invalid_payment_mode'); end if;
  v_comm := round(v_sub * v_pct / 100, 2);

  select p.geog into v_pg from public.pharmacy_directory p where p.id = v_pharm;
  if v_pg is null then return public._err('pharmacy_not_found'); end if;
  v_drop := st_setsrid(st_makepoint(o.customer_lng, o.customer_lat), 4326)::geography;
  v_km := round((st_distance(v_pg, v_drop) / 1000)::numeric, 2);

  insert into public.deliveries (order_id, pharmacy_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, distance_km, requires_prescription,
                                 order_subtotal, delivery_fee, estimated_earnings, platform_commission, pharmacy_net_amount,
                                 amount_collected, cash_to_collect, payment_mode, payment_verified_at)
  select o.id, v_pharm, p.lat, p.lng, o.customer_lat, o.customer_lng, v_km, coalesce(oj ->> 'rx_status', 'NOT_REQUIRED') <> 'NOT_REQUIRED',
         v_sub, v_fee, v_fee, v_comm, v_sub - v_comm, v_sub + v_fee, case when v_mode = 'CASH' then v_sub + v_fee else 0 end,
         v_mode, case when v_mode = 'PREPAID' then now() end            -- PREPAID = already paid at checkout (the Hub only writes it after the gateway confirms)
    from public.pharmacy_directory p where p.id = v_pharm
  returning id into v_id;

  v_b := gen_random_bytes(4);   -- 4-digit OTP from a CSPRNG
  v_otp := lpad((((get_byte(v_b,0)::bigint << 24) + (get_byte(v_b,1)::bigint << 16) + (get_byte(v_b,2)::bigint << 8) + get_byte(v_b,3)) % 10000)::text, 4, '0');
  insert into public.delivery_secrets (delivery_id, otp, pickup_token) values (v_id, v_otp, encode(gen_random_bytes(16), 'hex'));

  v_rider := public._assign_nearest_rider(v_id);                    -- instant, forced; stays queued if nobody is eligible
  if v_rider is not null then
    select jsonb_build_object('id', r.id, 'fullName', r.full_name, 'phone', r.phone, 'vehicleType', r.vehicle_type) into v_rinfo from public.riders r where r.id = v_rider;
  end if;
  return jsonb_build_object('ok', true, 'deliveryId', v_id, 'assigned', v_rider is not null, 'queued', v_rider is null, 'rider', v_rinfo);
end $$;

-- Every ~15-30 s (pg_cron or a scheduled Edge Function): retire riders that went silent, then retry the queue.
create or replace function public.dispatch_tick() returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_stale int; v_assigned int := 0; v_id uuid;
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  update public.riders set status = 'OFFLINE'
   where status = 'ONLINE' and (last_seen_at is null or last_seen_at < now() - interval '3 minutes');
  get diagnostics v_stale = row_count;
  for v_id in select id from public.deliveries where status = 'DISPATCHED' and rider_id is null order by dispatched_at loop
    if public._assign_nearest_rider(v_id) is not null then v_assigned := v_assigned + 1; end if;
  end loop;
  return jsonb_build_object('ok', true, 'ridersMarkedOffline', v_stale, 'assigned', v_assigned,
                            'stillQueued', (select count(*) from public.deliveries where status = 'DISPATCHED' and rider_id is null));
end $$;

-- ====================================================================================
-- RIDER ACTIONS ON THEIR OWN JOB
-- ====================================================================================
create or replace function public.mark_arrived(p_delivery_id uuid, p_at text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid()); d public.deliveries;
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found or d.rider_id is distinct from v_uid then return public._err('not_authorized'); end if;
  if p_at = 'pharmacy' then
    if d.status = 'ARRIVED_AT_PHARMACY' then return jsonb_build_object('ok', true, 'status', d.status); end if;
    if d.status <> 'ACCEPTED' then return public._err('invalid_state', jsonb_build_object('status', d.status)); end if;
    update public.deliveries set status = 'ARRIVED_AT_PHARMACY', arrived_pharmacy_at = now() where id = d.id;
    return jsonb_build_object('ok', true, 'status', 'ARRIVED_AT_PHARMACY');
  elsif p_at = 'customer' then
    if d.status <> 'PICKED_UP' then return public._err('invalid_state', jsonb_build_object('status', d.status)); end if;
    update public.deliveries set arrived_customer_at = coalesce(arrived_customer_at, now()) where id = d.id;
    return jsonb_build_object('ok', true, 'status', 'PICKED_UP');
  end if;
  return public._err('invalid_location');
end $$;

-- pickup: scan the chemist's QR. Manual is OFF by default (config) -- there is no cash and no trust at the counter.
create or replace function public.confirm_pickup(p_delivery_id uuid, p_method text, p_qr text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid()); d public.deliveries; s public.delivery_secrets; v_max int := public.cfg('qr_max_attempts', '10')::int;
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found or d.rider_id is distinct from v_uid then return public._err('not_authorized'); end if;
  if d.status not in ('ACCEPTED', 'ARRIVED_AT_PHARMACY') then return public._err('invalid_state', jsonb_build_object('status', d.status)); end if;
  select * into s from public.delivery_secrets where delivery_id = d.id for update;

  if upper(coalesce(p_method, '')) = 'QR' then
    if s.pickup_attempts >= v_max then return public._err('qr_locked'); end if;
    if not public._qr_ok(p_qr, 'SW1', d.id, s.pickup_token) then
      update public.delivery_secrets set pickup_attempts = pickup_attempts + 1 where delivery_id = d.id;
      return public._err('qr_mismatch');
    end if;
    update public.deliveries set status = 'PICKED_UP', pickup_method = 'QR', picked_up_at = now(),
           arrived_pharmacy_at = coalesce(arrived_pharmacy_at, now()) where id = d.id;
  elsif upper(coalesce(p_method, '')) = 'MANUAL' then
    if public.cfg('allow_manual_pickup', 'false') <> 'true' then return public._err('manual_not_allowed'); end if;
    update public.deliveries set status = 'PICKED_UP', pickup_method = 'MANUAL', picked_up_at = now(),
           arrived_pharmacy_at = coalesce(arrived_pharmacy_at, now()) where id = d.id;
  else
    return public._err('invalid_method');
  end if;
  update public.delivery_secrets set pickup_token = null where delivery_id = d.id;
  return jsonb_build_object('ok', true, 'status', 'PICKED_UP');
end $$;

-- drop-off. The OTP is checked HERE (never on the device). The payment mode is validated against what the PLATFORM verified:
--   * platform has the money (PREPAID, or a UPI payment confirmed by the webhook)  -> rider must report UPI_QR/PREPAID; reporting CASH is refused
--   * platform has NOT verified a payment                                          -> only CASH is possible; claiming UPI_QR is refused
-- so a rider can neither pocket cash while claiming "paid by UPI", nor inflate their own floating cash.
create or replace function public.complete_delivery(p_delivery_id uuid, p_otp text, p_payment_mode text default null, p_proof_path text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_uid uuid := (select auth.uid()); d public.deliveries; s public.delivery_secrets; v_eff text;
  v_max int := public.cfg('otp_max_attempts', '5')::int; v_left int; v_cash numeric; v_earn numeric; v_next uuid;
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found or d.rider_id is distinct from v_uid then return public._err('not_authorized'); end if;
  if d.status <> 'PICKED_UP' then return public._err('invalid_state', jsonb_build_object('status', d.status)); end if;

  v_eff := upper(coalesce(nullif(p_payment_mode, ''), d.payment_mode));
  if v_eff not in ('CASH', 'UPI_QR', 'PREPAID') then return public._err('invalid_payment_mode'); end if;
  if d.payment_verified_at is not null then
    if v_eff = 'CASH' then return public._err('payment_mismatch'); end if;
  elsif v_eff <> 'CASH' then
    return public._err('payment_not_verified');
  end if;

  if p_otp is null or p_otp !~ '^[0-9]{4}$' then return public._err('invalid_otp'); end if;
  if p_proof_path is not null and (left(p_proof_path, 37) <> d.id::text || '/' or char_length(p_proof_path) > 200) then return public._err('invalid_proof_path'); end if;

  select * into s from public.delivery_secrets where delivery_id = d.id for update;
  if s.otp_locked_at is not null then return public._err('otp_locked'); end if;
  if s.otp is null or s.otp <> p_otp then
    update public.delivery_secrets set otp_attempts = otp_attempts + 1,
           otp_locked_at = case when otp_attempts + 1 >= v_max then now() else null end
     where delivery_id = d.id returning greatest(v_max - otp_attempts, 0) into v_left;
    if v_left <= 0 then return public._err('otp_locked'); end if;
    return public._err('invalid_otp', jsonb_build_object('attemptsLeft', v_left));
  end if;

  -- ---- money: instant COD netting + the chemist's credit ----------------------------------------------------------------------------
  if v_eff = 'CASH' then
    -- customer pays amount_collected (e.g. 800) in cash; the rider keeps the fee (40) and owes the platform the subtotal (760)
    update public.riders set cash_in_hand = cash_in_hand + d.order_subtotal where id = v_uid returning cash_in_hand, earnings_balance into v_cash, v_earn;
    insert into public.rider_ledger (rider_id, delivery_id, entry_type, amount, cash_in_hand_after, earnings_balance_after, note)
    values (v_uid, d.id, 'COD_COLLECTED', d.order_subtotal, v_cash, v_earn, 'cash owed to SehatWaadi'),
           (v_uid, d.id, 'COD_FEE_KEPT',  d.delivery_fee,   v_cash, v_earn, 'delivery fee kept from the cash collected (no balance change)');
  else
    -- the customer paid SehatWaadi digitally, so the rider holds no cash and is OWED the fee
    update public.riders set earnings_balance = earnings_balance + d.estimated_earnings where id = v_uid returning cash_in_hand, earnings_balance into v_cash, v_earn;
    insert into public.rider_ledger (rider_id, delivery_id, entry_type, amount, cash_in_hand_after, earnings_balance_after, note)
    values (v_uid, d.id, 'DELIVERY_EARNING', d.estimated_earnings, v_cash, v_earn, 'delivery fee credited');
  end if;
  insert into public.pharmacy_ledger (pharmacy_id, delivery_id, order_id, entry_type, gross_amount, commission, amount, note)
  values (d.pharmacy_id, d.id, d.order_id, 'DELIVERY_CREDIT', d.order_subtotal, d.platform_commission, d.pharmacy_net_amount, 'receivable from SehatWaadi')
  on conflict (delivery_id, entry_type) do nothing;

  update public.deliveries set status = 'DELIVERED', delivered_at = now(), proof_path = p_proof_path, payment_mode = v_eff where id = d.id;
  update public.delivery_secrets set otp = null, pickup_token = null, return_token = null where delivery_id = d.id;
  update public.riders set status = 'ONLINE' where id = v_uid and status = 'ON_DELIVERY';
  perform public._sync_order_status(d.order_id, public.cfg('order_delivered_status', 'DELIVERED'));
  v_next := public._try_assign_queued_delivery(v_uid);            -- a rider who just finished takes the next waiting order straight away
  return jsonb_build_object('ok', true, 'earnings', d.estimated_earnings, 'paymentMode', v_eff,
                            'cashInHand', v_cash, 'earningsBalance', v_earn, 'nextDeliveryId', v_next);
end $$;

create or replace function public.get_active_delivery() returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid()); d public.deliveries;
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  select * into d from public.deliveries where rider_id = v_uid
     and status in ('ACCEPTED','ARRIVED_AT_PHARMACY','PICKED_UP','RETURNING_TO_PHARMACY') limit 1;
  if not found then return jsonb_build_object('ok', true, 'delivery', null); end if;
  return jsonb_build_object('ok', true, 'delivery', jsonb_build_object(
    'status', d.status, 'arrivedAtCustomer', d.arrived_customer_at is not null, 'order', public._delivery_payload(d.id)));
end $$;

-- ====================================================================================
-- SOS, REASSIGNMENT, RETURN LOOP
-- ====================================================================================
-- The rider can RAISE a problem; it never unassigns them and there is no self-cancel. The chemist's POS is alerted via Realtime.
create or replace function public.report_delivery_issue(p_delivery_id uuid, p_issue_type text, p_notes text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid()); d public.deliveries; v_phone text;
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  if p_issue_type is null or p_issue_type not in ('VEHICLE_BREAKDOWN', 'ACCIDENT', 'CUSTOMER_UNREACHABLE') then return public._err('invalid_issue_type'); end if;
  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found or d.rider_id is distinct from v_uid then return public._err('not_authorized'); end if;
  if d.status not in ('ACCEPTED','ARRIVED_AT_PHARMACY','PICKED_UP','RETURNING_TO_PHARMACY') then return public._err('invalid_state', jsonb_build_object('status', d.status)); end if;
  if p_issue_type = 'CUSTOMER_UNREACHABLE' and d.status <> 'PICKED_UP' then return public._err('invalid_state', jsonb_build_object('status', d.status)); end if;
  update public.deliveries set issue_type = p_issue_type, issue_notes = left(nullif(btrim(coalesce(p_notes, '')), ''), 500), issue_reported_at = now() where id = d.id;
  select p.phone into v_phone from public.pharmacy_directory p where p.id = d.pharmacy_id;
  return jsonb_build_object('ok', true, 'pharmacyPhone', v_phone);
end $$;

-- Chemist/service only. Takes the rider off the job (and OFFLINE, so a broken-down rider isn't re-assigned), rotates the pickup token,
-- and force-assigns the next nearest rider -- or queues the delivery if nobody is free.
create or replace function public.reassign_delivery(p_delivery_id uuid, p_reason text default 'REASSIGNED_BY_PHARMACY') returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare d public.deliveries; v_old uuid; v_new uuid; v_rinfo jsonb;
begin
  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found then return public._err('delivery_not_found'); end if;
  if not (public.is_service_role() or public.is_pharmacy_member(d.pharmacy_id)) then return public._err('not_authorized'); end if;
  if d.status not in ('ACCEPTED','ARRIVED_AT_PHARMACY','PICKED_UP') then return public._err('invalid_state', jsonb_build_object('status', d.status)); end if;
  v_old := d.rider_id;

  update public.deliveries
     set rider_id = null, status = 'DISPATCHED', accepted_at = null, arrived_pharmacy_at = null, picked_up_at = null, arrived_customer_at = null,
         pickup_method = null, excluded_rider_ids = array_append(excluded_rider_ids, v_old), reassign_count = reassign_count + 1,
         issue_type = null, issue_notes = null, issue_reported_at = null, dispatched_at = now()
   where id = d.id;
  update public.delivery_secrets set pickup_token = encode(gen_random_bytes(16), 'hex'), pickup_attempts = 0 where delivery_id = d.id;
  update public.riders set status = 'OFFLINE' where id = v_old;          -- cooldown: must consciously go ONLINE again

  v_new := public._assign_nearest_rider(d.id);
  if v_new is not null then
    select jsonb_build_object('id', r.id, 'fullName', r.full_name, 'phone', r.phone) into v_rinfo from public.riders r where r.id = v_new;
  end if;
  return jsonb_build_object('ok', true, 'previousRiderId', v_old, 'assigned', v_new is not null, 'queued', v_new is null, 'rider', v_rinfo, 'reason', left(p_reason, 80));
end $$;

-- Doorstep failure: the bag goes back to the chemist. The rider stays locked on the delivery until the chemist scans back in.
create or replace function public.initiate_return(p_delivery_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare d public.deliveries;
begin
  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found then return public._err('delivery_not_found'); end if;
  if not (public.is_service_role() or public.is_pharmacy_member(d.pharmacy_id)) then return public._err('not_authorized'); end if;
  if d.status <> 'PICKED_UP' then return public._err('invalid_state', jsonb_build_object('status', d.status)); end if;
  update public.deliveries set status = 'RETURNING_TO_PHARMACY', returning_at = now(), return_reason = left(coalesce(p_reason, 'UNSPECIFIED'), 200) where id = d.id;
  update public.delivery_secrets set return_token = encode(gen_random_bytes(16), 'hex'), return_attempts = 0, otp = null where delivery_id = d.id;   -- no drop-off possible any more
  return jsonb_build_object('ok', true, 'status', 'RETURNING_TO_PHARMACY');
end $$;

create or replace function public.get_return_qr(p_delivery_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare d public.deliveries; s public.delivery_secrets;
begin
  select * into d from public.deliveries where id = p_delivery_id;
  if not found then return public._err('delivery_not_found'); end if;
  if not (public.is_service_role() or public.is_pharmacy_member(d.pharmacy_id)) then return public._err('not_authorized'); end if;
  select * into s from public.delivery_secrets where delivery_id = d.id;
  if d.status <> 'RETURNING_TO_PHARMACY' or s.return_token is null then return public._err('qr_not_available'); end if;
  return jsonb_build_object('ok', true, 'qr', 'SWR1.' || d.id::text || '.' || s.return_token);
end $$;

create or replace function public._finish_return(p_delivery_id uuid, p_by text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare d public.deliveries; v_fee numeric; v_cash numeric; v_earn numeric; v_next uuid;
begin
  select * into d from public.deliveries where id = p_delivery_id for update;
  v_fee := round(d.delivery_fee * public.cfg('return_fee_pct', '100')::numeric / 100, 2);
  update public.deliveries set status = 'RETURNED', returned_at = now() where id = d.id;
  update public.delivery_secrets set otp = null, pickup_token = null, return_token = null where delivery_id = d.id;
  update public.riders set earnings_balance = earnings_balance + v_fee where id = d.rider_id returning cash_in_hand, earnings_balance into v_cash, v_earn;
  if v_fee > 0 then
    insert into public.rider_ledger (rider_id, delivery_id, entry_type, amount, cash_in_hand_after, earnings_balance_after, note)
    values (d.rider_id, d.id, 'RETURN_EARNING', v_fee, v_cash, v_earn, 'return trip fee (' || p_by || ')');
  end if;
  update public.riders set status = 'ONLINE' where id = d.rider_id and status = 'ON_DELIVERY';     -- rider unlocked
  perform public._sync_order_status(d.order_id, public.cfg('order_returned_status', 'RETURNED'));
  v_next := public._try_assign_queued_delivery(d.rider_id);
  return jsonb_build_object('ok', true, 'status', 'RETURNED', 'nextDeliveryId', v_next);
end $$;

-- rider hands the sealed bag back and scans the chemist's RETURN QR
create or replace function public.confirm_return(p_delivery_id uuid, p_qr text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid()); d public.deliveries; s public.delivery_secrets; v_max int := public.cfg('qr_max_attempts', '10')::int;
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found or d.rider_id is distinct from v_uid then return public._err('not_authorized'); end if;
  if d.status <> 'RETURNING_TO_PHARMACY' then return public._err('invalid_state', jsonb_build_object('status', d.status)); end if;
  select * into s from public.delivery_secrets where delivery_id = d.id for update;
  if s.return_attempts >= v_max then return public._err('qr_locked'); end if;
  if not public._qr_ok(p_qr, 'SWR1', d.id, s.return_token) then
    update public.delivery_secrets set return_attempts = return_attempts + 1 where delivery_id = d.id;
    return public._err('qr_mismatch');
  end if;
  return public._finish_return(d.id, 'QR');
end $$;

-- safety valve for support: closes a stuck return (e.g. the rider's phone died at the counter) without a QR
create or replace function public.admin_close_return(p_delivery_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare d public.deliveries;
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found then return public._err('delivery_not_found'); end if;
  if d.status <> 'RETURNING_TO_PHARMACY' then return public._err('invalid_state', jsonb_build_object('status', d.status)); end if;
  return public._finish_return(d.id, 'ADMIN: ' || left(coalesce(p_reason, ''), 60));
end $$;

-- Before pickup only. After pickup the medicines are in the field: use initiate_return, never a bare cancel.
create or replace function public.cancel_delivery(p_delivery_id uuid, p_reason text default 'CANCELLED_BY_PHARMACY') returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare d public.deliveries;
begin
  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found then return public._err('delivery_not_found'); end if;
  if not (public.is_service_role() or public.is_pharmacy_member(d.pharmacy_id)) then return public._err('not_authorized'); end if;
  if d.status = 'PICKED_UP' or d.status = 'RETURNING_TO_PHARMACY' then return public._err('use_return', jsonb_build_object('status', d.status)); end if;
  if d.status not in ('DISPATCHED', 'ACCEPTED', 'ARRIVED_AT_PHARMACY') then return public._err('invalid_state', jsonb_build_object('status', d.status)); end if;
  update public.deliveries set status = 'CANCELLED', cancelled_at = now(), cancel_reason = left(p_reason, 60) where id = d.id;
  update public.delivery_secrets set otp = null, pickup_token = null, return_token = null where delivery_id = d.id;
  if d.rider_id is not null then
    update public.riders set status = 'ONLINE' where id = d.rider_id and status = 'ON_DELIVERY';
    perform public._try_assign_queued_delivery(d.rider_id);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ====================================================================================
-- PHARMACY-SIDE / PLATFORM-SIDE HELPERS
-- ====================================================================================
create or replace function public.get_pickup_qr(p_delivery_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare d public.deliveries; s public.delivery_secrets;
begin
  select * into d from public.deliveries where id = p_delivery_id;
  if not found then return public._err('delivery_not_found'); end if;
  if not (public.is_service_role() or public.is_pharmacy_member(d.pharmacy_id)) then return public._err('not_authorized'); end if;
  select * into s from public.delivery_secrets where delivery_id = d.id;
  if s.pickup_token is null then return public._err('qr_not_available'); end if;
  return jsonb_build_object('ok', true, 'qr', 'SW1.' || d.id::text || '.' || s.pickup_token);
end $$;

-- service key only: the Hub reads this to tell the CUSTOMER their OTP. Riders and chemists can never read it.
create or replace function public.get_delivery_otp(p_order_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
declare v_otp text;
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  select s.otp into v_otp from public.deliveries d join public.delivery_secrets s on s.delivery_id = d.id
   where d.order_id = p_order_id and d.status not in ('DELIVERED','CANCELLED','RETURNED') order by d.created_at desc limit 1;
  if v_otp is null then return public._err('otp_not_available'); end if;
  return jsonb_build_object('ok', true, 'otp', v_otp);
end $$;

-- service key only: the payment webhook calls this when a customer's UPI payment (e.g. at the door) has actually reached SehatWaadi
create or replace function public.confirm_delivery_payment(p_delivery_id uuid, p_payment_ref text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare d public.deliveries;
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found then return public._err('delivery_not_found'); end if;
  if d.status in ('DELIVERED','CANCELLED','RETURNED') then return public._err('invalid_state', jsonb_build_object('status', d.status)); end if;
  if char_length(coalesce(p_payment_ref, '')) < 4 then return public._err('invalid_payment_ref'); end if;
  update public.deliveries set payment_verified_at = coalesce(payment_verified_at, now()), payment_ref = p_payment_ref,
         payment_mode = case when payment_mode = 'CASH' then 'UPI_QR' else payment_mode end,
         cash_to_collect = 0 where id = d.id;
  return jsonb_build_object('ok', true);
end $$;

-- ====================================================================================
-- FLOATING-CASH SETTLEMENT (rider pays SehatWaadi by UPI)
-- ====================================================================================
-- The rider reports a UPI payment; cash_in_hand drops only once the platform CONFIRMS it actually arrived. (A rider's own
-- word cannot erase their debt.) With settlement_auto_confirm='true' -- dev/test only -- it applies immediately.
create or replace function public._apply_settlement(p_id uuid, p_by text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare s public.cash_settlements; v_cash numeric; v_earn numeric; v_next uuid;
begin
  select * into s from public.cash_settlements where id = p_id for update;
  if not found or s.status <> 'PENDING' then return public._err('invalid_state'); end if;
  update public.riders set cash_in_hand = greatest(cash_in_hand - s.amount, 0) where id = s.rider_id returning cash_in_hand, earnings_balance into v_cash, v_earn;
  update public.cash_settlements set status = 'CONFIRMED', resolved_at = now(), resolved_by = p_by where id = s.id;
  insert into public.rider_ledger (rider_id, entry_type, amount, cash_in_hand_after, earnings_balance_after, note)
  values (s.rider_id, 'CASH_SETTLEMENT', s.amount, v_cash, v_earn, 'UPI ref ' || s.upi_ref);
  v_next := public._try_assign_queued_delivery(s.rider_id);        -- settling can unlock a waiting COD order
  return jsonb_build_object('ok', true, 'cashInHand', v_cash, 'nextDeliveryId', v_next);
end $$;

create or replace function public.settle_rider_cash(p_amount numeric, p_upi_ref text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid()); r public.riders; v_pending numeric; v_id uuid; v_ref text := btrim(coalesce(p_upi_ref, ''));
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  select * into r from public.riders where id = v_uid for update;
  if not found then return public._err('not_a_rider'); end if;
  if p_amount is null or p_amount <= 0 then return public._err('invalid_amount'); end if;
  if v_ref !~ '^[A-Za-z0-9._-]{6,40}$' then return public._err('invalid_reference'); end if;
  select coalesce(sum(amount), 0) into v_pending from public.cash_settlements where rider_id = v_uid and status = 'PENDING';
  if p_amount > r.cash_in_hand - v_pending then return public._err('amount_exceeds_cash', jsonb_build_object('cashInHand', r.cash_in_hand, 'pending', v_pending)); end if;
  begin
    insert into public.cash_settlements (rider_id, amount, upi_ref) values (v_uid, round(p_amount, 2), v_ref) returning id into v_id;
  exception when unique_violation then return public._err('duplicate_reference'); end;
  if public.cfg('settlement_auto_confirm', 'false') = 'true' then
    return public._apply_settlement(v_id, 'AUTO(dev)') || jsonb_build_object('settlementId', v_id, 'status', 'CONFIRMED');
  end if;
  return jsonb_build_object('ok', true, 'settlementId', v_id, 'status', 'PENDING');
end $$;

create or replace function public.confirm_cash_settlement(p_settlement_id uuid, p_verified_by text default 'service') returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  return public._apply_settlement(p_settlement_id, left(coalesce(p_verified_by, 'service'), 60));
end $$;

create or replace function public.reject_cash_settlement(p_settlement_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare n int;
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  update public.cash_settlements set status = 'REJECTED', resolved_at = now(), resolved_by = 'service', note = left(p_note, 200)
   where id = p_settlement_id and status = 'PENDING';
  get diagnostics n = row_count;
  return case when n > 0 then jsonb_build_object('ok', true) else public._err('invalid_state') end;
end $$;

create or replace function public.purge_old_rider_locations() returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare n bigint;
begin
  if not public.is_service_role() then raise exception 'not authorized'; end if;
  delete from public.rider_locations where recorded_at < now() - make_interval(days => public.cfg('location_retention_days', '14')::int);
  get diagnostics n = row_count;
  return n;
end $$;

-- ====================================================================================
-- EXECUTE PRIVILEGES (Postgres grants EXECUTE to PUBLIC by default: remove it, then grant exactly what is needed)
-- ====================================================================================
do $$
declare f record;
  rider_fns text[] := array['register_rider','get_my_rider','set_rider_status','server_time','push_locations','mark_arrived','confirm_pickup',
                            'complete_delivery','get_active_delivery','report_delivery_issue','confirm_return','settle_rider_cash'];
  staff_fns text[] := array['dispatch_order','cancel_delivery','reassign_delivery','initiate_return','get_pickup_qr','get_return_qr'];  -- the function checks pharmacy membership
  rls_fns   text[] := array['is_pharmacy_member','is_service_role','cfg'];
  svc_fns   text[] := array['find_eligible_pharmacies','dispatch_tick','get_delivery_otp','confirm_delivery_payment','confirm_cash_settlement',
                            'reject_cash_settlement','admin_close_return','purge_old_rider_locations'];
  internal  text[] := array['_err','_safe_num','_qr_ok','_sync_order_status','_delivery_payload','_assign_nearest_rider','_try_assign_queued_delivery',
                            '_finish_return','_apply_settlement','_pharmacy_table','_has_col','_safe_date','touch_updated_at'];
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any (rider_fns || staff_fns || rls_fns || svc_fns || internal)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname = any (rider_fns || staff_fns || rls_fns) then execute format('grant execute on function %s to authenticated', f.sig); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $$;
