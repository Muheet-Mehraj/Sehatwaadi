-- Removes rider KYC (all submitted documents are DELETED). Riders keep their current verification_status.
drop function if exists public.kyc_upload_doc(text, text, text), public.kyc_submit(text, text, text, text, text), public.get_my_kyc(),
  public.admin_kyc_list(text), public.admin_kyc_get(uuid), public.admin_kyc_decide(uuid, text, text[], text, text),
  public.admin_kyc_suspend(uuid, text, text), public.admin_kyc_reinstate(uuid, text), public._kyc_required(text), public._kyc_clean_dl(text), public._kyc_mask(text, int);
drop table if exists public.rider_kyc_docs, public.rider_kyc;
