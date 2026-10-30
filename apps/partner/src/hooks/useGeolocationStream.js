import { useEffect, useRef, useState } from "react";
import { STORAGE_KEYS } from "../config.js";

// Continuous GPS tuned for weak cellular/GPS conditions:
//  - high-accuracy first; if the OS can't produce a fix in time it drops to a coarse (network) fix instead of going silent
//  - throttled to one fix per `intervalMs` (battery + queue size); fixes with accuracy worse than `maxAccuracyM` are ignored
//  - restarts the watch when the tab becomes visible again (mobile browsers throttle background watchers)
// status: idle | acquiring | ok | denied | unavailable
export function useGeolocationStream({ enabled, intervalMs = 5000, maxAccuracyM = 500, onFix, geo = globalThis.navigator?.geolocation } = {}) {
  const [fix, setFix] = useState(() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.lastFix) || "null"); } catch { return null; } });
  const [status, setStatus] = useState("idle");
  const cb = useRef(onFix); cb.current = onFix;
  const last = useRef(0);

  useEffect(() => {
    if (!enabled) { setStatus("idle"); return undefined; }
    if (!geo) { setStatus("unavailable"); return undefined; }
    let id = null, stopped = false, coarse = false;
    const handle = (pos) => {
      if (stopped) return;
      const c = pos.coords;
      if (c.accuracy != null && c.accuracy > maxAccuracyM) return;
      const now = Date.now();
      if (now - last.current < intervalMs) return;
      last.current = now;
      const point = { t: pos.timestamp || now, lat: c.latitude, lng: c.longitude, accuracy: c.accuracy ?? null, speed: c.speed ?? null, bearing: c.heading ?? null };
      const f = { ...point, at: now };
      setFix(f); setStatus("ok");
      try { localStorage.setItem(STORAGE_KEYS.lastFix, JSON.stringify(f)); } catch { /* ignore */ }
      cb.current?.(point);
    };
    const fail = (err) => {
      if (stopped) return;
      if (err.code === 1) { setStatus("denied"); return; }
      if (!coarse) { coarse = true; start(false); return; }   // weak signal: settle for a coarse fix rather than nothing
      setStatus("unavailable");
    };
    const start = (high) => {
      if (id != null) geo.clearWatch(id);
      id = geo.watchPosition(handle, fail, { enableHighAccuracy: high, maximumAge: 5000, timeout: high ? 20000 : 30000 });
    };
    const onVis = () => { if (document.visibilityState === "visible") { coarse = false; start(true); } };
    setStatus("acquiring"); start(true);
    document.addEventListener("visibilitychange", onVis);
    return () => { stopped = true; document.removeEventListener("visibilitychange", onVis); if (id != null) geo.clearWatch(id); };
  }, [enabled, intervalMs, maxAccuracyM, geo]);

  return { fix, status };
}
