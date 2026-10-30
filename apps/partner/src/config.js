// Tunables. Nothing secret lives in the bundle: the anon key is public by design; what a rider may do is decided by
// row-level security and the server-side functions.
export const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || "";
export const SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY || "";
export const SETTLEMENT_UPI_ID = import.meta.env?.VITE_SETTLEMENT_UPI_ID || "";
export const APP_VERSION = "0.4.1";
export const ACTIVE_SAMPLE_MS = 5000;     // GPS sample cadence on a delivery
export const IDLE_SAMPLE_MS = 15000;      // ...while online and waiting (server treats > 3 min of silence as offline)
export const RECONCILE_MS = 15000;        // re-ask the server what our job is (catches reassignment, UPI confirmation)
export const OFFER_POLL_MS = 4000;       // while online and waiting: ask the server for an offer this often (Realtime wakes us sooner; the poll covers a dropped socket)
export const KEEP_AWAKE_WHEN_ONLINE = true;   // phone is typically mounted on the scooter: keep the screen on the whole time the rider is online so an offer is seen inside its window
export const OTP_LENGTH = 4;
export const ALERT_SOUND_MS = 6000;
export const STORAGE_KEYS = { theme: "swr.theme", activeJob: "swr.activeJob", lastFix: "swr.lastFix", queueFallback: "swr.locationQueue" };
