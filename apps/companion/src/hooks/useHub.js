import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { createApi } from "../lib/api.js";
import { startRinging, stopRinging } from "../lib/ringer.js";
import { load, save, PAUSED_KEY } from "../lib/storage.js";

// Turns a socket payload or a REST row into one shape. deadlineAt is a local clock time, so a clock difference between
// the PC and the Hub only shifts the display; the Hub still decides who wins.
function normalize(o, prev = {}) {
  const secs = Number.isFinite(o.timeoutSeconds) ? o.timeoutSeconds : 45;
  return {
    orderId: o.orderId,
    lines: o.lines || (o.items || []).map((name) => ({ name, quantity: 1 })),
    total: o.total,
    requiresRx: Boolean(o.requiresRx),
    rxStatus: o.rxStatus || "NOT_REQUIRED",
    hasRxImage: Boolean(o.hasRxImage),
    pickingStarted: o.pickingStarted ?? prev.pickingStarted ?? false,
    extensionUsed: o.extensionUsed ?? prev.extensionUsed ?? false,
    totalSeconds: prev.totalSeconds || secs,
    deadlineAt: Date.now() + secs * 1000,
    createdAt: o.createdAt || prev.createdAt || new Date().toISOString(),
  };
}

export function useHub(config) {
  const api = useMemo(() => createApi(config), [config.hubUrl, config.pharmacyId, config.apiKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [conn, setConn] = useState("connecting");          // connecting | live | offline
  const [paused, setPausedState] = useState(() => load(PAUSED_KEY, false));
  const [orders, setOrders] = useState({});                // orderId -> normalized order
  const [deliveries, setDeliveries] = useState([]);
  const [notices, setNotices] = useState([]);
  const handled = useRef(new Set());                       // orders this terminal already dispatched or released itself
  const failures = useRef(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const notify = useCallback((text, kind = "info") => {
    const id = Math.random().toString(36).slice(2);
    setNotices((n) => [...n.slice(-3), { id, text, kind }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 9000);
  }, []);
  const dismiss = useCallback((id) => setNotices((n) => n.filter((x) => x.id !== id)), []);

  const markHandled = useCallback((orderId) => {
    handled.current.add(orderId);
    setOrders((m) => { const c = { ...m }; delete c[orderId]; return c; });
  }, []);
  const patchOrder = useCallback((orderId, patch) => setOrders((m) => (m[orderId] ? { ...m, [orderId]: { ...m[orderId], ...patch } } : m)), []);

  const refreshOrders = useCallback(async () => {
    try {
      const r = await api.listOrders();
      failures.current = 0; setConn((c) => (c === "offline" ? "live" : c));
      const ids = new Set(r.orders.map((o) => o.orderId));
      setOrders((prev) => {
        const next = {};
        for (const o of r.orders) next[o.orderId] = normalize(o, prev[o.orderId]);
        for (const id of Object.keys(prev)) {
          if (!ids.has(id) && !handled.current.has(id)) notify("An order was passed on to another pharmacy.", "warn");
        }
        return next;
      });
    } catch { /* heartbeat/connection state is handled in the heartbeat loop */ }
  }, [api, notify]);

  const refreshDeliveries = useCallback(async () => {
    try { const r = await api.deliveries(); setDeliveries(r.deliveries || []); } catch { /* keep the last list */ }
  }, [api]);

  const setPaused = useCallback((p) => { setPausedState(p); save(PAUSED_KEY, p); api.heartbeat(p).catch(() => {}); }, [api]);

  // heartbeat: tells the Hub this terminal is alive. Two failures in a row show the shop as offline.
  useEffect(() => {
    let stop = false;
    const beat = async () => {
      try { await api.heartbeat(pausedRef.current); failures.current = 0; if (!stop) setConn((c) => (c === "live" ? c : "live")); }
      catch (e) {
        failures.current += 1;
        if (e.status === 403) { if (!stop) setConn("denied"); return; }
        if (failures.current >= 2 && !stop) setConn("offline");
      }
    };
    beat(); const t = setInterval(beat, 30000);
    return () => { stop = true; clearInterval(t); };
  }, [api]);

  // live channel + polling fallback
  useEffect(() => {
    const socket = io(config.hubUrl.replace(/\/+$/, ""), { reconnection: true, reconnectionDelayMax: 5000 });
    socket.on("connect", () => { socket.emit("register_spoke", { pharmacyId: config.pharmacyId, apiKey: config.apiKey }); refreshOrders(); refreshDeliveries(); });
    socket.on("new_order", (p) => { handled.current.delete(p.orderId); setOrders((m) => ({ ...m, [p.orderId]: normalize(p) })); });
    socket.on("order_withdrawn", (p) => {
      setOrders((m) => { if (!m[p.orderId]) return m; const c = { ...m }; delete c[p.orderId]; return c; });
      notify("An order timed out and was passed to another pharmacy.", "warn");
    });
    socket.on("delivery_update", () => refreshDeliveries());
    socket.on("payout_updated", () => window.dispatchEvent(new Event("sw-payout-updated")));   // the Settlement tab refreshes itself
    socket.on("dispatch_stuck", () => { notify("No rider has accepted an order yet. We keep searching.", "warn"); refreshDeliveries(); });
    const poll = setInterval(refreshOrders, 10000);
    const polld = setInterval(refreshDeliveries, 8000);
    refreshOrders(); refreshDeliveries();
    return () => { socket.close(); clearInterval(poll); clearInterval(polld); };
  }, [config.hubUrl, config.pharmacyId, config.apiKey, refreshOrders, refreshDeliveries, notify]);

  // The alarm runs while any order is waiting to be opened, and stops the moment the chemist starts picking it.
  const unopened = Object.values(orders).filter((o) => !o.pickingStarted).length;
  useEffect(() => { if (unopened > 0 && !paused) startRinging(); else stopRinging(); return () => stopRinging(); }, [unopened, paused]);

  const sos = deliveries.filter((d) => d.issue_type);
  return { api, conn, paused, setPaused, orders, patchOrder, markHandled, deliveries, sos, refreshOrders, refreshDeliveries, notices, notify, dismiss, unopened };
}
