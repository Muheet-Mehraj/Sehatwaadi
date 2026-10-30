import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import { money } from "./useCountdown.js";

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

// One line per order, taken from the Hub's stored money columns. The app never calculates commission.
export default function Settlement() {
  const [rows, setRows] = useState(null); const [err, setErr] = useState("");
  const load = useCallback(() => api("/api/companion/settlements").then((r) => { setRows(r.rows); setErr(""); }).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
  const t = useMemo(() => {
    const done = (rows || []).filter((r) => r.status === "DELIVERED" && sameDay(r.created_at, Date.now()));
    const sum = (k) => done.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    return { orders: done.length, gross: sum("order_subtotal"), fee: sum("platform_commission"), net: sum("pharmacy_net_amount") };
  }, [rows]);
  return (
    <div>
      {err && <div className="alert bad">{err}</div>}
      <div className="kpis">
        <div className="kpi"><span>Delivered today</span><b>{t.orders}</b></div>
        <div className="kpi"><span>Online sales today</span><b>{money(t.gross)}</b></div>
        <div className="kpi"><span>SehatWaadi commission</span><b>{money(t.fee)}</b></div>
        <div className="kpi good"><span>You receive</span><b>{money(t.net)}</b></div>
      </div>
      <div className="card tablewrap">
        <table className="ledger">
          <thead><tr><th>Time</th><th>Order</th><th>Status</th><th>Paid by</th><th className="num">Bill</th><th className="num">Commission</th><th className="num">You receive</th></tr></thead>
          <tbody>
            {!rows ? <tr><td colSpan="7" className="muted">Loading…</td></tr> : !rows.length ? <tr><td colSpan="7" className="muted">No orders yet.</td></tr> :
              rows.map((r) => {
                const sub = Number(r.order_subtotal) || 0, c = Number(r.platform_commission) || 0;
                return (
                  <tr key={r.id} className={r.status === "RETURNED" ? "dim" : ""}>
                    <td>{new Date(r.created_at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                    <td>#{String(r.order_id).slice(0, 8)}</td><td>{r.status}</td><td>{r.payment_mode === "CASH" ? "Cash (rider)" : r.payment_mode}</td>
                    <td className="num">{money(sub)}</td><td className="num">{money(c)}{sub ? <span className="muted small"> ({Math.round((c / sub) * 1000) / 10}%)</span> : null}</td><td className="num"><b>{money(r.pharmacy_net_amount)}</b></td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      <p className="muted small">Riders never pay cash at your counter. Cash orders are collected by the rider and settled with SehatWaadi. Payout status per order is not tracked in this version.</p>
    </div>
  );
}
