import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFlusher, createLocationQueue } from "../services/locationQueue.js";
import { ACTIVE_SAMPLE_MS, IDLE_SAMPLE_MS } from "../config.js";
import { useGeolocationStream } from "./useGeolocationStream.js";
import { getOnce } from "../services/quickFix.js";

// GPS -> durable queue -> server. Every fix goes into IndexedDB first; the flusher then uploads oldest-first batches and only
// deletes what the server confirmed. Weak signal just means the queue grows and drains later (exponential backoff, and an
// immediate retry the moment the browser reports it's back online).
export function useLocationBroadcast({ api, enabled, active, onAssigned, queue: injected, geo }) {
  const queue = useMemo(() => injected || createLocationQueue(), [injected]);
  const assigned = useRef(onAssigned); assigned.current = onAssigned;
  const [pending, setPending] = useState(0);
  const [lastError, setLastError] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const flusher = useMemo(() => createFlusher({
    queue, push: (pts) => api.pushLocations(pts),
    onAssigned: (id) => assigned.current?.(id), onResult: (r) => setLastError(r.failed ? r.error || "network" : null),
  }), [queue, api]);

  const refresh = async () => setPending(await queue.size());
  const flush = async (opts) => { const r = await flusher.flush(opts); if (r && !r.skipped) { if (!r.failed) { setLastError(null); setLastSyncAt(Date.now()); } await refresh(); } return r; };

  const { fix, status } = useGeolocationStream({
    enabled, intervalMs: active ? ACTIVE_SAMPLE_MS : IDLE_SAMPLE_MS, geo,
    onFix: async (p) => { await queue.enqueue(p); await refresh(); flush(); },
  });

  useEffect(() => {
    if (!enabled) return undefined;
    const every = setInterval(() => flush(), active ? ACTIVE_SAMPLE_MS : IDLE_SAMPLE_MS);
    const back = () => flush({ force: true }); const vis = () => { if (document.visibilityState === "visible") flush({ force: true }); };
    window.addEventListener("online", back); document.addEventListener("visibilitychange", vis);
    flush({ force: true });
    return () => { clearInterval(every); window.removeEventListener("online", back); document.removeEventListener("visibilitychange", vis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, active, flusher]);

  // Called the moment the rider goes online (or the app opens while already online): send one quick position right away so the
  // server can assign a waiting order at once, instead of waiting for the first continuous GPS fix.
  const kickstart = useCallback(async () => {
    const p = await getOnce(geo || globalThis.navigator?.geolocation);
    if (p) { await queue.enqueue(p); await refresh(); }
    return flush({ force: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, queue, flusher]);

  return { fix, geoStatus: status, pending, lastError, lastSyncAt, flushNow: () => flush({ force: true }), kickstart };
}
