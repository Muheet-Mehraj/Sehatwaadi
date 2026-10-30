-- =====================================================================================
-- TEST ONLY: imitates the parts of Supabase that the migrations rely on, so the SQL can be exercised
-- on a plain Postgres (with PostGIS + pgcrypto). Roles, auth.uid()/auth.jwt(), default grants,
-- storage.objects/buckets, the realtime publication.
-- NEVER run this on a real Supabase project: it would replace the real auth functions.
-- =====================================================================================
do $$
begin
  if to_regclass('auth.schema_migrations') is not null or exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    raise exception 'REFUSING TO RUN: this looks like a real Supabase database. These stubs are for a scratch Postgres only.';
  end if;
end $$;

create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;
create extension if not exists postgis  with schema extensions;
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon          nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role  nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit password 'authenticator'; end if;
end $$;
grant anon, authenticated, service_role to authenticator;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  phone text,
  email text,
  created_at timestamptz default now()
);

-- same contract as Supabase: read the verified JWT claims PostgREST puts in a GUC
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select auth.jwt() ->> 'role'
$$;

create table if not exists storage.buckets (
  id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid default auth.uid(), created_at timestamptz default now()
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;

do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if;
end $$;

-- Supabase's DEFAULT privileges: every new table/function in `public` is open to the API roles.
-- The migrations must explicitly close what should be closed -- this makes the tests prove that they do.
grant usage on schema public, extensions, auth, storage to anon, authenticated, service_role;
grant select on all tables in schema storage to authenticated;
grant insert on storage.objects to authenticated;
grant execute on function auth.uid(), auth.jwt(), auth.role(), storage.foldername(text) to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
