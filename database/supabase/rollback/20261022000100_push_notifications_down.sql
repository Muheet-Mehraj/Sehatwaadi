drop trigger if exists delivery_offers_push on public.delivery_offers;
drop trigger if exists deliveries_push_assign on public.deliveries;
drop function if exists public._push_on_offer(), public._push_on_assign(), public.push_claim(int), public.push_report(jsonb),
  public.register_push_device(text, text, text), public.unregister_push_device(text);
drop table if exists public.push_outbox, public.push_devices;
