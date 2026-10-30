import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { api, ApiError } from "../api/client.js";
import { useAuth } from "../auth/AuthContext.jsx";
import { startSiren, stopSiren } from "../services/siren.js";

const Ctx = createContext(null);
export const useHub = () => useContext(Ctx);

const ticksKey = (id) => `swc.ticks.${id}`;
const loadTicks = (id) => { try { return JSON.parse(localStorage.getItem(ticksKey(id)) || "{}"); } catch { return {}; } };
const saveTicks = (id, t) => { try { localStorage.setItem(ticksKey(id), JSON.stringify(t)); } catch { /* */ } };
const dropTicks = (id) => { try { localStorage.removeItem(ticksKey(id)); } catch { /* */ } };

export function HubProvider({ children }) {
  const { session, logout } = useAuth();
  const [socketUp, setSocketUp] = useState(false);
  const [hubReachable, setHubReachable] = useState(true);
  const [paused, setPausedState] = useState(false);
  const [orders, setOrders] = useState({});          // orderId -> order (OFFERED | PICKING)
  const [deliveries, setDeliveries] = useState([]);
  const [notices, setNotices] = useState([]);
  const [handover, setHandover] = useState(null);    // order snapshot for the pickup QR modal
  const [selected, setSelected] = useState(null);
  const ordersRef = useRef(orders); ordersRef.current = orders;

  const notify = useCallback((text, tone = "warn") => {
    const id = Math.random().toString(36).slice(2);
    setNotices((n) => [...n, { id, text, tone }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 9000);
  }, []);

  const guard = useCallback((e) => { if (e instanceof ApiError && e.status === 403) { notify("Your pharmacy key was rejected. Please sign in again.", "bad"); logout(); } return e; }, [logout, notify]);

  const upsert = useCallback((p, fromPoll = false) => {
    setOrders((prev) => {
      const old = prev[p.orderId];
      const remainingMs = Math.max(1, Number(p.timeoutSeconds) || 1) * 1000;
      const picking = fromPoll ? !!p.picking : old ? old.stage === "PICKING" : false;
      const next = {
        id: p.orderId, lines: p.lines || [], total: p.total, requiresRx: !!p.requiresRx, rxStatus: p.rxStatus, hasRxImage: !!p.hasRxImage,
        stage: picking ? "PICKING" : "OFFERED",
        deadlineAt: Date.now() + remainingMs,
        pickTotalMs: old && old.pickTotalMs ? old.pickTotalMs : remainingMs,
        extended: fromPoll ? !!p.extended : old ? old.extended : false,
        ticked: old ? old.ticked : loadTicks(p.orderId),
        receivedAt: old ? old.receivedAt : Date.now(),
      };
      return { ...prev, [p.orderId]: next };
    });
  }, []);
  const remove = useCallback((id) => { setOrders((prev) => { const n = { ...prev }; delete n[id]; return n; }); dropTicks(id); }, []);

  // ---- live socket ----
  useEffect(() => {
    if (!session) return undefined;
    const socket = io(session.hubUrl, { transports: ["websocket", "polling"], reconnection: true, reconnectionDelayMax: 5000 });
    const register = () => { setSocketUp(true); socket.emit("register_spoke", { pharmacyId: session.pharmacyId, apiKey: session.apiKey }); };
    socket.on("connect", register);
    socket.on("disconnect", () => setSocketUp(false));
    socket.on("new_order", (p) => p && p.orderId && upsert(p));
    socket.on("order_released", ({ orderId, reason }) => {
      if (!ordersRef.current[orderId]) return;
      remove(orderId);
      notify(reason === "TIMEOUT" ? "Time ran out. The order was passed to another pharmacy." : "The order was passed to another pharmacy.");
    });
    socket.on("delivery_update", () => refreshDeliveries());
    return () => socket.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // ---- heartbeat (tells the Hub this shop is online) ----
  useEffect(() => {
    if (!session) return undefined;
    let stop = false;
    const beat = async () => {
      try { const r = await api("/api/companion/heartbeat", { method: "POST" }); if (!stop) { setPausedState(!!r.paused); setHubReachable(true); } }
      catch (e) { if (!stop) { setHubReachable(false); guard(e); } }
    };
    beat(); const t = setInterval(beat, 20000);
    return () => { stop = true; clearInterval(t); };
  }, [session, guard]);

  // ---- polling fallback for orders (also restores state after a refresh) ----
  const syncOrders = useCallback(async () => {
    try {
      const r = await api("/api/companion/orders/active");
      const ids = new Set(r.orders.map((o) => o.orderId));
      r.orders.forEach((o) => upsert(o, true));
      setOrders((prev) => { const n = { ...prev }; for (const id of Object.keys(n)) if (!ids.has(id)) { delete n[id]; dropTicks(id); } return n; });
    } catch (e) { guard(e); }
  }, [upsert, guard]);
  useEffect(() => { if (!session) return undefined; syncOrders(); const t = setInterval(syncOrders, 15000); return () => clearInterval(t); }, [session, syncOrders]);

  const refreshDeliveries = useCallback(async () => {
    if (!session) return;
    try { const r = await api(`/api/delivery/pharmacy/${session.pharmacyId}`); setDeliveries(r.deliveries || []); } catch (e) { guard(e); }
  }, [session, guard]);
  useEffect(() => { if (!session) return undefined; refreshDeliveries(); const t = setInterval(refreshDeliveries, 10000); return () => clearInterval(t); }, [session, refreshDeliveries]);

  // ---- siren: rings while any order is waiting to be opened ----
  const offered = Object.values(orders).some((o) => o.stage === "OFFERED");
  const sos = deliveries.some((d) => d.issue_type);
  useEffect(() => { if ((offered && !paused) || sos) startSiren(); else stopSiren(); return stopSiren; }, [offered, paused, sos]);

  // keep the selection valid
  useEffect(() => {
    const ids = Object.keys(orders);
    if (!ids.length) { if (selected) setSelected(null); return; }
    if (!selected || !orders[selected]) setSelected(ids.sort((a, b) => orders[a].receivedAt - orders[b].receivedAt)[0]);
  }, [orders, selected]);

  // ---- actions ----
  const setPaused = useCallback(async (p) => {
    try { const r = await api("/api/companion/pause", { method: "POST", body: { paused: p } }); setPausedState(!!r.paused); } catch (e) { notify(guard(e).message, "bad"); }
  }, [guard, notify]);

  const gone = useCallback((id, e) => { if (e instanceof ApiError && e.code === "no_longer_yours") { remove(id); notify("Order timed out and was reassigned to another pharmacy.", "warn"); return true; } return false; }, [remove, notify]);

  const openOrder = useCallback(async (id) => {
    try {
      const r = await api(`/api/companion/orders/${id}/start-picking`, { method: "POST" });
      setOrders((prev) => prev[id] ? { ...prev, [id]: { ...prev[id], stage: "PICKING", deadlineAt: Date.now() + r.remainingSeconds * 1000, pickTotalMs: r.remainingSeconds * 1000, extended: !!r.extended } } : prev);
    } catch (e) { if (!gone(id, e)) notify(guard(e).message, "bad"); }
  }, [gone, guard, notify]);

  const extend = useCallback(async (id) => {
    try {
      const r = await api(`/api/companion/orders/${id}/extend`, { method: "POST" });
      setOrders((prev) => prev[id] ? { ...prev, [id]: { ...prev[id], extended: true, deadlineAt: Date.now() + r.remainingSeconds * 1000, pickTotalMs: r.remainingSeconds * 1000 } } : prev);
    } catch (e) { if (!gone(id, e)) notify(guard(e).message, "bad"); }
  }, [gone, guard, notify]);

  const toggleTick = useCallback((id, name) => {
    setOrders((prev) => {
      const o = prev[id]; if (!o) return prev;
      const ticked = { ...o.ticked, [name]: !o.ticked[name] }; saveTicks(id, ticked);
      return { ...prev, [id]: { ...o, ticked } };
    });
  }, []);

  const cantFulfil = useCallback(async (id, reason, items = []) => {
    try { await api(`/api/companion/orders/${id}/cant-fulfil`, { method: "POST", body: { reason, items } }); remove(id); notify(reason === "OUT_OF_STOCK" ? "Noted. We will not offer you that item for a while. The order moved on." : "The order moved on to another pharmacy.", "ok"); }
    catch (e) { if (!gone(id, e)) notify(guard(e).message, "bad"); }
  }, [gone, guard, notify, remove]);

  const verifyRx = useCallback(async (id, decision) => {
    try {
      await api(`/api/orders/${id}/verify-rx`, { method: "POST", body: { pharmacyId: session.pharmacyId, decision } });
      if (decision === "rejected") await cantFulfil(id, "RX_INVALID");
      else setOrders((prev) => prev[id] ? { ...prev, [id]: { ...prev[id], rxStatus: "VERIFIED" } } : prev);
    } catch (e) { if (!gone(id, e)) notify(guard(e).message, "bad"); }
  }, [session, cantFulfil, gone, guard, notify]);

  const ready = useCallback(async (id) => {
    const o = ordersRef.current[id]; if (!o) return;
    try {
      await api(`/api/companion/orders/${id}/ready`, { method: "POST", body: { packed: o.lines.map((l) => l.name) } });
      remove(id); setHandover({ orderId: id, lines: o.lines, total: o.total });
    } catch (e) { if (!gone(id, e)) notify(guard(e).message, "bad"); }
  }, [gone, guard, notify, remove]);

  const value = useMemo(() => ({
    connected: socketUp && hubReachable, socketUp, hubReachable, paused, setPaused, orders, selected, setSelected, deliveries, refreshDeliveries,
    notices, notify, handover, setHandover, openOrder, extend, toggleTick, cantFulfil, verifyRx, ready, sos,
  }), [socketUp, hubReachable, paused, setPaused, orders, selected, deliveries, refreshDeliveries, notices, notify, handover, openOrder, extend, toggleTick, cantFulfil, verifyRx, ready, sos]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
