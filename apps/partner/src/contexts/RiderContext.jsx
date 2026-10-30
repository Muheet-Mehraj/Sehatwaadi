import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { RECONCILE_MS, STORAGE_KEYS, ALERT_SOUND_MS, OFFER_POLL_MS, KEEP_AWAKE_WHEN_ONLINE, APP_VERSION } from "../config.js";
import { push } from "../services/push.js";
import { errorText } from "../services/errors.js";
import { stepFromJob, paymentPlan, qrBelongsTo, isValidOtp } from "../services/deliveryMachine.js";
import { ringAlarm, notify, stopAlarm, askNotificationPermission } from "../services/alerts.js";
import { useLocationBroadcast } from "../hooks/useLocationBroadcast.js";
import { useWakeLock } from "../hooks/useWakeLock.js";
import { hapticSuccess, hapticError } from "../services/native.js";
import { isNative } from "../services/platform.js";
import { localDeadline, endedKind, remainingMs } from "../services/offers.js";

const Ctx = createContext(null);
export const useRider = () => useContext(Ctx);
const loadJob = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.activeJob) || "null"); } catch { return null; } };
const saveJob = (j) => { try { j ? localStorage.setItem(STORAGE_KEYS.activeJob, JSON.stringify(j)) : localStorage.removeItem(STORAGE_KEYS.activeJob); } catch { /* ignore */ } };

export function RiderProvider({ api, session, onSignOut, children, queue, geo }) {
  const uid = session?.user?.id;
  const [rider, setRider] = useState(undefined);       // undefined = loading, null = not registered
  const [job, setJob] = useState(loadJob);              // last known job (survives a reload while offline)
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newJob, setNewJob] = useState(false);
  const [result, setResult] = useState(null);          // summary of the delivery just completed
  const jobRef = useRef(job); jobRef.current = job;
  // ---- offers (dispatch_mode = OFFER). The server is the only authority: an order is ours only once accept_offer says ok. ----
  const [offer, setOffer] = useState(null);             // live offer: the server's fields + deadlineMs (a deadline on THIS phone's clock)
  const [offerEnded, setOfferEnded] = useState(null);   // "taken" | "expired" | null: why the offer on screen just went away
  const [offerBusy, setOfferBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const offerRef = useRef(null);
  const actingRef = useRef(false);                      // blocks a second tap immediately (React state updates are async)

  const handleAuth = useCallback((res) => { if (res?.error === "not_authenticated") onSignOut?.(); return res; }, [onSignOut]);

  const refreshRider = useCallback(async () => {
    const res = handleAuth(await api.getMyRider());
    if (res.ok) setRider(res.rider);
    return res;
  }, [api, handleAuth]);

  const refreshJob = useCallback(async () => {
    const res = handleAuth(await api.getActiveDelivery());
    if (!res.ok) { if (res.error === "network") setStale(true); return res; }
    setStale(false);
    const next = res.delivery || null;
    const prev = jobRef.current;
    if (next && (!prev || prev.order?.deliveryId !== next.order?.deliveryId)) { setNewJob(true); ringAlarm(ALERT_SOUND_MS); notify("New order assigned", `${next.order?.pharmacy?.name || "Pharmacy"} → ${next.order?.customer?.area || "customer"}`); }
    if (prev && !next) setNewJob(false);
    setJob(next); saveJob(next);
    return res;
  }, [api, handleAuth]);

  const refreshOffer = useCallback(async () => {
    if (!api.getMyOffer || actingRef.current) return null;          // older api object, or an accept/decline is in flight: leave the screen alone
    const t0 = Date.now();
    const res = handleAuth(await api.getMyOffer());
    if (actingRef.current || !res.ok) return res;                   // an action started meanwhile (its result wins) / no signal (the local countdown keeps running)
    const next = res.offer || null; const prev = offerRef.current;
    if (next) {
      const deadlineMs = localDeadline(t0, next.secondsLeft); const same = prev && prev.offerId === next.offerId;
      const merged = { ...next, deadlineMs: same ? Math.min(prev.deadlineMs, deadlineMs) : deadlineMs };   // never extend a deadline we already showed
      offerRef.current = merged; setOffer(merged);
      if (!same) { setOfferEnded(null); ringAlarm(ALERT_SOUND_MS); notify("New order offer", `${next.pharmacy?.name || "Pharmacy"} · ₹${Number(next.earnings || 0).toFixed(0)}`); }
    } else if (prev) { offerRef.current = null; setOffer(null); setOfferEnded(endedKind(prev)); stopAlarm(); }
    return res;
  }, [api, handleAuth]);

  // ---- push (FCM): register this phone once the rider is verified; a push (or a tap on it) just makes us ask the server right now ----
  const wakeRef = useRef(null);
  wakeRef.current = () => { refreshOffer(); refreshJob(); refreshRider(); };
  const pushEligible = !!uid && rider?.verificationStatus === "VERIFIED";
  useEffect(() => {
    if (!pushEligible || !api.registerPushDevice) return undefined;
    push.start({ onToken: (t) => { api.registerPushDevice(t, "android", APP_VERSION); }, onWake: () => wakeRef.current?.() });
    return () => { push.stop(); };
  }, [pushEligible, api]);
  // an offer that is gone (accepted, expired, taken) must not linger in the notification tray
  useEffect(() => { if (!offer) push.clearDelivered(); }, [offer]);

  // initial load + realtime + reconcile
  useEffect(() => { if (uid) { refreshRider(); refreshJob(); askNotificationPermission(); } }, [uid, refreshRider, refreshJob]);
  useEffect(() => {
    if (!uid) return undefined;
    let t; const kick = () => { clearTimeout(t); t = setTimeout(() => { refreshJob(); refreshRider(); }, 250); };
    const off = api.subscribeDeliveries(uid, { onChange: kick });
    return () => { clearTimeout(t); off(); };
  }, [uid, api, refreshJob, refreshRider]);
  const wantsOffers = !!uid && rider?.status === "ONLINE" && rider?.verificationStatus === "VERIFIED" && !job;
  useEffect(() => {
    if (!wantsOffers) { if (offerRef.current && !actingRef.current) { offerRef.current = null; setOffer(null); } return undefined; }
    refreshOffer();
    const i = setInterval(refreshOffer, OFFER_POLL_MS);
    const onVis = () => { if (document.visibilityState === "visible") refreshOffer(); };   // back from another app / late notification: ask now
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(i); document.removeEventListener("visibilitychange", onVis); };
  }, [wantsOffers, refreshOffer]);
  useEffect(() => {
    if (!wantsOffers || !api.subscribeOffers) return undefined;
    let t; const off = api.subscribeOffers(uid, { onChange: () => { clearTimeout(t); t = setTimeout(refreshOffer, 150); } });
    return () => { clearTimeout(t); off?.(); };
  }, [wantsOffers, uid, api, refreshOffer]);
  const working = rider?.status === "ONLINE" || rider?.status === "ON_DELIVERY" || !!job;
  useEffect(() => {
    if (!uid || !working) return undefined;
    const i = setInterval(() => { refreshJob(); refreshRider(); }, RECONCILE_MS);
    return () => clearInterval(i);
  }, [uid, working, refreshJob, refreshRider]);

  useWakeLock(KEEP_AWAKE_WHEN_ONLINE ? working : (isNative() ? !!job : working));
  const loc = useLocationBroadcast({ api, enabled: !!uid && rider?.verificationStatus === "VERIFIED" && working, active: !!job, queue, geo,
    onAssigned: () => { refreshJob(); refreshRider(); } });
  const kickRef = useRef(null); kickRef.current = loc.kickstart;

  // Going online (or opening the app while already online) pushes a position at once, so a waiting order is assigned immediately.
  const kicked = useRef(false);
  useEffect(() => {
    if (rider?.status === "ONLINE" && rider?.verificationStatus === "VERIFIED") { if (!kicked.current) { kicked.current = true; kickRef.current?.(); } }
    else if (rider) kicked.current = false;
  }, [rider?.status, rider?.verificationStatus, rider]);

  // every action: one place for busy/error/refresh handling
  const act = useCallback(async (fn, { refresh = true } = {}) => {
    setBusy(true); setError("");
    try {
      const res = handleAuth(await fn());
      if (!res.ok) { hapticError(); setError(errorText(res)); if (res.error === "invalid_state" || res.error === "not_authorized" || res.error === "cancel_after_pickup") await refreshJob(); }
      else if (refresh) await Promise.all([refreshJob(), refreshRider()]);
      return res;
    } finally { setBusy(false); }
  }, [handleAuth, refreshJob, refreshRider]);

  const order = job?.order || null;
  const deliveryId = order?.deliveryId;
  const actions = useMemo(() => ({
    register: (p) => act(() => api.registerRider(p)),
    setOnline: async (on) => {
      if (on) kicked.current = true;   // the explicit kick below replaces the effect's
      const res = await act(() => api.setStatus(on ? "ONLINE" : "OFFLINE"));
      if (on && res.ok) { kickRef.current?.().then(() => { refreshJob(); refreshRider(); }).catch(() => {}); } else if (on) kicked.current = false;
      return res;
    },
    arrivedAtPharmacy: () => act(() => api.markArrived(deliveryId, "pharmacy")),
    scanPickup: (qr) => qrBelongsTo(qr, deliveryId) ? act(() => api.confirmPickup(deliveryId, "QR", String(qr).trim())) : (setError("That QR is for a different order."), Promise.resolve({ ok: false, error: "qr_mismatch" })),
    arrivedAtCustomer: () => act(() => api.markArrived(deliveryId, "customer")),
    completeDelivery: async ({ otp, proofBlob }) => {
      if (!isValidOtp(otp)) { setError("Enter the customer's 4-digit code."); return { ok: false, error: "invalid_otp" }; }
      const plan = paymentPlan(order);
      let proofPath = null;
      if (proofBlob) {
        const up = await api.uploadProof(deliveryId, proofBlob);
        if (!up.ok) { setError(errorText(up) + " The photo wasn't uploaded."); return up; }
        proofPath = up.path;
      }
      const res = await act(() => api.completeDelivery(deliveryId, { otp, paymentMode: plan.mode, proofPath }));
      if (res.ok) { hapticSuccess(); setResult({ earnings: res.earnings, paymentMode: res.paymentMode, cashInHand: res.cashInHand, at: Date.now() }); setNewJob(false); }
      return res;
    },
    reportIssue: (type, notes) => act(() => api.reportIssue(deliveryId, type, notes), { refresh: false }),
    confirmReturn: (qr) => qrBelongsTo(qr, deliveryId) ? act(() => api.confirmReturn(deliveryId, String(qr).trim())) : (setError("That QR is for a different order."), Promise.resolve({ ok: false, error: "qr_mismatch" })),
    settle: (amount, ref) => act(() => api.settleCash(amount, ref)),
    acceptOffer: async () => {
      const o = offerRef.current;
      if (!o || actingRef.current) return { ok: false, error: "busy" };
      if (remainingMs(o.deadlineMs) <= 0) return { ok: false, error: "offer_expired" };
      actingRef.current = true; setOfferBusy(true); setError("");
      try {
        const res = handleAuth(await api.acceptOffer(o.offerId));
        if (res.ok) {                                                // the SERVER confirmed: only now does the order become ours
          offerRef.current = null; setOffer(null); setOfferEnded(null); stopAlarm(); hapticSuccess();
          if (res.delivery) { jobRef.current = res.delivery; setJob(res.delivery); saveJob(res.delivery); }   // set the ref first so the refresh below doesn't re-fire the "new order" alarm
          await Promise.all([refreshJob(), refreshRider()]);
          return res;
        }
        if (res.error === "network") { setError(errorText(res)); return res; }   // not sent / no answer: the offer stays so they can retry while it is still live
        offerRef.current = null; setOffer(null); stopAlarm(); hapticError();
        if (res.error === "offer_taken") setOfferEnded("taken");
        else if (["offer_expired", "offer_closed", "offer_not_found"].includes(res.error)) setOfferEnded("expired");
        else setError(errorText(res));
        refreshRider();
        return res;
      } finally { actingRef.current = false; setOfferBusy(false); }
    },
    declineOffer: async () => {
      const o = offerRef.current;
      if (!o || actingRef.current) return { ok: false, error: "busy" };
      actingRef.current = true; setOfferBusy(true);
      offerRef.current = null; setOffer(null); setOfferEnded(null); stopAlarm();   // hide at once; telling the server is best-effort (an unsent decline just lapses)
      try { return handleAuth(await api.declineOffer(o.offerId)); } finally { actingRef.current = false; setOfferBusy(false); }
    },
    offerLapsed: () => { if (!offerRef.current || actingRef.current) return; offerRef.current = null; setOffer(null); setOfferEnded("expired"); stopAlarm(); refreshOffer(); },
    dismissOfferEnded: () => setOfferEnded(null),
    cancelDelivery: async (reason, notes) => {
      const res = await act(() => api.cancelDelivery(deliveryId, reason, notes));
      if (res.ok) setNotice("Order cancelled. It will be offered to another rider.");
      return res;
    },
    clearNotice: () => setNotice(""),
    dismissNewJob: () => { setNewJob(false); stopAlarm(); }, dismissResult: () => setResult(null), clearError: () => setError(""),
  }), [act, api, deliveryId, order, refreshJob, refreshRider, refreshOffer, handleAuth]);

  const value = { api, rider, job, order, step: stepFromJob(job), plan: order ? paymentPlan(order) : null, stale, busy, error, newJob, result, loc, actions, refreshRider, refreshJob,
    offer, offerEnded, offerBusy, notice, refreshOffer };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
