import { useCallback, useEffect, useState } from "react";
import { STATUS_TEXT, actionsFor, canClaim, money, stepOf, validDisputeNote } from "../lib/payout.js";

const when = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

function Steps({ status }) {
  const at = stepOf(status);
  const items = ["You claimed it", "SehatWaadi pays you", "You confirm it arrived"];
  return <ol className="paysteps">{items.map((t, i) => <li key={t} className={i + 1 < at ? "done" : i + 1 === at ? (status === "DISPUTED" ? "warn" : "now") : ""}><span>{i + 1 <= at && status !== "DISPUTED" ? "✓" : i + 1}</span>{t}</li>)}</ol>;
}

// Settlement: the chemist claims what SehatWaadi owes him (order value minus commission). SehatWaadi pays it and records the payment
// reference. The chemist confirms the money arrived. Only then is it settled and the balance back to zero.
export default function Payouts({ hub }) {
  const { api, notify } = hub;
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [disputing, setDisputing] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(() => api.payouts().then(setData).catch((e) => notify(e.message, "warn")), [api, notify]);
  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    const onPush = () => load();                                   // the Hub tells us the moment SehatWaadi records a payment
    window.addEventListener("sw-payout-updated", onPush);
    return () => { clearInterval(t); window.removeEventListener("sw-payout-updated", onPush); };
  }, [load]);

  async function run(fn, done) {
    setBusy(true);
    try { await fn(); if (done) notify(done); setDisputing(false); setNote(""); await load(); }
    catch (e) { notify(e.message, "warn"); load(); } finally { setBusy(false); }
  }
  const open = data && data.open;
  const act = open ? actionsFor(open.status) : {};

  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className="payouts">
      <h2>Settlement</h2>
      <p className="muted">When you want your money, claim a settlement. SehatWaadi pays you what the orders came to, minus its commission, and records the payment. When it reaches your account, confirm it here. Then your balance is zero.</p>

      <section className="card pay-balance">
        <div><span className="muted">Waiting to be settled</span><b className="num big">{money(data.unsettled.amount)}</b><span className="muted">from {data.unsettled.orders} finished order{data.unsettled.orders === 1 ? "" : "s"}, after commission</span></div>
        <button className="btn primary" disabled={busy || !canClaim(data)} onClick={() => run(() => api.requestPayout(), "Settlement claimed. SehatWaadi has been asked to pay you.")}>Claim settlement</button>
      </section>
      {open && !canClaim(data) && Number(data.unsettled.amount) > 0 && <p className="muted small">New orders ({money(data.unsettled.amount)}) will go into your next claim once this one is settled.</p>}

      {open && (
        <section className="card pay-open" aria-live="polite">
          <div className="row-between"><h3>Your claim · {money(open.amount)}</h3><span className="muted">{open.ordersCount} orders · claimed {when(open.requestedAt)}</span></div>
          <Steps status={open.status} />
          <p className={open.status === "DISPUTED" ? "banner-warn" : ""}><b>{STATUS_TEXT[open.status]}</b></p>
          {open.status === "PAID" && <p className="muted">Paid {when(open.paidAt)}{open.paidRef ? <> · payment reference <b className="num">{open.paidRef}</b></> : null}. Check it for <b>{money(open.amount)}</b> in your bank or UPI app, then confirm.</p>}
          {open.status === "DISPUTED" && open.disputeNote && <p className="muted">You wrote: “{open.disputeNote}”</p>}
          <div className="row">
            {act.confirm && <button className="btn primary" disabled={busy} onClick={() => { if (window.confirm(`Confirm that ${money(open.amount)} reached your account? This settles the claim.`)) run(() => api.confirmPayout(open.id), "Settled. Your balance is zero."); }}>Yes, I received it</button>}
            {act.dispute && !disputing && <button className="btn" disabled={busy} onClick={() => setDisputing(true)}>I did not receive it</button>}
            {act.withdraw && <button className="btn" disabled={busy} onClick={() => { if (window.confirm("Take this claim back? Its orders will wait for your next claim.")) run(() => api.withdrawPayout(open.id), "Claim withdrawn."); }}>Withdraw claim</button>}
          </div>
          {disputing && (
            <div className="dispute">
              <label className="field">What happened?<textarea rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Nothing has come into my account yet" /></label>
              <div className="row"><button className="btn" onClick={() => { setDisputing(false); setNote(""); }}>Cancel</button><button className="btn primary" disabled={busy || !validDisputeNote(note)} onClick={() => run(() => api.disputePayout(open.id, note.trim()), "Sent. SehatWaadi will check it.")}>Send</button></div>
            </div>
          )}
        </section>
      )}

      <h3>Past settlements</h3>
      {!data.history.length ? <div className="empty card"><p>No settled claims yet.</p></div> : (
        <div className="tablewrap"><table className="ledger">
          <thead><tr><th>Claimed</th><th className="r">Orders</th><th className="r">Amount</th><th>Payment reference</th><th>Result</th></tr></thead>
          <tbody>{data.history.map((h) => <tr key={h.id} className={h.status === "CANCELLED" ? "returned" : ""}><td>{when(h.requestedAt)}</td><td className="r num">{h.ordersCount}</td><td className="r num"><b>{money(h.amount)}</b></td><td className="num">{h.paidRef || "—"}</td><td>{h.status === "CONFIRMED" ? `Settled ${when(h.confirmedAt)}` : `Cancelled${h.cancelNote ? ` · ${h.cancelNote}` : ""}`}</td></tr>)}</tbody>
        </table></div>
      )}
    </div>
  );
}
