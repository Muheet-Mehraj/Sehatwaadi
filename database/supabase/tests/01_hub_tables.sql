-- TEST ONLY: the project's existing tables, created BEFORE the migrations (as they already exist in a live project).
create table public.pharmacies (
  id uuid primary key default gen_random_uuid(), name text, api_key text, lat double precision, lng double precision,
  is_active boolean default true, created_at timestamptz default now());
create table public.global_medicines (id uuid primary key default gen_random_uuid(), name text, price numeric, schedule_class text);
create table public.pharmacy_inventory (
  id uuid primary key default gen_random_uuid(), pharmacy_id uuid references public.pharmacies(id), medicine_id uuid references public.global_medicines(id),
  quantity int not null default 0, batch_number text, expiry_date text, last_synced_at timestamptz);
create table public.customers (id uuid primary key default gen_random_uuid(), phone text unique not null, name text);
create table public.orders (
  id uuid primary key default gen_random_uuid(), customer_lat double precision, customer_lng double precision, items jsonb,
  status text, current_pharmacy_id uuid, rx_status text, rx_image text, payment_mode text, subtotal numeric,
  customer_id uuid, created_at timestamptz default now(), updated_at timestamptz default now());
