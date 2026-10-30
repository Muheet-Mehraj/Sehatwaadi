-- Settlements. Additive; safe to re-run.
--  A. A payment reference (UTR) must be a real-looking 12-digit UPI/IMPS reference. Used for the rider's cash deposit AND for payouts to chemists.
--  B. Chemist payouts: the chemist CLAIMS what SehatWaadi owes him (order value minus commission), SehatWaadi PAYS it and records the
--     UTR, and the chemist CONFIRMS he received it. Only then is it settled and his balance is zero. Either side can stop it: the chemist can say
--     "not received" (DISPUTED), SehatWaadi can cancel a request before paying.
do $$ begin
  if to_regclass('public.deliveries') is null or to_regclass('public.cash_settlements') is null then
    raise exception 'settlements: run the rider_delivery migrations first';
  end if;
end $$;

-- ---- A. payment reference rule ----------------------------------------------------------------------------------------------------------
-- Exactly 12 digits (a UPI transaction id / bank RRN). Rejects the usual typed-in fakes: one repeated digit (111111111111), runs
-- (123456789012, 987654321098), and any short block repeated (121212121212, 123123123123). The bank is not asked: the operator still checks
-- the money arrived before confirming. This only stops obvious junk from ever reaching that queue.
create or replace function public.valid_payment_ref(p text) returns boolean
language sql immutable as $$
  select p is not null
     and p ~ '^[0-9]{12}$'
     and p !~ '^([0-9]{1,6})\1+$'
     and position(p in '01234567890123456789') = 0
     and position(p in '98765432109876543210') = 0
$$;
create or replace function public.clean_payment_ref(p text) returns text
language sql immutable as $$ select regexp_replace(coalesce(p, ''), '[[:space:]]+', '', 'g') $$;

-- Same function as before with ONE change: the reference must pass valid_payment_ref() (spaces are ignored).
create or replace function public.settle_rider_cash(p_amount numeric, p_upi_ref text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid()); r public.riders; v_pending numeric; v_id uuid; v_ref text := public.clean_payment_ref(p_upi_ref);
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  select * into r from public.riders where id = v_uid for update;
  if not found then return public._err('not_a_rider'); end if;
  if p_amount is null or p_amount <= 0 then return public._err('invalid_amount'); end if;
  if not public.valid_payment_ref(v_ref) then return public._err('invalid_reference'); end if;
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

-- ---- B. chemist payouts ------------------------------------------------------------------------------------------------------------------
create table if not exists public.pharmacy_settlements (
  id             uuid primary key default gen_random_uuid(),
  pharmacy_id    uuid not null,
  status         text not null default 'REQUESTED' check (status in ('REQUESTED','PAID','CONFIRMED','DISPUTED','CANCELLED')),
  amount         numeric(12,2) not null check (amount > 0),          -- frozen when the chemist claims it
  orders_count   int not null check (orders_count > 0),
  requested_at   timestamptz not null default now(),
  paid_ref       text check (paid_ref is null or public.valid_payment_ref(paid_ref)),
  paid_at        timestamptz, paid_by text, note text,
  confirmed_at   timestamptz,
  disputed_at    timestamptz, dispute_note text,
  cancelled_at   timestamptz, cancelled_by text, cancel_note text,
  updated_at     timestamptz not null default now()
);
-- one open claim per pharmacy at a time
create unique index if not exists pharmacy_settlements_one_open on public.pharmacy_settlements (pharmacy_id) where status in ('REQUESTED','PAID','DISPUTED');
create unique index if not exists pharmacy_settlements_ref_uniq on public.pharmacy_settlements (lower(paid_ref)) where paid_ref is not null;   -- one payment settles once
create index if not exists pharmacy_settlements_pharmacy_idx on public.pharmacy_settlements (pharmacy_id, requested_at desc);

-- the orders a claim covers. delivery_id is the primary key: an order can only ever be claimed once (cancelling a claim frees its orders).
create table if not exists public.pharmacy_settlement_items (
  delivery_id   uuid primary key references public.deliveries(id),
  settlement_id uuid not null references public.pharmacy_settlements(id) on delete cascade,
  amount        numeric(10,2) not null
);
create index if not exists pharmacy_settlement_items_settlement_idx on public.pharmacy_settlement_items (settlement_id);
alter table public.pharmacy_settlements enable row level security;       -- no policies: Hub / service key only
alter table public.pharmacy_settlement_items enable row level security;

create or replace function public._payout_row(s public.pharmacy_settlements) returns jsonb language sql stable as $$
  select jsonb_build_object('id', s.id, 'status', s.status, 'amount', s.amount, 'ordersCount', s.orders_count, 'requestedAt', s.requested_at,
    'paidRef', s.paid_ref, 'paidAt', s.paid_at, 'paidBy', s.paid_by, 'note', s.note, 'confirmedAt', s.confirmed_at,
    'disputedAt', s.disputed_at, 'disputeNote', s.dispute_note, 'cancelledAt', s.cancelled_at, 'cancelNote', s.cancel_note)
$$;

-- What the chemist sees: what is waiting to be claimed, the open claim (if any) and recent history.
create or replace function public.payout_summary(p_pharmacy uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_amt numeric; v_n int; v_open public.pharmacy_settlements; v_hist jsonb;
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  select coalesce(sum(d.pharmacy_net_amount), 0), count(*)::int into v_amt, v_n
    from public.deliveries d where d.pharmacy_id = p_pharmacy and d.status = 'DELIVERED'
     and not exists (select 1 from public.pharmacy_settlement_items i where i.delivery_id = d.id);
  select * into v_open from public.pharmacy_settlements where pharmacy_id = p_pharmacy and status in ('REQUESTED','PAID','DISPUTED');
  select coalesce(jsonb_agg(public._payout_row(h) order by h.requested_at desc), '[]'::jsonb) into v_hist
    from (select * from public.pharmacy_settlements where pharmacy_id = p_pharmacy and status in ('CONFIRMED','CANCELLED') order by requested_at desc limit 20) h;
  return jsonb_build_object('ok', true, 'unsettled', jsonb_build_object('amount', v_amt, 'orders', v_n),
                            'open', case when v_open.id is null then null else public._payout_row(v_open) end, 'history', v_hist);
end $$;

-- The chemist claims everything currently unsettled. Orders finished after this moment go into the next claim.
create or replace function public.payout_request(p_pharmacy uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_amt numeric; v_n int; v_id uuid; v_min numeric := public.cfg('payout_min_amount', '1')::numeric;
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  perform pg_advisory_xact_lock(hashtextextended('payout:' || p_pharmacy::text, 0));
  if exists (select 1 from public.pharmacy_settlements where pharmacy_id = p_pharmacy and status in ('REQUESTED','PAID','DISPUTED')) then
    return public._err('settlement_already_open');
  end if;
  select coalesce(sum(d.pharmacy_net_amount), 0), count(*)::int into v_amt, v_n
    from public.deliveries d where d.pharmacy_id = p_pharmacy and d.status = 'DELIVERED'
     and not exists (select 1 from public.pharmacy_settlement_items i where i.delivery_id = d.id);
  if v_n = 0 or v_amt < v_min then return public._err('nothing_to_settle', jsonb_build_object('amount', v_amt, 'orders', v_n)); end if;
  insert into public.pharmacy_settlements (pharmacy_id, amount, orders_count) values (p_pharmacy, round(v_amt, 2), v_n) returning id into v_id;
  insert into public.pharmacy_settlement_items (delivery_id, settlement_id, amount)
    select d.id, v_id, d.pharmacy_net_amount from public.deliveries d where d.pharmacy_id = p_pharmacy and d.status = 'DELIVERED'
       and not exists (select 1 from public.pharmacy_settlement_items i where i.delivery_id = d.id);
  return jsonb_build_object('ok', true, 'settlementId', v_id, 'amount', round(v_amt, 2), 'orders', v_n);
end $$;

-- The chemist took it back before it was paid.
create or replace function public.payout_withdraw(p_pharmacy uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare n int;
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  update public.pharmacy_settlements set status = 'CANCELLED', cancelled_at = now(), cancelled_by = 'pharmacy', cancel_note = 'Withdrawn by the pharmacy', updated_at = now()
   where id = p_id and pharmacy_id = p_pharmacy and status = 'REQUESTED';
  get diagnostics n = row_count;
  if n = 0 then return public._err('invalid_state'); end if;
  delete from public.pharmacy_settlement_items where settlement_id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- The chemist confirms the money arrived. This is what settles it.
create or replace function public.payout_confirm(p_pharmacy uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare s public.pharmacy_settlements;
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  select * into s from public.pharmacy_settlements where id = p_id and pharmacy_id = p_pharmacy for update;
  if not found then return public._err('not_found'); end if;
  if s.status = 'CONFIRMED' then return jsonb_build_object('ok', true, 'already', true); end if;
  if s.status <> 'PAID' then return public._err('invalid_state', jsonb_build_object('status', s.status)); end if;
  update public.pharmacy_settlements set status = 'CONFIRMED', confirmed_at = now(), updated_at = now() where id = s.id;
  return jsonb_build_object('ok', true);
end $$;

-- "I did not receive it."
create or replace function public.payout_dispute(p_pharmacy uuid, p_id uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare n int; v_note text := btrim(coalesce(p_note, ''));
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  if char_length(v_note) < 3 then return public._err('note_required'); end if;
  update public.pharmacy_settlements set status = 'DISPUTED', disputed_at = now(), dispute_note = left(v_note, 300), updated_at = now()
   where id = p_id and pharmacy_id = p_pharmacy and status = 'PAID';
  get diagnostics n = row_count;
  return case when n > 0 then jsonb_build_object('ok', true) else public._err('invalid_state') end;
end $$;

-- ---- operator side -------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_payout_list(p_status text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v jsonb;
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  select coalesce(jsonb_agg(public._payout_row(s) || jsonb_build_object('pharmacyId', s.pharmacy_id, 'pharmacyName', p.name) order by s.requested_at), '[]'::jsonb) into v
    from public.pharmacy_settlements s left join public.pharmacy_directory p on p.id = s.pharmacy_id
   where (p_status is null and s.status in ('REQUESTED','PAID','DISPUTED')) or s.status = p_status;
  return jsonb_build_object('ok', true, 'settlements', v);
end $$;

-- SehatWaadi has paid. The reference must be a valid payment reference and can never be reused. A DISPUTED claim can be paid again (with the correct reference).
create or replace function public.admin_payout_pay(p_id uuid, p_ref text, p_by text default 'admin', p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare n int; v_ref text := public.clean_payment_ref(p_ref);
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  if not public.valid_payment_ref(v_ref) then return public._err('invalid_reference'); end if;
  begin
    update public.pharmacy_settlements set status = 'PAID', paid_ref = v_ref, paid_at = now(), paid_by = left(coalesce(p_by, 'admin'), 60), note = left(p_note, 200), updated_at = now()
     where id = p_id and status in ('REQUESTED','DISPUTED');
  exception when unique_violation then return public._err('duplicate_reference'); end;
  get diagnostics n = row_count;
  return case when n > 0 then jsonb_build_object('ok', true) else public._err('invalid_state') end;
end $$;

-- SehatWaadi cancels a claim (nothing was paid, or a disputed one is being restarted). Its orders become claimable again.
create or replace function public.admin_payout_cancel(p_id uuid, p_note text default null, p_by text default 'admin') returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare n int;
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  update public.pharmacy_settlements set status = 'CANCELLED', cancelled_at = now(), cancelled_by = left(coalesce(p_by, 'admin'), 60), cancel_note = left(p_note, 200), updated_at = now()
   where id = p_id and status in ('REQUESTED','DISPUTED');
  get diagnostics n = row_count;
  if n = 0 then return public._err('invalid_state'); end if;
  delete from public.pharmacy_settlement_items where settlement_id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---- privileges: nothing here is callable from a phone ---------------------------------------------------------------------------------
do $$
declare f record;
  svc text[] := array['payout_summary','payout_request','payout_withdraw','payout_confirm','payout_dispute','admin_payout_list','admin_payout_pay','admin_payout_cancel'];
  pub text[] := array['valid_payment_ref','clean_payment_ref','_payout_row'];
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any (svc || pub || array['settle_rider_cash'])
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname = 'settle_rider_cash' or f.proname = any (pub) then execute format('grant execute on function %s to authenticated', f.sig); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $$;
revoke all on public.pharmacy_settlements, public.pharmacy_settlement_items from public, anon, authenticated;
