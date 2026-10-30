import { Fragment, useEffect, useMemo, useState } from "react";

const money = (n) => `₹${Number(n || 0).toFixed(2)}`;
const pct = (n) => (n === null || n === undefined ? "—" : `${Number(n)}%`);
const day = (iso) => new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const time = (iso) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

// Every figure here comes from the Hub, frozen when the order was dispatched. The app only adds them up for display.
export default function Settlements({ hub }) {
  const { api } = hub;
  const [rows, setRows] = useState(null);
  const [terms, setTerms] = useState(null);
  const [err, setErr] = useState("");
  const [days, setDays] = useState(30);
  const [open, setOpen] = useState({});

  useEffect(() => { let live = true; api.terms().then((t) => live && setTerms(t)).catch(() => {}); return () => { live = false; }; }, [api]);
  useEffect(() => {
    let live = true; setRows(null); setErr("");
    api.settlements(days).then((r) => live && setRows(r.settlements)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [api, days]);

  const byDay = useMemo(() => {
    const m = new Map();
    for (const r of rows || []) {
      const k = day(r.updated_at);
      const g = m.get(k) || { day: k, orders: 0, gross: 0, commission: 0, net: 0, returned: 0 };
      if (r.status === "DELIVERED") { g.orders += 1; g.gross += Number(r.order_subtotal || 0); g.commission += Number(r.platform_commission || 0); g.net += Number(r.pharmacy_net_amount || 0); }
      else g.returned += 1;
      m.set(k, g);
    }
    return [...m.values()];
  }, [rows]);

  const today = byDay.find((g) => g.day === day(new Date().toISOString()));
  if (err) return <p className="error" role="alert">{err}</p>;
  if (!rows) return <p className="muted">Loading…</p>;
  const anyMismatch = rows.some((r) => r.mismatch);

  return (
    <div className="settle">
      {terms && terms.categories && terms.categories.length > 0 && (
        <section className="card terms">
          <h2>Your terms</h2>
          <p className="muted">SehatWaadi's commission on each kind of item, as agreed with you. It is fixed on an order when you send the rider, so a later change never affects orders already sent.</p>
          <ul className="termgrid">
            {terms.categories.map((c) => (
              <li key={c.code}><span>{c.label}</span><b className="num">{c.percent === null ? (terms.otherItemsPercent === null ? "—" : `${terms.otherItemsPercent}% *`) : `${c.percent}%`}</b></li>
            ))}
          </ul>
          {terms.categories.some((c) => c.percent === null) && terms.otherItemsPercent !== null && <p className="muted small">* No separate rate agreed, so the standard {terms.otherItemsPercent}% applies.</p>}
        </section>
      )}

      <div className="kpis">
        <div className="card kpi"><span className="muted">Today · delivered orders</span><b className="num">{today ? today.orders : 0}</b></div>
        <div className="card kpi"><span className="muted">Today · order value</span><b className="num">{money(today && today.gross)}</b></div>
        <div className="card kpi"><span className="muted">Today · SehatWaadi commission</span><b className="num">−{money(today && today.commission)}</b></div>
        <div className="card kpi good"><span className="muted">Today · you receive</span><b className="num">{money(today && today.net)}</b></div>
      </div>

      <div className="row-between"><h2>Order by order</h2>
        <label>Show last <select value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label>
      </div>
      <p className="muted">Each line is one finished order. Tap “Details” to see the commission item by item. The daily total is the sum of its lines.</p>
      {anyMismatch && <p className="banner-warn">One or more orders show a different commission in SehatWaadi's delivery records. The figure below is the one fixed when you sent the rider. Tell SehatWaadi if you think it is wrong.</p>}
      {!rows.length ? <div className="empty card"><p>No finished orders in this period.</p></div> : (
        <div className="tablewrap"><table className="ledger">
          <thead><tr><th>Date</th><th>Order</th><th>Result</th><th>Paid by</th><th className="r">Order value</th><th className="r">Commission</th><th className="r">You receive</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
                <tr className={r.status === "RETURNED" ? "returned" : ""}>
                  <td>{day(r.updated_at)} <span className="muted">{time(r.updated_at)}</span></td>
                  <td className="num">{String(r.order_id).slice(0, 8)}</td>
                  <td>{r.status === "DELIVERED" ? "Delivered" : "Returned to shop"}</td>
                  <td>{String(r.payment_mode || "").toLowerCase() === "cash" ? "Cash on delivery" : String(r.payment_mode || "—")}</td>
                  <td className="r num">{money(r.order_subtotal)}</td>
                  <td className="r num">−{money(r.platform_commission)} <span className="muted small">{r.rate_percent !== null ? `(${pct(r.rate_percent)})` : ""}</span></td>
                  <td className="r num"><b>{money(r.pharmacy_net_amount)}</b></td>
                  <td>{r.lines && r.lines.length > 0 && <button className="btn small ghost" aria-expanded={Boolean(open[r.id])} onClick={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))}>{open[r.id] ? "Hide" : "Details"}</button>}</td>
                </tr>
                {open[r.id] && (
                  <tr className="detail"><td colSpan={8}>
                    <table className="inner"><thead><tr><th>Item</th><th>Type</th><th className="r">Qty</th><th className="r">Value</th><th className="r">Rate</th><th className="r">Commission</th></tr></thead>
                      <tbody>{r.lines.map((l, i) => <tr key={i}><td>{l.item}</td><td>{(terms && terms.categories.find((c) => c.code === l.category)?.label) || l.category || "Other items"}</td><td className="r num">{l.quantity}</td><td className="r num">{money(l.value)}</td><td className="r num">{pct(l.ratePercent)}</td><td className="r num">−{money(l.commission)}</td></tr>)}</tbody>
                    </table>
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table></div>
      )}
      <h2>Day totals</h2>
      <div className="tablewrap"><table className="ledger">
        <thead><tr><th>Day</th><th className="r">Delivered</th><th className="r">Returned</th><th className="r">Order value</th><th className="r">Commission</th><th className="r">You receive</th></tr></thead>
        <tbody>{byDay.map((g) => <tr key={g.day}><td>{g.day}</td><td className="r num">{g.orders}</td><td className="r num">{g.returned}</td><td className="r num">{money(g.gross)}</td><td className="r num">−{money(g.commission)}</td><td className="r num"><b>{money(g.net)}</b></td></tr>)}</tbody>
      </table></div>
    </div>
  );
}
