import { useState } from "react";
import { api } from "../api/client.js";
import { useHub } from "../hub/HubContext.jsx";
import QrModal from "./QrModal.jsx";
import { money } from "./useCountdown.js";

const STEPS = ["DISPATCHED", "ACCEPTED", "ARRIVED_AT_PHARMACY", "PICKED_UP"];
const NAME = { DISPATCHED: "Finding rider", ACCEPTED: "Rider on the way", ARRIVED_AT_PHARMACY: "Rider here", PICKED_UP: "Out for delivery", RETURNING_TO_PHARMACY: "Returning bag" };
const ISSUE = { VEHICLE_BREAKDOWN: "Vehicle breakdown", ACCIDENT: "Accident", CUSTOMER_UNREACHABLE: "Customer unreachable" };

export default function Fleet() {
  const { deliveries, refreshDeliveries, notify } = useHub();
  const [qr, setQr] = useState(null); const [busy, setBusy] = useState("");
  const act = async (d, path, body, after) => {
    setBusy(d.id);
    try { await api(`/api/delivery/${d.id}/${path}`, { method: "POST", body }); await refreshDeliveries(); after && after(); } catch (e) { notify(e.message, "bad"); }
    setBusy("");
  };
  if (!deliveries.length) return <div className="empty"><div className="big-emoji">🛵</div><h2>No active deliveries</h2><p className="muted">Riders you dispatch will appear here.</p></div>;
  return (
    <div className="grid">
      {deliveries.map((d) => (
        <div className={`card ${d.issue_type ? "sos" : ""}`} key={d.id}>
          <div className="row between"><b>Order #{String(d.order_id).slice(0, 8)}</b><span className="chip">{NAME[d.status] || d.status}</span></div>
          <div className="steps">{STEPS.map((s, i) => <i key={s} className={STEPS.indexOf(d.status) >= i ? "on" : ""} />)}</div>
          {d.riders ? <p>{d.riders.full_name} · <a href={`tel:${d.riders.phone}`}>{d.riders.phone}</a><br /><span className="muted">{d.riders.vehicle_number || "—"}</span></p> : <p className="muted">No rider yet. One is assigned as soon as a rider is online.</p>}
          <div className="muted small">{d.payment_mode} · {money(d.order_subtotal)}</div>
          {d.issue_type && (
            <div className="alert bad">
              <b>{ISSUE[d.issue_type] || d.issue_type}</b>{d.issue_notes ? ` — ${d.issue_notes}` : ""}
              {d.issue_type === "CUSTOMER_UNREACHABLE"
                ? <div className="row gap"><button className="btn danger small" disabled={busy === d.id} onClick={() => act(d, "return", { reason: "CUSTOMER_UNREACHABLE" }, () => setQr({ kind: "return", deliveryId: d.id }))}>↩ Start return</button></div>
                : <div className="row gap"><button className="btn danger small" disabled={busy === d.id} onClick={() => act(d, "reassign", { reason: d.issue_type })}>🔄 Reassign nearest rider</button></div>}
            </div>
          )}
          <div className="row gap">
            {["DISPATCHED", "ACCEPTED", "ARRIVED_AT_PHARMACY"].includes(d.status) && <button className="btn small" onClick={() => setQr({ kind: "pickup", deliveryId: d.id })}>Show pickup QR</button>}
            {d.status === "RETURNING_TO_PHARMACY" && <button className="btn small" onClick={() => setQr({ kind: "return", deliveryId: d.id })}>Show return QR</button>}
          </div>
        </div>
      ))}
      {qr && <QrModal kind={qr.kind} deliveryId={qr.deliveryId} onClose={() => setQr(null)} />}
    </div>
  );
}
