-- =====================================================================================
-- SehatWaadi delivery network -- 4/4: secret-exposure audit (NON-BREAKING)
-- =====================================================================================
-- This migration changes NOTHING on pharmacies, pharmacy_inventory, global_medicines or orders, so the POS keeps
-- working exactly as before. The new delivery tables protect themselves (RLS + column privileges, migration 1).
--
-- What it adds:
--   public.secret_exposure_report()          -- who can currently read what, via the public API keys
--   public.lock_pharmacy_api_key_column()    -- OPT-IN: hide pharmacies.api_key from the anon/authenticated keys
--   public.unlock_pharmacy_api_key_column()  -- UNDO for the line above
--
-- Run the report first. If it says anon can read api_key, then ANY holder of your public anon key can read every
-- chemist's credential. Locking it hides that column from the API, which means a POS that does `select=*` on
-- pharmacies, or filters `.eq('api_key', ...)` through the API, will start failing: switch that call to the Express
-- backend / an RPC first, or run unlock_pharmacy_api_key_column() to restore access instantly.
-- =====================================================================================
create or replace function public.secret_exposure_report()
returns table (object text, role_name text, can_read boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare t text := public._pharmacy_table(); r text;
begin
  if not public.is_service_role() then raise exception 'not authorized'; end if;
  foreach r in array array['anon', 'authenticated'] loop
    if public._has_col(t, 'api_key') then
      object := t || '.api_key'; role_name := r;
      can_read := has_column_privilege(r, format('public.%I', t), 'api_key', 'SELECT'); return next;
    end if;
    if public._has_col('orders', 'rx_image') then
      object := 'orders.rx_image'; role_name := r;
      can_read := has_column_privilege(r, 'public.orders', 'rx_image', 'SELECT'); return next;
    end if;
    object := 'delivery_secrets (OTP / QR tokens)'; role_name := r;
    can_read := has_table_privilege(r, 'public.delivery_secrets', 'SELECT'); return next;
  end loop;
end $$;

create or replace function public.lock_pharmacy_api_key_column() returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare t text := public._pharmacy_table(); cols text;
begin
  if not public.is_service_role() then raise exception 'not authorized'; end if;
  if not public._has_col(t, 'api_key') then return 'no api_key column on ' || t; end if;
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns where table_schema = 'public' and table_name = t and column_name <> 'api_key';
  execute format('revoke select on public.%I from anon, authenticated', t);
  execute format('grant select (%s) on public.%I to anon, authenticated', cols, t);
  return format('api_key on %s is now hidden from anon/authenticated. Columns added later need an explicit GRANT.', t);
end $$;

create or replace function public.unlock_pharmacy_api_key_column() returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare t text := public._pharmacy_table();
begin
  if not public.is_service_role() then raise exception 'not authorized'; end if;
  execute format('grant select on public.%I to anon, authenticated', t);
  return format('SELECT on every column of %s restored for anon/authenticated.', t);
end $$;

revoke all on function public.secret_exposure_report(), public.lock_pharmacy_api_key_column(), public.unlock_pharmacy_api_key_column() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.secret_exposure_report(), public.lock_pharmacy_api_key_column(), public.unlock_pharmacy_api_key_column() to service_role;
  end if;
end $$;

-- surface the situation in the SQL editor output
do $$
declare x record;
begin
  for x in select * from public.secret_exposure_report() where can_read and object not like 'delivery_secrets%' loop
    raise warning 'EXPOSED: role "%" can read % through the public API. See the header of this migration.', x.role_name, x.object;
  end loop;
end $$;
