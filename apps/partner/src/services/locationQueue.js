// Durable queue for GPS points so nothing is lost in a basement, a tunnel or a weak-signal lane.
//   enqueue -> always succeeds locally (IndexedDB; falls back to localStorage, then memory)
//   flusher -> sends oldest-first batches through push_locations; removes a batch ONLY after the server confirms,
//              so a failed upload is simply retried (the server ignores duplicate timestamps).
import { STORAGE_KEYS } from "../config.js";
const DB_NAME = "swr-locations", STORE = "points";

function openDb(idb) {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("idb blocked"));
  });
}
const run = (db, mode, fn) => new Promise((resolve, reject) => {
  const tx = db.transaction(STORE, mode);
  let out;
  try { out = fn(tx.objectStore(STORE), tx); } catch (e) { reject(e); return; }
  tx.oncomplete = () => resolve(out && "result" in out ? out.result : out);
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error("tx aborted"));
});

function createFallback(maxSize) {
  let seq = 0, items = [];
  try { const raw = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEYS.queueFallback) || "[]"); if (Array.isArray(raw)) { items = raw; seq = items.reduce((m, i) => Math.max(m, i.key), 0); } } catch { /* memory only */ }
  const persist = () => { try { globalThis.localStorage?.setItem(STORAGE_KEYS.queueFallback, JSON.stringify(items.slice(-500))); } catch { /* ignore */ } };
  return {
    async add(point) { items.push({ key: ++seq, point }); if (items.length > maxSize) items = items.slice(-maxSize); persist(); },
    async take(n) { return items.slice(0, n).map((i) => ({ key: i.key, point: i.point })); },
    async remove(keys) { const k = new Set(keys); items = items.filter((i) => !k.has(i.key)); persist(); },
    async size() { return items.length; },
    async clear() { items = []; persist(); },
  };
}

export function createLocationQueue({ idb = globalThis.indexedDB, maxSize = 3000 } = {}) {
  let backend = null, lastT = null, ready;
  const init = () => {
    if (!ready) ready = (async () => {
      if (idb) {
        try {
          const db = await openDb(idb);
          backend = {
            add: (point) => run(db, "readwrite", (s) => s.add(point)),
            take: (n) => new Promise((resolve, reject) => {
              const out = []; const tx = db.transaction(STORE, "readonly"); const req = tx.objectStore(STORE).openCursor();
              req.onsuccess = () => { const c = req.result; if (c && out.length < n) { out.push({ key: c.key, point: c.value }); c.continue(); } };
              tx.oncomplete = () => resolve(out); tx.onerror = () => reject(tx.error);
            }),
            remove: (keys) => run(db, "readwrite", (s) => { keys.forEach((k) => s.delete(k)); }),
            size: () => new Promise((resolve, reject) => { const r = db.transaction(STORE, "readonly").objectStore(STORE).count(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }),
            clear: () => run(db, "readwrite", (s) => { s.clear(); }),
            trim: async (limit) => {   // overflow: drop the OLDEST points (the newest matter most)
              const n = await backend.size(); if (n <= limit) return;
              const oldest = await backend.take(n - Math.floor(limit * 0.9)); await backend.remove(oldest.map((o) => o.key));
            },
          };
          return;
        } catch { /* fall through */ }
      }
      backend = createFallback(maxSize);
    })();
    return ready;
  };
  return {
    async enqueue(point) { await init(); if (point.t === lastT) return false; lastT = point.t; await backend.add(point); if (backend.trim) await backend.trim(maxSize); return true; },
    async takeBatch(n = 100) { await init(); return backend.take(n); },
    async remove(keys) { await init(); return backend.remove(keys); },
    async size() { await init(); return backend.size(); },
    async clear() { await init(); lastT = null; return backend.clear(); },
  };
}

// push(points) -> { ok, assignedDeliveryId?, error? }  (the push_locations RPC)
export function createFlusher({ queue, push, batchSize = 100, minBackoffMs = 2000, maxBackoffMs = 60000, now = () => Date.now(), onAssigned, onResult } = {}) {
  let failures = 0, backoffUntil = 0, flushing = false;
  const POISON = new Set(["invalid_points", "batch_too_large"]);   // the server will never accept this batch as-is: drop it
  async function flush({ force = false } = {}) {
    if (flushing) return { skipped: "busy" };
    if (!force && now() < backoffUntil) return { skipped: "backoff" };
    flushing = true; let sent = 0;
    try {
      for (;;) {
        const batch = await queue.takeBatch(batchSize);
        if (batch.length === 0) break;
        const res = await push(batch.map((b) => b.point));
        if (res && res.ok) {
          await queue.remove(batch.map((b) => b.key)); sent += batch.length; failures = 0; backoffUntil = 0;
          if (res.assignedDeliveryId) onAssigned?.(res.assignedDeliveryId);
          if (batch.length < batchSize) break;
        } else if (res && POISON.has(res.error)) {
          await queue.remove(batch.map((b) => b.key)); onResult?.({ dropped: batch.length, error: res.error });
        } else {
          failures += 1; backoffUntil = now() + Math.min(minBackoffMs * 2 ** (failures - 1), maxBackoffMs);
          onResult?.({ failed: true, error: res?.error, retryInMs: backoffUntil - now() });
          return { sent, failed: true, error: res?.error, remaining: await queue.size() };
        }
      }
      return { sent, remaining: await queue.size() };
    } finally { flushing = false; }
  }
  return { flush, get failures() { return failures; }, get backoffUntil() { return backoffUntil; } };
}
