-- =====================================================================================
-- SehatWaadi delivery network -- 3/4: private bucket for proof-of-delivery photos
-- =====================================================================================
-- Path convention: <delivery_id>/<anything>.jpg
--   upload : only the rider ASSIGNED to that delivery, and only while it is PICKED_UP
--   read   : the assigned rider and that pharmacy's staff
--   no update / delete through the API (a proof can't be swapped after the fact)
-- =====================================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('delivery-proofs', 'delivery-proofs', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public._proof_delivery_id(p_name text) returns uuid
language plpgsql immutable as $$
begin return ((storage.foldername(p_name))[1])::uuid;
exception when others then return null; end $$;
revoke all on function public._proof_delivery_id(text) from public, anon;
grant execute on function public._proof_delivery_id(text) to authenticated;

drop policy if exists proofs_rider_upload on storage.objects;
create policy proofs_rider_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'delivery-proofs' and exists (
    select 1 from public.deliveries d where d.id = public._proof_delivery_id(name)
       and d.rider_id = (select auth.uid()) and d.status = 'PICKED_UP'));

drop policy if exists proofs_read on storage.objects;
create policy proofs_read on storage.objects for select to authenticated
  using (bucket_id = 'delivery-proofs' and exists (
    select 1 from public.deliveries d where d.id = public._proof_delivery_id(name)
       and (d.rider_id = (select auth.uid()) or public.is_pharmacy_member(d.pharmacy_id))));
