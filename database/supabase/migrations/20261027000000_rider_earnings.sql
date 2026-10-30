-- Rider earnings summary, so the app can show clearly what the rider has EARNED (read-only; no money rules change). Safe to re-run.
-- A rider's money comes in two ways:
--   cash orders   : the rider keeps the delivery fee out of the cash he collects (ledger COD_FEE_KEPT; earnings_balance does NOT change)
--   online orders : SehatWaadi owes the rider the fee (ledger DELIVERY_EARNING / RETURN_EARNING; earnings_balance goes up)
-- "Earned" = both together. Days are counted in Indian time.
do $$ begin
  if to_regclass('public.rider_ledger') is null then raise exception 'rider_earnings: run the rider_delivery migrations first'; end if;
end $$;

create or replace function public._earn_block(p_rider uuid, p_since timestamptz) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'keptFromCash', coalesce(sum(l.amount) filter (where l.entry_type = 'COD_FEE_KEPT'), 0),
    'credited',     coalesce(sum(l.amount) filter (where l.entry_type in ('DELIVERY_EARNING', 'RETURN_EARNING')), 0),
    'deliveries',   count(distinct l.delivery_id) filter (where l.entry_type in ('COD_FEE_KEPT', 'DELIVERY_EARNING', 'RETURN_EARNING')))
  from public.rider_ledger l where l.rider_id = p_rider and l.created_at >= p_since
$$;

create or replace function public.get_my_earnings() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_uid uuid := (select auth.uid()); r public.riders;
        v_day0 timestamptz := (date_trunc('day', now() at time zone 'Asia/Kolkata')) at time zone 'Asia/Kolkata';
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  select * into r from public.riders where id = v_uid;
  if not found then return public._err('not_a_rider'); end if;
  return jsonb_build_object('ok', true,
    'today', public._earn_block(v_uid, v_day0),
    'week',  public._earn_block(v_uid, v_day0 - interval '6 days'),
    'all',   public._earn_block(v_uid, '-infinity'::timestamptz),
    'owedToRider', r.earnings_balance,         -- online-paid fees SehatWaadi still has to pay out
    'cashInHand', r.cash_in_hand);             -- order amounts collected in cash that belong to SehatWaadi (the rider's own fees are NOT in here)
end $$;

revoke all on function public._earn_block(uuid, timestamptz), public.get_my_earnings() from public, anon, authenticated;
grant execute on function public.get_my_earnings() to authenticated;
