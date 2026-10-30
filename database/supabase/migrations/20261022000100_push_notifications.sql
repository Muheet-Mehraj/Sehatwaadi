-- Rider push notifications (FCM). Additive and safe to re-run.
--   push_devices : one row per phone token a rider has registered (RPC-only writes, RLS on, no policies)
--   push_outbox  : "tell this rider" rows, written by triggers when an OFFER is created (or, in AUTO mode, an order is assigned)
--   The Hub's push worker drains the outbox with push_claim() and reports back with push_report(); it is the only thing that talks to Firebase.
-- Nothing here changes dispatch behaviour: if the Hub worker is off, riders simply keep getting offers the old way (in-app polling).
do $$ begin
  if to_regclass('public.riders') is null or to_regclass('public.delivery_offers') is null or to_regclass('public.deliveries') is null then
    raise exception 'push_notifications: run the rider_delivery and offer_dispatch migrations first';
  end if;
end $$;

create table if not exists public.push_devices (
  token           text primary key check (char_length(token) between 20 and 4096),
  rider_id        uuid not null references public.riders(id) on delete cascade,
  platform        text not null default 'android' check (platform in ('android','ios','web')),
  app_version     text check (app_version is null or char_length(app_version) <= 40),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_success_at timestamptz
);
create index if not exists push_devices_rider_idx on public.push_devices (rider_id);
alter table public.push_devices enable row level security;   -- no policy on purpose: only the SECURITY DEFINER functions and the service key touch it

create table if not exists public.push_outbox (
  id          bigserial primary key,
  rider_id    uuid not null references public.riders(id) on delete cascade,
  kind        text not null check (kind in ('OFFER','ASSIGNED')),
  delivery_id uuid,
  offer_id    uuid,
  expires_at  timestamptz,                    -- OFFER: when the offer closes (a push after this is useless and is dropped)
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  sent_at     timestamptz,
  attempts    int not null default 0,
  last_error  text
);
create index if not exists push_outbox_pending_idx on public.push_outbox (id) where sent_at is null;
alter table public.push_outbox enable row level security;

-- ---- device registration (the rider app calls these; identity comes ONLY from auth.uid()) ---------------------------------------------
create or replace function public.register_push_device(p_token text, p_platform text default 'android', p_app_version text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  if not exists (select 1 from public.riders where id = v_uid) then return public._err('not_a_rider'); end if;
  p_token := btrim(coalesce(p_token, ''));
  if char_length(p_token) < 20 or char_length(p_token) > 4096 then return public._err('invalid_token'); end if;
  if p_platform is null or p_platform not in ('android','ios','web') then p_platform := 'android'; end if;
  -- the same phone token always belongs to whoever is signed in on it now (a shared phone changes hands)
  insert into public.push_devices (token, rider_id, platform, app_version) values (p_token, v_uid, p_platform, left(p_app_version, 40))
  on conflict (token) do update set rider_id = excluded.rider_id, platform = excluded.platform, app_version = excluded.app_version, updated_at = now();
  -- keep at most 5 phones per rider (newest win)
  delete from public.push_devices d where d.rider_id = v_uid and d.token in (
    select token from public.push_devices where rider_id = v_uid order by updated_at desc offset 5);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.unregister_push_device(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  delete from public.push_devices where token = btrim(coalesce(p_token, '')) and rider_id = v_uid;
  return jsonb_build_object('ok', true);
end $$;

-- ---- triggers: queue a push --------------------------------------------------------------------------------------------------------------
create or replace function public._push_on_offer() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'OFFERED' then
    insert into public.push_outbox (rider_id, kind, delivery_id, offer_id, expires_at) values (new.rider_id, 'OFFER', new.delivery_id, new.id, new.expires_at);
  end if;
  return new;
end $$;
drop trigger if exists delivery_offers_push on public.delivery_offers;
create trigger delivery_offers_push after insert on public.delivery_offers for each row execute function public._push_on_offer();

-- AUTO mode only: the rider did not press anything, so tell them. (In OFFER mode the rider accepted it themselves.)
create or replace function public._push_on_assign() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.rider_id is null and new.rider_id is not null and public.cfg('dispatch_mode', 'AUTO') <> 'OFFER' then
    insert into public.push_outbox (rider_id, kind, delivery_id) values (new.rider_id, 'ASSIGNED', new.id);
  end if;
  return new;
end $$;
drop trigger if exists deliveries_push_assign on public.deliveries;
create trigger deliveries_push_assign after update of rider_id on public.deliveries for each row execute function public._push_on_assign();

-- ---- the Hub worker's two calls (service key / postgres only) ------------------------------------------------------------------------
-- Claims up to p_limit pending pushes (skip locked: two Hub instances never send the same push), drops stale ones, and returns what to send.
create or replace function public.push_claim(p_limit int default 50) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare r record; v_out jsonb := '[]'::jsonb; v_tokens jsonb; v_item jsonb;
begin
  -- anything older than 2 minutes, or already tried 3 times, is no longer worth sending
  update public.push_outbox set sent_at = now(), last_error = coalesce(last_error, 'stale')
   where sent_at is null and (created_at < now() - interval '2 minutes' or attempts >= 3);
  for r in
    select o.* from public.push_outbox o
     where o.sent_at is null and (o.claimed_at is null or o.claimed_at < now() - interval '30 seconds')
     order by o.id limit greatest(1, least(p_limit, 200)) for update skip locked
  loop
    update public.push_outbox set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    select coalesce(jsonb_agg(token), '[]'::jsonb) into v_tokens from public.push_devices where rider_id = r.rider_id;
    if jsonb_array_length(v_tokens) = 0 then
      update public.push_outbox set sent_at = now(), last_error = 'no_device' where id = r.id; continue;
    end if;
    if r.kind = 'OFFER' then
      select jsonb_build_object('id', r.id, 'kind', 'OFFER', 'offerId', o.id, 'deliveryId', o.delivery_id, 'expiresAt', o.expires_at,
               'secondsLeft', greatest(0, round(extract(epoch from (o.expires_at - now()))::numeric, 0)),
               'pharmacyName', p.name, 'earnings', d.estimated_earnings, 'pickupKm', o.distance_km, 'tokens', v_tokens)
        into v_item
        from public.delivery_offers o
        join public.deliveries d on d.id = o.delivery_id and d.rider_id is null
        left join public.pharmacy_directory p on p.id = d.pharmacy_id
       where o.id = r.offer_id and o.status = 'OFFERED' and o.expires_at > now() + interval '2 seconds';
      if v_item is null then
        update public.push_outbox set sent_at = now(), last_error = 'offer_no_longer_live' where id = r.id; continue;
      end if;
    else
      select jsonb_build_object('id', r.id, 'kind', 'ASSIGNED', 'deliveryId', d.id, 'pharmacyName', p.name, 'earnings', d.estimated_earnings, 'tokens', v_tokens)
        into v_item
        from public.deliveries d left join public.pharmacy_directory p on p.id = d.pharmacy_id
       where d.id = r.delivery_id and d.rider_id = r.rider_id;
      if v_item is null then
        update public.push_outbox set sent_at = now(), last_error = 'no_longer_assigned' where id = r.id; continue;
      end if;
    end if;
    v_out := v_out || jsonb_build_array(v_item);
  end loop;
  return v_out;
end $$;

-- p_results: [{"id": 12, "ok": true|false, "error": "...", "deadTokens": ["..."], "okTokens": ["..."]}]
create or replace function public.push_report(p_results jsonb) returns int
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare e jsonb; n int := 0;
begin
  for e in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    if coalesce((e->>'ok')::boolean, false) then
      update public.push_outbox set sent_at = now(), last_error = null where id = (e->>'id')::bigint;
    else  -- leave unsent so push_claim retries it (up to 3 attempts, within 2 minutes)
      update public.push_outbox set last_error = left(coalesce(e->>'error', 'failed'), 300), claimed_at = null where id = (e->>'id')::bigint;
    end if;
    delete from public.push_devices where token in (select jsonb_array_elements_text(coalesce(e->'deadTokens', '[]'::jsonb)));
    update public.push_devices set last_success_at = now() where token in (select jsonb_array_elements_text(coalesce(e->'okTokens', '[]'::jsonb)));
    n := n + 1;
  end loop;
  -- housekeeping: keep a week of history
  delete from public.push_outbox where sent_at < now() - interval '7 days';
  return n;
end $$;

revoke all on public.push_devices, public.push_outbox from public, anon, authenticated;
revoke all on function public.push_claim(int), public.push_report(jsonb) from public, anon, authenticated;
revoke all on function public.register_push_device(text, text, text), public.unregister_push_device(text) from public, anon;
grant execute on function public.register_push_device(text, text, text), public.unregister_push_device(text) to authenticated;
