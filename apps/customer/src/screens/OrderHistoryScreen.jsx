import React, { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useAuthUI } from "../context/AuthUIContext";
import { ErrorBanner } from "../components/common/UIComponents";
import { formatINR } from "../utils/helpers";
import { hapticTap } from "../utils/native";

const STYLES = `
.swo { min-height:100vh; background:var(--bg,#F4F5FA); color:var(--ink,#1F1F1F); }
.swo-head { position:sticky; top:0; z-index:10; display:flex; align-items:center; gap:10px; background:#fff;
  padding:calc(12px + env(safe-area-inset-top)) 14px 12px; border-bottom:1px solid var(--line,#E8E8E8); }
.swo-back, .swo-refresh { width:38px; height:38px; border-radius:50%; background:#F0F0F0; display:grid; place-items:center; font-size:1.1rem; flex:none; }
.swo-title { font-weight:800; font-size:1.1rem; flex:1; }
.swo-list { padding:14px; display:flex; flex-direction:column; gap:10px; padding-bottom:calc(24px + env(safe-area-inset-bottom)); }
.swo-card { width:100%; text-align:left; background:#fff; border-radius:14px; padding:14px; border:1px solid var(--line,#E8E8E8); }
.swo-card:active { transform:scale(.99); }
.swo-top { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:6px; }
.swo-id { font-weight:800; font-size:.9rem; }
.swo-pill { font-size:.72rem; font-weight:800; padding:4px 9px; border-radius:20px; white-space:nowrap; }
.swo-pill.ok { background:#E8F5EA; color:#0C831F; }
.swo-pill.wait { background:#FFF4D6; color:#8A5A00; }
.swo-pill.bad { background:#FEF3F2; color:#B42318; }
.swo-items { color:#444; font-size:.86rem; line-height:1.35; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.swo-meta { display:flex; justify-content:space-between; margin-top:8px; color:var(--muted,#6B6B6B); font-size:.78rem; }
.swo-empty { text-align:center; padding:56px 24px; color:var(--muted,#6B6B6B); }
.swo-empty b { display:block; color:var(--ink,#1F1F1F); font-size:1.05rem; margin:8px 0 4px; }
.swo-cta { margin-top:14px; background:var(--green,#0C831F); color:#fff; font-weight:800; padding:12px 22px; border-radius:12px; }
.swo-skel { height:86px; border-radius:14px; background:linear-gradient(90deg,#ECECEC,#F6F6F6,#ECECEC); background-size:200% 100%; animation:swo-sh 1.2s linear infinite; }
@keyframes swo-sh { from{background-position:200% 0} to{background-position:-200% 0} }
`;

const STATUS = {
  MATCHING: ["Finding pharmacy", "wait"],
  SENT_TO_PHARMACY: ["Waiting for pharmacy", "wait"],
  ACCEPTED: ["Accepted", "ok"],
  OUT_FOR_DELIVERY: ["Out for delivery", "ok"],
  DELIVERED: ["Delivered", "ok"],
  RETURNED: ["Returned to pharmacy", "bad"],
  COMPLETED: ["Completed", "ok"],
  UNFULFILLABLE: ["Not available", "bad"],
  CANCELLED: ["Cancelled", "bad"],
  REJECTED: ["Rejected", "bad"],
};
const statusInfo = (s) => STATUS[s] || [String(s || "Unknown").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), "wait"];

const when = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const fmtWhen = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? "" : when.format(d); };

function parseLines(items) {
  let v = items;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = []; } }
  return Array.isArray(v) ? v : [];
}

function OrderCard({ order, onOpen }) {
  const lines = parseLines(order.items);
  const [label, tone] = statusInfo(order.status);
  const summary = lines.map((l) => `${l.name || l} × ${l.quantity || 1}`).join(", ") || "Order";
  const priced = lines.length > 0 && lines.every((l) => Number(l.price) > 0);
  const total = priced ? lines.reduce((s, l) => s + Number(l.price) * (Number(l.quantity) || 1), 0) : null;
  const count = lines.reduce((s, l) => s + (Number(l.quantity) || 1), 0);

  return (
    <button className="swo-card" onClick={() => { hapticTap(); onOpen(order.id); }}>
      <div className="swo-top">
        <span className="swo-id">Order #{String(order.id).slice(0, 8).toUpperCase()}</span>
        <span className={`swo-pill ${tone}`}>{label}</span>
      </div>
      <div className="swo-items">{summary}</div>
      <div className="swo-meta">
        <span>{fmtWhen(order.created_at)}{order.pharmacy_name ? ` · ${order.pharmacy_name}` : ""}</span>
        <span>{count} item{count === 1 ? "" : "s"}{total !== null ? ` · ${formatINR(total)}` : ""}</span>
      </div>
    </button>
  );
}

export default function OrderHistoryScreen({ onBack, onOpenOrder }) {
  const { customer } = useAuth();
  const { openLogin } = useAuthUI();
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!customer) return;
    setLoading(true);
    setError("");
    try {
      const r = await api.getMyOrders();
      setOrders(Array.isArray(r.orders) ? r.orders : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [customer]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="swo">
      <style>{STYLES}</style>
      <div className="swo-head">
        <button className="swo-back" onClick={() => { hapticTap(); onBack(); }} aria-label="Back">←</button>
        <div className="swo-title">My Orders</div>
        {customer && <button className="swo-refresh" onClick={load} disabled={loading} aria-label="Refresh orders">↻</button>}
      </div>

      <div className="swo-list">
        {!customer && (
          <div className="swo-empty">
            <span style={{ fontSize: "2rem" }}>🧾</span>
            <b>Log in to see your orders</b>
            Your past and current orders will show up here.
            <div><button className="swo-cta" onClick={openLogin}>Log in</button></div>
          </div>
        )}

        {customer && <ErrorBanner message={error} />}

        {customer && orders === null && !error && [0, 1, 2].map((i) => <div key={i} className="swo-skel" />)}

        {customer && orders && orders.length === 0 && (
          <div className="swo-empty">
            <span style={{ fontSize: "2rem" }}>💊</span>
            <b>No orders yet</b>
            When you place an order, it will appear here.
            <div><button className="swo-cta" onClick={onBack}>Start shopping</button></div>
          </div>
        )}

        {customer && orders && orders.map((o) => <OrderCard key={o.id} order={o} onOpen={onOpenOrder} />)}
      </div>
    </div>
  );
}
