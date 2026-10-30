-- =====================================================================================
-- SehatWaadi delivery network -- 1/4: tables, indexes, row-level security, privileges
-- Model: BLINKIT-STYLE FORCED AUTO-ASSIGNMENT + hub-and-spoke cash clearinghouse.
--   * no offers, no accept/decline, no rider cancel -- the nearest eligible rider is locked in instantly
--   * riders and chemists never exchange cash; SehatWaadi nets everything in a ledger
-- =====================================================================================
-- WHAT THIS EXPECTS FROM YOUR PROJECT (checked below, with a readable error if something differs):
--   public.pharmacies  (falls back to public.network_pharmacies)   id uuid, name, + coordinates:
--                      lat/lng | latitude/longitude | a geography/geometry column named geog/location/geom
--   public.pharmacy_inventory   pharmacy_id uuid, medicine_id uuid, quantity   (expiry_date optional)
--   public.global_medicines     id uuid, name
--   public.orders               id uuid, status, customer_lat, customer_lng, items (jsonb)
--                               optional: current_pharmacy_id | pharmacy_id, rx_status, payment_mode,
--                                         subtotal | total_amount | order_total
-- Nothing here changes existing columns or grants on those tables (only adds nullable columns).
-- =====================================================================================

create schema if not exists extensions;
create extension if not exists postgis  with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---- which pharmacy table does this project use? ---------------------------------------------------------
create or replace function public._pharmacy_table() returns text language sql stable as $$
  select case when to_regclass('public.pharmacies') is not null then 'pharmacies'
              when to_regclass('public.network_pharmacies') is not null then 'network_pharmacies' end
$$;
create or replace function public._has_col(p_table text, p_col text) returns boolean language sql stable as $$
  select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = p_table and column_name = p_col)
$$;

-- ---- preflight -----------------------------------------------------------------------------------------------
do $$
declare
  t text := public._pharmacy_table(); problems text[] := '{}'; c text;
  coords boolean;
begin
  if t is null then raise exception 'Neither public.pharmacies nor public.network_pharmacies exists.'; end if;
  foreach c in array array['id','name'] loop
    if not public._has_col(t, c) then problems := problems || (t || '.' || c); end if;
  end loop;
  coords := (public._has_col(t,'lat') and public._has_col(t,'lng'))
         or (public._has_col(t,'latitude') and public._has_col(t,'longitude'))
         or public._has_col(t,'geog') or public._has_col(t,'location') or public._has_col(t,'geom');
  if not coords then problems := problems || (t || ' coordinates (lat/lng, latitude/longitude, or geog/location/geom)'); end if;
  if public._has_col(t,'id') and (select data_type from information_schema.columns where table_schema='public' and table_name=t and column_name='id') <> 'uuid' then
    problems := problems || (t || '.id must be uuid');
  end if;

  if to_regclass('public.pharmacy_inventory') is null then problems := problems || 'table public.pharmacy_inventory'::text;
  else foreach c in array array['pharmacy_id','medicine_id','quantity'] loop
         if not public._has_col('pharmacy_inventory', c) then problems := problems || ('pharmacy_inventory.' || c); end if;
       end loop; end if;
  if to_regclass('public.global_medicines') is null then problems := problems || 'table public.global_medicines'::text;
  else foreach c in array array['id','name'] loop
         if not public._has_col('global_medicines', c) then problems := problems || ('global_medicines.' || c); end if;
       end loop; end if;
  if to_regclass('public.orders') is null then problems := problems || 'table public.orders'::text;
  else foreach c in array array['id','status','customer_lat','customer_lng','items'] loop
         if not public._has_col('orders', c) then problems := problems || ('orders.' || c); end if;
       end loop; end if;

  if cardinality(problems) > 0 then
    raise exception 'Cannot install: missing prerequisite(s): %. Run the schema probe in supabase/README.md and adapt, or send me its output.', array_to_string(problems, ', ');
  end if;
end $$;

-- ---- additive, nullable columns the rider needs ------------------------------------------------------------------
alter table public.orders add column if not exists delivery_address  text;
alter table public.orders add column if not exists delivery_landmark text;
alter table public.orders add column if not exists contact_name      text;
alter table public.orders add column if not exists contact_phone     text;
do $$ begin
  execute format('alter table public.%I add column if not exists address text', public._pharmacy_table());
  execute format('alter table public.%I add column if not exists phone text',   public._pharmacy_table());
end $$;

-- ---- the ONE place delivery code reads the pharmacy table ---------------------------------------------------------------
do $$
declare
  t text := public._pharmacy_table(); lat_e text; lng_e text; geo text;
begin
  if public._has_col(t,'lat') and public._has_col(t,'lng') then lat_e := 'p.lat'; lng_e := 'p.lng';
  elsif public._has_col(t,'latitude') and public._has_col(t,'longitude') then lat_e := 'p.latitude'; lng_e := 'p.longitude';
  else
    geo := case when public._has_col(t,'geog') then 'geog' when public._has_col(t,'location') then 'location' else 'geom' end;
    lat_e := format('st_y(p.%I::geometry)', geo); lng_e := format('st_x(p.%I::geometry)', geo);
  end if;
  execute 'drop view if exists public.pharmacy_directory';
  execute format($v$
    create view public.pharmacy_directory as
    select p.id, p.name, p.address, p.phone,
           (%1$s)::double precision as lat, (%2$s)::double precision as lng,
           st_setsrid(st_makepoint((%2$s)::double precision, (%1$s)::double precision), 4326)::geography as geog
      from public.%3$I p
     where (%1$s) is not null and (%2$s) is not null
  $v$, lat_e, lng_e, t);
end $$;
revoke all on public.pharmacy_directory from public, anon, authenticated;

-- ---- helpers + configuration ------------------------------------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create or replace function public._safe_date(p text) returns date language plpgsql immutable as $$
begin return nullif(left(btrim(p), 10), '')::date; exception when others then return null; end $$;

create table public.delivery_config (key text primary key, value text not null, description text);
insert into public.delivery_config (key, value, description) values
  ('rider_fresh_seconds',   '90',   'A rider must have reported a position this recently to be assigned'),
  ('max_assign_radius_km',  '30',   'Furthest a rider may be from the pharmacy and still be auto-assigned'),
  ('max_floating_cash',     '2000', 'COD cash a rider may hold; at/over this they get NO new cash-on-delivery orders (prepaid still flow)'),
  ('delivery_fee',          '40',   'PLACEHOLDER: flat delivery fee in rupees; 100% goes to the rider'),
  ('commission_pct',        '10',   'PLACEHOLDER: SehatWaadi commission on the medicine subtotal, charged to the chemist'),
  ('return_fee_pct',        '100',  'PLACEHOLDER: % of the delivery fee paid to the rider when a delivery is RETURNED'),
  ('allow_manual_pickup',   'false','If true, a rider may confirm pickup without the QR (audited). Default off: zero cash and zero trust at the counter'),
  ('otp_max_attempts',      '5',    'Wrong delivery OTPs before the delivery is locked for support'),
  ('qr_max_attempts',       '10',   'Wrong pickup / return QR scans before that QR is locked'),
  ('settlement_auto_confirm','false','DEV ONLY: apply a rider UPI settlement instantly instead of waiting for verification'),
  ('dispatchable_order_statuses','ACCEPTED','Comma list of orders.status values that mean "chemist accepted"'),
  ('order_delivered_status','DELIVERED','Value written to orders.status when delivered'),
  ('order_returned_status', 'RETURNED', 'Value written to orders.status when returned to the chemist'),
  ('location_retention_days','14',  'Breadcrumb retention for rider_locations');

create or replace function public.cfg(p_key text, p_default text default null) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select value from public.delivery_config where key = p_key), p_default)
$$;

-- ---- riders (+ wallet) ----------------------------------------------------------------------------------------------------------------
create table public.riders (
  id                  uuid primary key references auth.users(id) on delete cascade,
  full_name           text not null check (char_length(btrim(full_name)) between 2 and 100),
  phone               text not null unique check (phone ~ '^[0-9]{10,15}$'),
  vehicle_type        text not null check (vehicle_type in ('BICYCLE','SCOOTER','MOTORCYCLE','EV_SCOOTER')),
  vehicle_number      text check (vehicle_number is null or char_length(vehicle_number) <= 20),
  verification_status text not null default 'PENDING' check (verification_status in ('PENDING','VERIFIED','SUSPENDED')),
  status              text not null default 'OFFLINE' check (status in ('ONLINE','OFFLINE','ON_DELIVERY')),
  earnings_balance    numeric(10,2) not null default 0 check (earnings_balance >= 0),  -- SehatWaadi owes the rider
  cash_in_hand        numeric(10,2) not null default 0 check (cash_in_hand >= 0),      -- the rider owes SehatWaadi (COD cash)
  last_lat double precision, last_lng double precision, last_bearing real, last_accuracy real,
  geog                geography(Point, 4326),
  last_seen_at        timestamptz,
  last_position_at    timestamptz,
  verified_at         timestamptz,
  verified_by         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index riders_assign_geog_idx on public.riders using gist (geog)
  where status = 'ONLINE' and verification_status = 'VERIFIED';
create trigger riders_touch before update on public.riders for each row execute function public.touch_updated_at();

-- ---- pharmacy staff <-> pharmacy (so RLS can express "this chemist's own rows") -----------------------------------------------------------
create table public.pharmacy_members (
  user_id     uuid not null references auth.users(id) on delete cascade,
  pharmacy_id uuid not null,
  role        text not null default 'STAFF' check (role in ('STAFF','OWNER')),
  created_at  timestamptz not null default now(),
  primary key (user_id, pharmacy_id)
);
create index pharmacy_members_pharmacy_idx on public.pharmacy_members (pharmacy_id);

-- ---- deliveries ----------------------------------------------------------------------------------------------------------------------------------
create table public.deliveries (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid not null references public.orders(id) on delete restrict,
  pharmacy_id          uuid not null,
  rider_id             uuid references public.riders(id),
  status               text not null default 'DISPATCHED'
    check (status in ('DISPATCHED','ACCEPTED','ARRIVED_AT_PHARMACY','PICKED_UP','DELIVERED','CANCELLED','RETURNING_TO_PHARMACY','RETURNED')),
  -- snapshot at dispatch
  pickup_lat double precision not null, pickup_lng double precision not null,
  dropoff_lat double precision not null, dropoff_lng double precision not null,
  distance_km          numeric(6,2),
  requires_prescription boolean not null default false,
  -- money: the customer's bill is order_subtotal + delivery_fee (= amount_collected)
  order_subtotal       numeric(10,2) not null check (order_subtotal >= 0),         -- medicines, e.g. 760
  delivery_fee         numeric(10,2) not null default 0 check (delivery_fee >= 0), -- e.g. 40, 100% to the rider
  estimated_earnings   numeric(10,2) not null default 0,                           -- = delivery_fee
  platform_commission  numeric(10,2) not null default 0,                           -- e.g. 76  (NOT visible to riders)
  pharmacy_net_amount  numeric(10,2) not null default 0,                           -- e.g. 684 (NOT visible to riders)
  amount_collected     numeric(10,2) not null default 0,                           -- e.g. 800
  cash_to_collect      numeric(10,2) not null default 0,                           -- = amount_collected for CASH, else 0
  payment_mode         text not null default 'CASH' check (payment_mode in ('CASH','UPI_QR','PREPAID')),
  payment_verified_at  timestamptz,                                                -- set ONLY by the platform (webhook / service key)
  payment_ref          text,
  excluded_rider_ids   uuid[] not null default '{}',                               -- riders already taken off this job
  reassign_count       int not null default 0,
  pickup_method        text check (pickup_method in ('QR','MANUAL')),
  proof_path           text,
  cancel_reason        text,
  -- SOS
  issue_type           text check (issue_type in ('VEHICLE_BREAKDOWN','ACCIDENT','CUSTOMER_UNREACHABLE')),
  issue_notes          text check (issue_notes is null or char_length(issue_notes) <= 500),
  issue_reported_at    timestamptz,
  -- return loop
  return_reason        text,
  returning_at         timestamptz,
  returned_at          timestamptz,
  dispatched_at        timestamptz not null default now(),
  accepted_at          timestamptz, arrived_pharmacy_at timestamptz, picked_up_at timestamptz,
  arrived_customer_at  timestamptz, delivered_at timestamptz, cancelled_at timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (rider_id is not null or status in ('DISPATCHED','CANCELLED')),
  check (amount_collected = order_subtotal + delivery_fee)
);
create unique index deliveries_one_live_per_order on public.deliveries (order_id)
  where status not in ('DELIVERED','CANCELLED','RETURNED');
create unique index deliveries_one_live_per_rider on public.deliveries (rider_id)
  where rider_id is not null and status in ('ACCEPTED','ARRIVED_AT_PHARMACY','PICKED_UP','RETURNING_TO_PHARMACY');
create index deliveries_queue_idx    on public.deliveries (dispatched_at) where status = 'DISPATCHED' and rider_id is null;
create index deliveries_rider_idx    on public.deliveries (rider_id, created_at desc);
create index deliveries_pharmacy_idx on public.deliveries (pharmacy_id, created_at desc);
create trigger deliveries_touch before update on public.deliveries for each row execute function public.touch_updated_at();

create table public.delivery_secrets (
  delivery_id     uuid primary key references public.deliveries(id) on delete cascade,
  otp             text, otp_attempts int not null default 0, otp_locked_at timestamptz,
  pickup_token    text, pickup_attempts int not null default 0,
  return_token    text, return_attempts int not null default 0,
  created_at      timestamptz not null default now()
);

create table public.rider_locations (
  id          bigint generated always as identity primary key,
  rider_id    uuid not null references public.riders(id) on delete cascade,
  delivery_id uuid references public.deliveries(id) on delete set null,
  recorded_at timestamptz not null,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  bearing real, speed real, accuracy real,
  received_at timestamptz not null default now(),
  unique (rider_id, recorded_at)
);
create index rider_locations_delivery_idx on public.rider_locations (delivery_id, recorded_at) where delivery_id is not null;
create index rider_locations_recorded_idx on public.rider_locations (recorded_at);

-- ---- clearinghouse ledgers (append-only; written only by the functions) ----------------------------------------------------------------------------
create table public.pharmacy_ledger (            -- what SehatWaadi owes each chemist
  id          bigint generated always as identity primary key,
  pharmacy_id uuid not null,
  delivery_id uuid not null references public.deliveries(id),
  order_id    uuid not null,
  entry_type  text not null check (entry_type in ('DELIVERY_CREDIT')),
  gross_amount numeric(10,2) not null,           -- medicine subtotal
  commission  numeric(10,2) not null,
  amount      numeric(10,2) not null,            -- credit = gross - commission  (e.g. 684)
  note        text,
  created_at  timestamptz not null default now(),
  unique (delivery_id, entry_type)               -- a delivery can only ever be credited once
);
create index pharmacy_ledger_pharmacy_idx on public.pharmacy_ledger (pharmacy_id, created_at desc);

create table public.rider_ledger (               -- every movement of a rider's wallet / floating cash
  id          bigint generated always as identity primary key,
  rider_id    uuid not null references public.riders(id),
  delivery_id uuid references public.deliveries(id),
  entry_type  text not null check (entry_type in ('COD_COLLECTED','COD_FEE_KEPT','DELIVERY_EARNING','RETURN_EARNING','CASH_SETTLEMENT')),
  amount      numeric(10,2) not null,
  cash_in_hand_after   numeric(10,2) not null,
  earnings_balance_after numeric(10,2) not null,
  note        text,
  created_at  timestamptz not null default now()
);
create index rider_ledger_rider_idx on public.rider_ledger (rider_id, created_at desc);

create table public.cash_settlements (           -- rider -> SehatWaadi UPI payments of floating cash
  id          uuid primary key default gen_random_uuid(),
  rider_id    uuid not null references public.riders(id),
  amount      numeric(10,2) not null check (amount > 0),
  upi_ref     text not null check (char_length(upi_ref) between 6 and 40),
  status      text not null default 'PENDING' check (status in ('PENDING','CONFIRMED','REJECTED')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz, resolved_by text, note text
);
create unique index cash_settlements_ref_uniq on public.cash_settlements (lower(upi_ref));   -- one UPI payment settles once
create index cash_settlements_rider_idx on public.cash_settlements (rider_id, created_at desc);

-- foreign keys to whichever pharmacy table this project uses
do $$
declare t text := public._pharmacy_table();
begin
  execute format('alter table public.pharmacy_members add constraint pharmacy_members_pharmacy_fk foreign key (pharmacy_id) references public.%I(id) on delete cascade', t);
  execute format('alter table public.deliveries       add constraint deliveries_pharmacy_fk       foreign key (pharmacy_id) references public.%I(id)', t);
  execute format('alter table public.pharmacy_ledger  add constraint pharmacy_ledger_pharmacy_fk  foreign key (pharmacy_id) references public.%I(id)', t);
end $$;

-- ---- RLS helpers --------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.is_pharmacy_member(p_pharmacy uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.pharmacy_members m where m.user_id = (select auth.uid()) and m.pharmacy_id = p_pharmacy)
$$;
-- true for the service key (Hub / Edge Functions / Express backend) and for an admin on a direct DB connection
create or replace function public.is_service_role() returns boolean
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
                  nullif(current_setting('request.jwt.claim.role', true), ''), '') = 'service_role'
      or session_user in ('postgres', 'supabase_admin')
$$;

-- ---- RLS: read-only for the owners of the rows --------------------------------------------------------------------------------------------------------------
alter table public.riders            enable row level security;
alter table public.pharmacy_members  enable row level security;
alter table public.deliveries        enable row level security;
alter table public.delivery_secrets  enable row level security;   -- deliberately no policy
alter table public.rider_locations   enable row level security;
alter table public.pharmacy_ledger   enable row level security;
alter table public.rider_ledger      enable row level security;
alter table public.cash_settlements  enable row level security;
alter table public.delivery_config   enable row level security;   -- deliberately no policy

create policy riders_read_self on public.riders for select to authenticated using (id = (select auth.uid()));
create policy riders_read_assigned_to_my_pharmacy on public.riders for select to authenticated using (exists (
  select 1 from public.deliveries d where d.rider_id = riders.id
     and d.status in ('ACCEPTED','ARRIVED_AT_PHARMACY','PICKED_UP','RETURNING_TO_PHARMACY') and public.is_pharmacy_member(d.pharmacy_id)));
create policy members_read_self on public.pharmacy_members for select to authenticated using (user_id = (select auth.uid()));
create policy deliveries_read_rider    on public.deliveries for select to authenticated using (rider_id = (select auth.uid()));
create policy deliveries_read_pharmacy on public.deliveries for select to authenticated using (public.is_pharmacy_member(pharmacy_id));
create policy locations_read_rider on public.rider_locations for select to authenticated using (rider_id = (select auth.uid()));
create policy locations_read_pharmacy on public.rider_locations for select to authenticated using (delivery_id is not null and exists (
  select 1 from public.deliveries d where d.id = rider_locations.delivery_id and public.is_pharmacy_member(d.pharmacy_id)));
create policy pharmacy_ledger_read on public.pharmacy_ledger for select to authenticated using (public.is_pharmacy_member(pharmacy_id));
create policy rider_ledger_read    on public.rider_ledger    for select to authenticated using (rider_id = (select auth.uid()));
create policy settlements_read     on public.cash_settlements for select to authenticated using (rider_id = (select auth.uid()));

-- ---- privileges: SELECT only, and only the COLUMNS each audience may see -------------------------------------------------------------------------------------
revoke all on public.riders, public.pharmacy_members, public.deliveries, public.delivery_secrets, public.rider_locations,
              public.pharmacy_ledger, public.rider_ledger, public.cash_settlements, public.delivery_config
  from public, anon, authenticated;
grant select on public.pharmacy_members, public.rider_locations, public.pharmacy_ledger, public.rider_ledger, public.cash_settlements to authenticated;

-- riders: the wallet (earnings_balance / cash_in_hand) is returned to the rider by get_my_rider(), never exposed to chemists
grant select (id, full_name, phone, vehicle_type, vehicle_number, status, verification_status,
              last_lat, last_lng, last_bearing, last_accuracy, last_seen_at) on public.riders to authenticated;

-- deliveries: commission, the chemist's net amount, payment refs and the exclusion list are invisible to riders AND to the API in general
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'deliveries'
     and column_name not in ('platform_commission', 'pharmacy_net_amount', 'payment_ref', 'excluded_rider_ids');
  execute format('grant select (%s) on public.deliveries to authenticated', cols);

  -- Realtime reads the WAL through this publication. A column list means the hidden columns never leave Postgres,
  -- so a rider's websocket can't receive them either (RLS alone filters rows, not columns).
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'deliveries') then
      alter publication supabase_realtime drop table public.deliveries;
    end if;
    execute format('alter publication supabase_realtime add table public.deliveries (%s)', cols);
  end if;
end $$;
