import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useHub } from "../hub/HubContext.jsx";
import { mmss, money, useCountdown } from "./useCountdown.js";

function Offered({ o }) {
  const { openOrder, cantFulfil } = useHub();
  const left = useCountdown(o.deadlineAt);
  return (
    <div className="card pulse">
      <div className="row between"><h2>New order</h2><span className={`timer ${left <= 10 ? "bad" : ""}`}>{mmss(left)}</span></div>
      <p className="muted">Open it to start picking. If you do not open it in time it goes to the next pharmacy.</p>
      <ul className="lines">{o.lines.map((l) => <li key={l.name}><b>{l.quantity}×</b> {l.name}</li>)}</ul>
      <div className="row between"><span>{o.lines.length} item{o.lines.length > 1 ? "s" : ""}{o.requiresRx ? " · prescription" : ""}</span><b>{money(o.total)}</b></div>
      <div className="row gap">
        <button className="btn primary big grow" onClick={() => openOrder(o.id)}>Open order</button>
        <button className="btn ghost" onClick={() => cantFulfil(o.id, "BUSY")}>Can't take it now</button>
      </div>
    </div>
  );
}

function RxViewer({ id, onClose }) {
  const [img, setImg] = useState(null); const [err, setErr] = useState(""); const [zoom, setZoom] = useState(false);
  useEffect(() => { api(`/api/companion/orders/${id}/rx`).then((r) => r.rxImage ? setImg(r.rxImage) : setErr("No prescription image was attached.")).catch((e) => setErr(e.message)); }, [id]);
  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-body wide" onClick={(e) => e.stopPropagation()}>
        <div className="row between"><h3>Prescription</h3><button className="btn ghost" onClick={onClose}>Close</button></div>
        {err ? <div className="alert bad">{err}</div> : img ? <img className={`rx ${zoom ? "zoom" : ""}`} src={img} alt="Prescription" onClick={() => setZoom(!zoom)} /> : <p className="muted">Loading…</p>}
        <p className="muted small">Click the image to zoom.</p>
      </div>
    </div>
  );
}

function Picking({ o }) {
  const { toggleTick, extend, cantFulfil, verifyRx, ready } = useHub();
  const left = useCountdown(o.deadlineAt);
  const [rx, setRx] = useState(false); const [oos, setOos] = useState(null); const [busy, setBusy] = useState(false);
  const rxOk = !o.requiresRx || o.rxStatus === "VERIFIED";
  const allTicked = o.lines.every((l) => o.ticked[l.name]);
  const canDispatch = rxOk && allTicked && !busy;
  const soft = left * 1000 <= o.pickTotalMs * 0.3;     // 70% of the time used

  useEffect(() => {
    const onKey = (e) => {
      if (/input|textarea/i.test(e.target.tagName) || rx || oos) return;
      if (e.code === "Space" && rxOk) { e.preventDefault(); const next = o.lines.find((l) => !o.ticked[l.name]); if (next) toggleTick(o.id, next.name); }
      if (e.code === "Enter" && canDispatch) { e.preventDefault(); go(); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  });
  const go = async () => { setBusy(true); await ready(o.id); setBusy(false); };

  return (
    <div className="card">
      <div className="row between">
        <h2>Pick this order</h2>
        <span className={`timer ${soft ? "warn" : ""} ${left <= 15 ? "bad" : ""}`}>{mmss(left)}</span>
      </div>
      {soft && <div className="alert warn row between">Time is running low. {!o.extended && <button className="btn small" onClick={() => extend(o.id)}>+2 minutes (once)</button>}</div>}
      {!soft && !o.extended && <div className="row end"><button className="btn ghost small" onClick={() => extend(o.id)}>+2 min</button></div>}

      {o.requiresRx && (
        <div className={`gate ${rxOk ? "ok" : ""}`}>
          <b>{rxOk ? "✓ Prescription verified" : "Prescription must be checked before picking"}</b>
          <div className="row gap">
            <button className="btn small" onClick={() => setRx(true)}>View prescription</button>
            {!rxOk && <><button className="btn primary small" onClick={() => verifyRx(o.id, "verified")}>✓ Prescription is valid</button>
              <button className="btn danger small" onClick={() => verifyRx(o.id, "rejected")}>✕ Invalid</button></>}
          </div>
        </div>
      )}

      <ul className={`pick ${rxOk ? "" : "locked"}`}>
        {o.lines.map((l) => (
          <li key={l.name} className={o.ticked[l.name] ? "done" : ""}>
            <div className="grow"><b>{l.quantity}×</b> {l.name}<div className="muted small">{money(l.price)} each{l.schedule && l.schedule !== "OTC" ? ` · ${l.schedule}` : ""}</div></div>
            {oos === l.name ? (
              <div className="row gap"><span className="small">Pass this order on?</span>
                <button className="btn danger small" onClick={() => cantFulfil(o.id, "OUT_OF_STOCK", [l.name])}>Yes, out of stock</button>
                <button className="btn ghost small" onClick={() => setOos(null)}>No</button></div>
            ) : (
              <div className="row gap">
                <button className={`btn small ${o.ticked[l.name] ? "primary" : ""}`} disabled={!rxOk} onClick={() => toggleTick(o.id, l.name)}>{o.ticked[l.name] ? "✅ Packed" : "Packed"}</button>
                <button className="btn ghost small" disabled={!rxOk} onClick={() => setOos(l.name)}>❌ Out of stock</button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="row between"><span className="muted">{o.lines.filter((l) => o.ticked[l.name]).length} of {o.lines.length} packed</span><b>{money(o.total)}</b></div>
      <button className="btn go big" disabled={!canDispatch} onClick={go}>🛵 Dispatch rider</button>
      <p className="muted small">Space ticks the next item · Enter dispatches. Pack every item first. If something is missing, tap Out of stock so the order reaches the next pharmacy quickly.</p>
      {rx && <RxViewer id={o.id} onClose={() => setRx(false)} />}
    </div>
  );
}

export default function Desk() {
  const { orders, selected, setSelected, paused, connected } = useHub();
  const list = Object.values(orders).sort((a, b) => a.receivedAt - b.receivedAt);
  const cur = selected && orders[selected];
  return (
    <div>
      {paused && <div className="alert warn">You are paused. New orders will not be sent to you. Orders already open are not affected.</div>}
      {!connected && <div className="alert bad">Not connected to SehatWaadi. You will not receive orders until the connection is back.</div>}
      {!list.length ? (
        <div className="empty"><div className="big-emoji">🔔</div><h2>Waiting for orders</h2><p className="muted">Keep this window open. It will ring when an order arrives.</p></div>
      ) : (
        <>
          {list.length > 1 && <div className="tabs">{list.map((o) => <button key={o.id} className={`tab ${o.id === selected ? "active" : ""} ${o.stage === "OFFERED" ? "ring" : ""}`} onClick={() => setSelected(o.id)}>#{o.id.slice(0, 4)} · {o.stage === "OFFERED" ? "new" : "picking"}</button>)}</div>}
          {cur && (cur.stage === "OFFERED" ? <Offered o={cur} /> : <Picking o={cur} />)}
        </>
      )}
    </div>
  );
}
