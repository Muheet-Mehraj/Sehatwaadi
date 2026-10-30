// All backend access for the rider app goes through here: Supabase Auth (phone OTP), RPC calls (the ONLY way to change anything),
// Realtime (deliveries addressed to this rider), Storage (proof-of-delivery photos). The Supabase client is injectable so the
// whole API layer is tested against a real Postgres (test/e2e.mjs).
//
// Every RPC resolves to { ok: true, ... } or { ok: false, error: '<code>' }:
//   server codes   invalid_otp, otp_locked, qr_mismatch, payment_mismatch, not_verified, invalid_state, ... (see supabase/migrations)
//   client codes   network (offline / timeout), not_authenticated (session expired), forbidden, server (unexpected)
import { createClient } from "@supabase/supabase-js";
import { CapacitorHttp } from "@capacitor/core";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../config.js";
import { isNative } from "./platform.js";
import { createNativeFetch } from "./nativeFetch.js";

export function createSupabase() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) { const e = new Error("Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY"); e.code = "not_configured"; throw e; }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 5 } },
    // Android app only: native networking keeps location pushes alive in the background (see nativeFetch.js).
    ...(isNative() ? { global: { fetch: createNativeFetch({ http: CapacitorHttp }) } } : {}),
  });
}

const NETWORK_RE = /fetch|network|timeout|timed out|failed to|ECONN|ENOTFOUND|offline/i;
export const classify = (err) => {
  const msg = String(err?.message || err || "");
  if (err?.code === "PGRST301" || /jwt (is )?(expired|invalid)|JWT/i.test(msg) || err?.status === 401) return { ok: false, error: "not_authenticated" };
  if (NETWORK_RE.test(msg)) return { ok: false, error: "network", message: msg };
  if (err?.code === "42501") return { ok: false, error: "forbidden", message: msg };
  return { ok: false, error: "server", message: msg };
};

async function rpc(sb, fn, args = {}) {
  try {
    const { data, error } = await sb.rpc(fn, args);
    if (error) return classify(error);
    if (data && typeof data === "object" && "ok" in data) return data;
    return { ok: true, data };
  } catch (e) { return classify(e); }
}

// "98765 43210" / "+91 98765 43210" / "919876543210" -> "+919876543210" (10-digit numbers are Indian)
export function toE164(phone) {
  const d = String(phone || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  const digits = d.replace(/\D/g, "");
  if (digits.length === 10) return "+91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return "+" + digits;
  return "+" + digits;
}

export function createRiderApi(sb) {
  const call = (fn, args) => rpc(sb, fn, args);
  const authCall = async (fn) => {
    try {
      const { data, error } = await fn();
      if (error) return { ok: false, error: /rate|too many/i.test(error.message) ? "rate_limited" : /invalid|expired|token/i.test(error.message) ? "invalid_code" : classify(error).error, message: error.message };
      return { ok: true, data };
    } catch (e) { return classify(e); }
  };
  const read = async (query) => { try { const { data, error } = await query; return error ? classify(error) : { ok: true, rows: data || [] }; } catch (e) { return classify(e); } };

  return {
    // ---- auth (Supabase phone OTP: needs an SMS provider configured in the project) ----
    getSession: async () => { try { return (await sb.auth.getSession()).data.session; } catch { return null; } },
    onAuthChange: (cb) => { const { data } = sb.auth.onAuthStateChange((event, session) => cb(session, event)); return () => data.subscription.unsubscribe(); },
    signInWithPhone: (phone) => authCall(() => sb.auth.signInWithOtp({ phone: toE164(phone) })),
    verifyPhoneOtp: (phone, token) => authCall(() => sb.auth.verifyOtp({ phone: toE164(phone), token: String(token).trim(), type: "sms" })),
    signOut: async () => { try { await sb.auth.signOut(); } catch { /* ignore */ } },

    // ---- rider account & wallet ----
    getMyRider: () => call("get_my_rider"),
    registerRider: ({ fullName, vehicleType, vehicleNumber }) => call("register_rider", { p_full_name: fullName, p_vehicle_type: vehicleType, p_vehicle_number: vehicleNumber || null }),
    setStatus: (status) => call("set_rider_status", { p_status: status }),
    pushLocations: (points) => call("push_locations", { p_points: points }),

    // ---- push notifications (FCM device token for this rider's phone) ----
    registerPushDevice: (token, platform = "android", appVersion = null) => call("register_push_device", { p_token: token, p_platform: platform, p_app_version: appVersion }),
    unregisterPushDevice: (token) => call("unregister_push_device", { p_token: token }),
    getMyEarnings: () => call("get_my_earnings"),
    getMyKyc: () => call("get_my_kyc"),
    kycUploadDoc: (kind, base64) => call("kyc_upload_doc", { p_kind: kind, p_content_type: "image/jpeg", p_data: base64 }),
    kycSubmit: (d) => call("kyc_submit", { p_dob: d.dob, p_aadhaar_last4: d.aadhaarLast4, p_pan: d.pan, p_dl_number: d.dlNumber || null, p_dl_expiry: d.dlExpiry || null }),

    // ---- offers (only when the server runs dispatch_mode = OFFER; in AUTO mode get_my_offer just returns offer: null) ----
    getMyOffer: () => call("get_my_offer"),
    acceptOffer: (offerId) => call("accept_offer", { p_offer_id: offerId }),
    declineOffer: (offerId) => call("decline_offer", { p_offer_id: offerId }),

    // ---- the job (cancelling is allowed BEFORE pickup only; after pickup use reportIssue) ----
    cancelDelivery: (deliveryId, reason, notes) => call("rider_cancel_delivery", { p_delivery_id: deliveryId, p_reason: reason, p_notes: notes || null }),
    getActiveDelivery: () => call("get_active_delivery"),
    markArrived: (deliveryId, at) => call("mark_arrived", { p_delivery_id: deliveryId, p_at: at }),
    confirmPickup: (deliveryId, method, qr) => call("confirm_pickup", { p_delivery_id: deliveryId, p_method: method, p_qr: qr ?? null }),
    completeDelivery: (deliveryId, { otp, paymentMode, proofPath }) => call("complete_delivery", { p_delivery_id: deliveryId, p_otp: otp, p_payment_mode: paymentMode ?? null, p_proof_path: proofPath ?? null }),
    reportIssue: (deliveryId, type, notes) => call("report_delivery_issue", { p_delivery_id: deliveryId, p_issue_type: type, p_notes: notes || null }),
    confirmReturn: (deliveryId, qr) => call("confirm_return", { p_delivery_id: deliveryId, p_qr: qr }),
    settleCash: (amount, upiRef) => call("settle_rider_cash", { p_amount: amount, p_upi_ref: upiRef }),

    // ---- proof-of-delivery photo (private bucket; path must start with the delivery id) ----
    uploadProof: async (deliveryId, blob) => {
      try {
        const path = `${deliveryId}/${Date.now()}.jpg`;
        const { error } = await sb.storage.from("delivery-proofs").upload(path, blob, { contentType: "image/jpeg", upsert: false });
        return error ? classify(error) : { ok: true, path };
      } catch (e) { return classify(e); }
    },

    // ---- history (RLS: only this rider's own rows) ----
    getRecentDeliveries: (limit = 30) => read(sb.from("deliveries").select("id,status,delivered_at,returned_at,estimated_earnings,payment_mode,order_subtotal,amount_collected").in("status", ["DELIVERED", "RETURNED"]).order("created_at", { ascending: false }).limit(limit)),
    getLedger: (limit = 30) => read(sb.from("rider_ledger").select("id,entry_type,amount,cash_in_hand_after,earnings_balance_after,note,created_at").order("created_at", { ascending: false }).limit(limit)),

    // ---- realtime: wakes the app when an offer is created for / changed for this rider (the row itself carries nothing sensitive; the app then calls getMyOffer) ----
    subscribeOffers: (userId, { onChange, onStatus } = {}) => {
      const channel = sb.channel(`rider-offers-${userId}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "delivery_offers", filter: `rider_id=eq.${userId}` }, (p) => onChange?.(p))
        .subscribe((s) => onStatus?.(s));
      return () => { try { sb.removeChannel(channel); } catch { /* ignore */ } };
    },

    // ---- realtime: rows of public.deliveries addressed to this rider ----
    subscribeDeliveries: (userId, { onChange, onStatus } = {}) => {
      const channel = sb.channel(`rider-deliveries-${userId}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "deliveries", filter: `rider_id=eq.${userId}` }, (p) => onChange?.(p))
        .subscribe((s) => onStatus?.(s));
      return () => { try { sb.removeChannel(channel); } catch { /* ignore */ } };
    },
  };
}
