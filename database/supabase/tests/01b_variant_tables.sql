-- TEST ONLY: a project that uses network_pharmacies with ONLY a geography column (no lat/lng), to prove the adaptive view
create table public.network_pharmacies (id uuid primary key default gen_random_uuid(), name text, api_key text, geog geography(Point, 4326));
create table public.global_medicines (id uuid primary key default gen_random_uuid(), name text);
create table public.pharmacy_inventory (id uuid primary key default gen_random_uuid(), pharmacy_id uuid, medicine_id uuid, quantity int);
create table public.orders (id uuid primary key default gen_random_uuid(), customer_lat double precision, customer_lng double precision, items jsonb, status text, current_pharmacy_id uuid, subtotal numeric);
