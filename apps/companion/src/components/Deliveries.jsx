import { useState } from "react";
import { extractQr } from "../lib/qr.js";
import QRCode from "qrcode";
import { searchState } from "../lib/dispatchState.js";

const STEPS = ["DISPATCHED", "ACCEPTED", "ARRIVED_AT_PHARMACY", "PICKED_UP"];
const ISSUE = { VEHICLE_BREAKDOWN: "Vehicle breakdown", ACCIDENT: "Accident", CUSTOMER_UNREACHABLE: "Customer unreachable" };
const nice = (s) => String(s || "").replaceAll("_", " ").toLowerCase();

export default function Deliveries({ hub, onShowPickup }) {
  const { api, deliveries, refreshDeliveries, notify } = hub;
  const [busy, setBusy] = useState("");
  const [returnQr, setReturnQr] = useState(null);   // {img, deliveryId}

  async function act(label, fn) {
    setBusy(label);
    try { await fn(); refreshDeliveries(); } catch (e) { notify(e.message, "warn"); } finally { setBusy(""); }
  }
  const reassign = (d) => act(`re${d.id}`, async () => { await api.reassign(d.id, "REASSIGNED_BY_PHARMACY"); notify("Looking for another rider."); });
  const startReturn = (d) => act(`ret${d.id}`, async () => {
    if (!window.confirm("Start a return? The rider brings the sealed bag back and scans your return code.")) return;
    await api.initiateReturn(d.id, d.issue_type || "CUSTOMER_UNREACHABLE");
    await showReturn(d);
  });
  async function showReturn(d) {
    const code = extractQr(await api.returnQr(d.id), d.id);
    if (!code) throw new Error("The Hub did not return a valid return code.");
    setReturnQr({ deliveryId: d.id, img: await QRCode.toDataURL(code, { margin: 2, width: 360 }) });
  }

  if (!deliveries.length) return <div className="empty card"><p>No active deliveries.</p></div>;
  return (
    <>
      <ul className="deliveries">
        {deliveries.map((d) => {
          const r = d.riders; const step = STEPS.indexOf(d.status); const ss = searchState(d);
          return (
            <li key={d.id} className={`card delivery ${d.issue_type ? "sos" : ""}`}>
              <div className="d-head">
                <b>Order {String(d.order_id).slice(0, 8)}</b>
                <span className="tag">{nice(d.status)}</span>
                <span className="num">₹{Number(d.order_subtotal || 0).toFixed(2)}</span>
              </div>
              <ol className="steps">{STEPS.map((s, i) => <li key={s} className={i <= step ? "on" : ""}>{nice(s)}</li>)}</ol>
              <p>{r ? <><b>{r.full_name}</b> · {r.vehicle_number || "—"} · <a href={`tel:${r.phone}`}>{r.phone}</a></> : <span className={ss?.kind === "none" ? "warn-text" : "muted"}>{ss ? ss.text : "Waiting for a rider…"}</span>}</p>
              {d.issue_type && (
                <div className="sosbox" role="alert">
                  <b>⚠ {ISSUE[d.issue_type] || d.issue_type}</b>{d.issue_notes ? ` — ${d.issue_notes}` : ""}
                  <div className="actions">
                    {d.issue_type !== "CUSTOMER_UNREACHABLE" && <button className="btn" disabled={Boolean(busy)} onClick={() => reassign(d)}>Send another rider</button>}
                    <button className="btn danger" disabled={Boolean(busy)} onClick={() => startReturn(d)}>Start return</button>
                  </div>
                </div>
              )}
              {!d.issue_type && ["DISPATCHED", "ACCEPTED", "ARRIVED_AT_PHARMACY"].includes(d.status) && <div className="actions"><button className="btn" onClick={() => onShowPickup(d.order_id)}>Show pickup code</button></div>}
              {d.status === "RETURNING_TO_PHARMACY" && <div className="actions"><button className="btn" onClick={() => act("rq", () => showReturn(d))}>Show return code</button></div>}
            </li>
          );
        })}
      </ul>
      {returnQr && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="card modal-card handover">
            <h2>Return code</h2>
            <img className="qr" src={returnQr.img} alt="Return QR code" />
            <p className="muted center">When the rider brings the sealed bag back, let them scan this code. Check the seal before you accept it.</p>
            <div className="actions"><button className="btn primary" onClick={() => setReturnQr(null)}>Done</button></div>
          </div>
        </div>
      )}
    </>
  );
}
