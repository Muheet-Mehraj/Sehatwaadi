-- Rider KYC. Additive; safe to re-run.
-- A rider submits: selfie, Aadhaar (front+back), PAN, driving licence (not for bicycles) + the numbers on them.
-- The operator reviews the pictures and approves or rejects (with a reason, and which pictures to retake).
-- ONLY an approval sets riders.verification_status = 'VERIFIED' -- the flag that already gates going online and receiving offers.
-- Privacy: the full Aadhaar number is NEVER stored (only the last 4 digits; the card photo is what the operator checks).
-- Pictures live in a table no app role can read; they are served to the operator only, by the Hub, behind the admin token.
do $$ begin
  if to_regclass('public.riders') is null then raise exception 'rider_kyc: run the rider_delivery migrations first'; end if;
end $$;

insert into public.delivery_config (key, value, description) values
  ('kyc_required', 'true', 'A new rider can only be made VERIFIED after the operator approves their documents (the old "verify without documents" shortcut is refused). Set to false to allow it.')
on conflict (key) do nothing;

create table if not exists public.rider_kyc (
  rider_id       uuid primary key references public.riders(id) on delete cascade,
  status         text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','APPROVED','REJECTED')),
  date_of_birth  date,
  aadhaar_last4  text check (aadhaar_last4 is null or aadhaar_last4 ~ '^[0-9]{4}$'),
  pan_number     text check (pan_number is null or pan_number ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  dl_number      text check (dl_number is null or dl_number ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{9,13}$'),
  dl_expiry      date,
  reject_reason  text,
  submitted_at   timestamptz, reviewed_at timestamptz, reviewed_by text,
  created_at     timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists rider_kyc_pan_uniq on public.rider_kyc (pan_number) where pan_number is not null;   -- one PAN, one rider
create unique index if not exists rider_kyc_dl_uniq  on public.rider_kyc (dl_number)  where dl_number is not null;
create index if not exists rider_kyc_queue_idx on public.rider_kyc (submitted_at) where status = 'SUBMITTED';
drop trigger if exists rider_kyc_touch on public.rider_kyc;
create trigger rider_kyc_touch before update on public.rider_kyc for each row execute function public.touch_updated_at();

create table if not exists public.rider_kyc_docs (
  rider_id     uuid not null references public.riders(id) on delete cascade,
  kind         text not null check (kind in ('SELFIE','AADHAAR_FRONT','AADHAAR_BACK','PAN','DL_FRONT')),
  content_type text not null check (content_type in ('image/jpeg','image/png','image/webp')),
  bytes        bytea not null check (octet_length(bytes) between 1 and 204800),
  sha256       text not null,
  status       text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED')),
  note         text,
  uploaded_at  timestamptz not null default now(),
  primary key (rider_id, kind)
);
alter table public.rider_kyc enable row level security;         -- deliberately no policy: only the functions below touch these
alter table public.rider_kyc_docs enable row level security;
revoke all on public.rider_kyc, public.rider_kyc_docs from public, anon, authenticated;

create or replace function public._kyc_required(p_vehicle text) returns text[] language sql immutable as $$
  select case when p_vehicle = 'BICYCLE' then array['SELFIE','AADHAAR_FRONT','AADHAAR_BACK','PAN']
              else array['SELFIE','AADHAAR_FRONT','AADHAAR_BACK','PAN','DL_FRONT'] end $$;

create or replace function public._kyc_clean_dl(p text) returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) $$;

-- ---- rider: upload one picture (base64 of a JPEG/PNG/WebP, <= 200 KB; the app shrinks the photo first) ----------------------------------
create or replace function public.kyc_upload_doc(p_kind text, p_content_type text, p_data text) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid()); r public.riders; k public.rider_kyc; v_bytes bytea; v_head text; v_type text;
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  select * into r from public.riders where id = v_uid;
  if not found then return public._err('not_a_rider'); end if;
  if p_kind is null or not (p_kind = any (public._kyc_required(r.vehicle_type))) then return public._err('invalid_document'); end if;
  insert into public.rider_kyc (rider_id) values (v_uid) on conflict do nothing;
  select * into k from public.rider_kyc where rider_id = v_uid for update;
  if k.status in ('SUBMITTED','APPROVED') then return public._err('kyc_locked'); end if;
  begin v_bytes := decode(regexp_replace(coalesce(p_data, ''), '[[:space:]]', '', 'g'), 'base64');
  exception when others then return public._err('invalid_image'); end;
  if v_bytes is null or octet_length(v_bytes) = 0 then return public._err('invalid_image'); end if;
  if octet_length(v_bytes) > 204800 then return public._err('image_too_large'); end if;
  v_head := encode(substring(v_bytes from 1 for 12), 'hex');                 -- trust the bytes, not the label the app sent
  v_type := case when v_head like 'ffd8ff%' then 'image/jpeg' when v_head like '89504e470d0a1a0a%' then 'image/png'
                 when v_head like '52494646________57454250' then 'image/webp' end;
  if v_type is null then return public._err('invalid_image'); end if;
  insert into public.rider_kyc_docs (rider_id, kind, content_type, bytes, sha256, status, note)
  values (v_uid, p_kind, v_type, v_bytes, encode(extensions.digest(v_bytes, 'sha256'), 'hex'), 'PENDING', null)
  on conflict (rider_id, kind) do update set content_type = excluded.content_type, bytes = excluded.bytes, sha256 = excluded.sha256,
        status = 'PENDING', note = null, uploaded_at = now();
  return jsonb_build_object('ok', true, 'kind', p_kind);
end $$;

-- ---- rider: the details written on the documents, then send everything for review -------------------------------------------------------
create or replace function public.kyc_submit(p_dob text, p_aadhaar_last4 text, p_pan text, p_dl_number text default null, p_dl_expiry text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid := (select auth.uid()); r public.riders; k public.rider_kyc;
        v_dob date; v_exp date; v_pan text := upper(btrim(coalesce(p_pan, ''))); v_dl text := public._kyc_clean_dl(p_dl_number); v_need text[]; v_have text[];
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  select * into r from public.riders where id = v_uid;
  if not found then return public._err('not_a_rider'); end if;
  insert into public.rider_kyc (rider_id) values (v_uid) on conflict do nothing;
  select * into k from public.rider_kyc where rider_id = v_uid for update;
  if k.status in ('SUBMITTED','APPROVED') then return public._err('kyc_locked'); end if;

  begin v_dob := p_dob::date; exception when others then return public._err('invalid_dob'); end;
  if v_dob is null or v_dob > (current_date - interval '18 years')::date or v_dob < (current_date - interval '70 years')::date then return public._err('invalid_dob'); end if;
  if p_aadhaar_last4 is null or p_aadhaar_last4 !~ '^[0-9]{4}$' then return public._err('invalid_aadhaar'); end if;
  if v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' or substr(v_pan, 4, 1) <> 'P' then return public._err('invalid_pan'); end if;   -- 4th letter P = an individual
  if r.vehicle_type <> 'BICYCLE' then
    if v_dl !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{9,13}$' then return public._err('invalid_dl'); end if;
    begin v_exp := p_dl_expiry::date; exception when others then return public._err('invalid_dl_expiry'); end;
    if v_exp is null or v_exp <= current_date then return public._err('dl_expired'); end if;
  else v_dl := null; v_exp := null; end if;

  v_need := public._kyc_required(r.vehicle_type);
  select coalesce(array_agg(kind), '{}') into v_have from public.rider_kyc_docs where rider_id = v_uid and status <> 'REJECTED';
  if not (v_need <@ v_have) then
    return public._err('documents_missing', jsonb_build_object('missing', (select coalesce(jsonb_agg(x), '[]') from unnest(v_need) x where not (x = any (v_have)))));
  end if;
  begin
    update public.rider_kyc set status = 'SUBMITTED', date_of_birth = v_dob, aadhaar_last4 = p_aadhaar_last4, pan_number = v_pan, dl_number = v_dl, dl_expiry = v_exp,
           reject_reason = null, submitted_at = now(), reviewed_at = null, reviewed_by = null where rider_id = v_uid;
  exception when unique_violation then
    return public._err(case when exists (select 1 from public.rider_kyc where pan_number = v_pan and rider_id <> v_uid) then 'pan_in_use' else 'dl_in_use' end);
  end;
  return jsonb_build_object('ok', true, 'status', 'SUBMITTED');
end $$;

create or replace function public._kyc_mask(p text, p_keep int) returns text language sql immutable as $$
  select case when p is null then null else repeat('•', greatest(char_length(p) - p_keep, 0)) || right(p, p_keep) end $$;

create or replace function public.get_my_kyc() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_uid uuid := (select auth.uid()); r public.riders; k public.rider_kyc; v_docs jsonb;
begin
  if v_uid is null then return public._err('not_authenticated'); end if;
  select * into r from public.riders where id = v_uid;
  if not found then return jsonb_build_object('ok', true, 'kyc', null); end if;
  select * into k from public.rider_kyc where rider_id = v_uid;
  select coalesce(jsonb_object_agg(d.kind, jsonb_build_object('status', d.status, 'note', d.note, 'uploadedAt', d.uploaded_at)), '{}') into v_docs
    from public.rider_kyc_docs d where d.rider_id = v_uid;
  return jsonb_build_object('ok', true, 'kyc', jsonb_build_object(
    'status', coalesce(k.status, 'DRAFT'), 'verificationStatus', r.verification_status,
    'required', to_jsonb(public._kyc_required(r.vehicle_type)), 'docs', v_docs, 'rejectReason', k.reject_reason,
    'canEdit', coalesce(k.status, 'DRAFT') in ('DRAFT','REJECTED') and r.verification_status <> 'SUSPENDED',
    'dob', k.date_of_birth, 'aadhaarMasked', case when k.aadhaar_last4 is null then null else 'XXXX XXXX ' || k.aadhaar_last4 end, 'aadhaarLast4', k.aadhaar_last4,
    'pan', k.pan_number, 'dlNumber', k.dl_number, 'dlExpiry', k.dl_expiry, 'submittedAt', k.submitted_at, 'reviewedAt', k.reviewed_at));
end $$;

-- ---- operator (service role only) ---------------------------------------------------------------------------------------------------------------
create or replace function public.admin_kyc_list(p_status text default 'SUBMITTED') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  return jsonb_build_object('ok', true, 'items', coalesce((select jsonb_agg(jsonb_build_object(
      'riderId', r.id, 'name', r.full_name, 'phone', r.phone, 'vehicleType', r.vehicle_type, 'vehicleNumber', r.vehicle_number,
      'status', k.status, 'verificationStatus', r.verification_status, 'submittedAt', k.submitted_at) order by k.submitted_at nulls last)
    from public.rider_kyc k join public.riders r on r.id = k.rider_id where k.status = coalesce(p_status, 'SUBMITTED')), '[]'));
end $$;

create or replace function public.admin_kyc_get(p_rider uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r public.riders; k public.rider_kyc;
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  select * into r from public.riders where id = p_rider; if not found then return public._err('not_found'); end if;
  select * into k from public.rider_kyc where rider_id = p_rider; if not found then return public._err('not_found'); end if;
  return jsonb_build_object('ok', true, 'rider', jsonb_build_object('id', r.id, 'name', r.full_name, 'phone', r.phone, 'vehicleType', r.vehicle_type,
      'vehicleNumber', r.vehicle_number, 'verificationStatus', r.verification_status),
    'kyc', jsonb_build_object('status', k.status, 'dob', k.date_of_birth, 'aadhaarLast4', k.aadhaar_last4, 'pan', k.pan_number, 'dlNumber', k.dl_number,
      'dlExpiry', k.dl_expiry, 'rejectReason', k.reject_reason, 'submittedAt', k.submitted_at, 'reviewedAt', k.reviewed_at, 'reviewedBy', k.reviewed_by),
    'docs', (select coalesce(jsonb_agg(jsonb_build_object('kind', d.kind, 'status', d.status, 'note', d.note, 'contentType', d.content_type,
              'size', octet_length(d.bytes), 'uploadedAt', d.uploaded_at) order by d.kind), '[]') from public.rider_kyc_docs d where d.rider_id = p_rider));
end $$;

-- APPROVE: every document is marked good and the rider becomes VERIFIED.  REJECT: a reason is required; the pictures named in p_retake must be taken again.
create or replace function public.admin_kyc_decide(p_rider uuid, p_decision text, p_retake text[] default '{}', p_reason text default null, p_by text default 'operator') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.riders; k public.rider_kyc; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_retake text[] := coalesce(p_retake, '{}');
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  select * into r from public.riders where id = p_rider for update; if not found then return public._err('not_found'); end if;
  select * into k from public.rider_kyc where rider_id = p_rider for update; if not found then return public._err('not_found'); end if;
  if k.status <> 'SUBMITTED' then return public._err('invalid_state'); end if;
  if p_decision = 'APPROVE' then
    if r.verification_status = 'SUSPENDED' then return public._err('rider_suspended'); end if;       -- an approval never silently lifts a suspension
    if k.dl_expiry is not null and k.dl_expiry <= current_date then return public._err('dl_expired'); end if;
    update public.rider_kyc_docs set status = 'APPROVED', note = null where rider_id = p_rider;
    update public.rider_kyc set status = 'APPROVED', reject_reason = null, reviewed_at = now(), reviewed_by = p_by where rider_id = p_rider;
    update public.riders set verification_status = 'VERIFIED', verified_at = now(), verified_by = p_by where id = p_rider;
    return jsonb_build_object('ok', true, 'status', 'APPROVED');
  elsif p_decision = 'REJECT' then
    if v_reason is null or char_length(v_reason) < 3 then return public._err('reason_required'); end if;
    if exists (select 1 from unnest(v_retake) x where x not in ('SELFIE','AADHAAR_FRONT','AADHAAR_BACK','PAN','DL_FRONT')) then return public._err('invalid_document'); end if;
    update public.rider_kyc_docs set status = 'REJECTED', note = v_reason where rider_id = p_rider and kind = any (v_retake);
    update public.rider_kyc_docs set status = 'PENDING' where rider_id = p_rider and not (kind = any (v_retake));
    update public.rider_kyc set status = 'REJECTED', reject_reason = v_reason, reviewed_at = now(), reviewed_by = p_by where rider_id = p_rider;
    return jsonb_build_object('ok', true, 'status', 'REJECTED');
  end if;
  return public._err('invalid_decision');
end $$;

-- Take a rider off the road (expired licence, a complaint...). They go offline, lose any live offer and can't come back until re-approved.
create or replace function public.admin_kyc_suspend(p_rider uuid, p_reason text, p_by text default 'operator') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.riders;
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then return public._err('reason_required'); end if;
  select * into r from public.riders where id = p_rider for update; if not found then return public._err('not_found'); end if;
  update public.riders set verification_status = 'SUSPENDED', status = case when status = 'ON_DELIVERY' then status else 'OFFLINE' end where id = p_rider;
  update public.delivery_offers set status = 'WITHDRAWN', responded_at = now() where rider_id = p_rider and status = 'OFFERED';
  update public.rider_kyc set status = 'REJECTED', reject_reason = btrim(p_reason), reviewed_at = now(), reviewed_by = p_by where rider_id = p_rider;
  return jsonb_build_object('ok', true, 'onDelivery', r.status = 'ON_DELIVERY');
end $$;
-- and lifting it again (only for a rider whose KYC has since been re-approved is automatic; this is the manual override)
create or replace function public.admin_kyc_reinstate(p_rider uuid, p_by text default 'operator') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_service_role() then return public._err('not_authorized'); end if;
  update public.riders set verification_status = 'VERIFIED', verified_at = now(), verified_by = p_by where id = p_rider and verification_status = 'SUSPENDED';
  if not found then return public._err('invalid_state'); end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.kyc_upload_doc(text, text, text), public.kyc_submit(text, text, text, text, text), public.get_my_kyc() from public, anon;
grant execute on function public.kyc_upload_doc(text, text, text), public.kyc_submit(text, text, text, text, text), public.get_my_kyc() to authenticated;
revoke all on function public.admin_kyc_list(text), public.admin_kyc_get(uuid), public.admin_kyc_decide(uuid, text, text[], text, text),
  public.admin_kyc_suspend(uuid, text, text), public.admin_kyc_reinstate(uuid, text), public._kyc_required(text), public._kyc_clean_dl(text), public._kyc_mask(text, int)
  from public, anon, authenticated;
grant execute on function public.admin_kyc_list(text), public.admin_kyc_get(uuid), public.admin_kyc_decide(uuid, text, text[], text, text),
  public.admin_kyc_suspend(uuid, text, text), public.admin_kyc_reinstate(uuid, text) to service_role;
