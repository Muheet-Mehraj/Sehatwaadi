-- Removes the chemist payout tables and restores the old (looser) rider reference rule. Payout history is DELETED.
drop function if exists public.payout_summary(uuid), public.payout_request(uuid), public.payout_withdraw(uuid, uuid), public.payout_confirm(uuid, uuid),
  public.payout_dispute(uuid, uuid, text), public.admin_payout_list(text), public.admin_payout_pay(uuid, text, text, text), public.admin_payout_cancel(uuid, text, text), public._payout_row(public.pharmacy_settlements);
drop table if exists public.pharmacy_settlement_items, public.pharmacy_settlements;
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
drop function if exists public.valid_payment_ref(text), public.clean_payment_ref(text);
