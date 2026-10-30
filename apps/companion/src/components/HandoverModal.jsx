import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { searchState } from "../lib/dispatchState.js";
import { extractQr } from "../lib/qr.js";

// Shows the pickup QR the rider scans from this screen. Finds the delivery the Hub created for the order, shows the rider
// once assigned, and refreshes the code if the rider is reassigned (the Hub rotates the token).
export default function HandoverModal({ hub, orderId, dispatchResult, onClose }) {
  const { api, deliveries, refreshDeliveries, notify } = hub;
  const delivery = deliveries.find((d) => d.order_id === orderId);
  const [qr, setQr] = useState(null);
  const [img, setImg] = useState("");
  const [err, setErr] = useState(dispatchResult && dispatchResult.ok === false ? dispatchResult.error : "");
  const [retrying, setRetrying] = useState(false);
  const stamp = delivery ? `${delivery.id}:${delivery.rider_id || "none"}:${delivery.status}` : "none";

  useEffect(() => { refreshDeliveries(); const t = setInterval(refreshDeliveries, 4000); return () => clearInterval(t); }, [refreshDeliveries]);
  useEffect(() => {
    if (!delivery) return;
    let live = true;
    api.pickupQr(delivery.id).then((r) => { if (!live) return; const code = extractQr(r, delivery.id); setQr(code); if (!code) setErr("The Hub did not return a valid pickup code."); else setErr(""); }).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (qr) QRCode.toDataURL(qr, { margin: 2, width: 360, errorCorrectionLevel: "M" }).then(setImg).catch(() => setImg("")); else setImg(""); }, [qr]);

  async function retry() {
    setRetrying(true);
    try { const r = await api.retryDispatch(orderId); if (r.ok === false) throw new Error(r.error || "Could not assign a rider."); setErr(""); refreshDeliveries(); }
    catch (e) { setErr(e.message); notify(e.message, "warn"); } finally { setRetrying(false); }
  }

  const rider = delivery && delivery.riders;
  const waiting = !rider; const ss = searchState(delivery);
  return (
    <div className="modal" role="dialog" aria-modal="true">
      <div className="card modal-card handover">
        <h2>Hand over to the rider</h2>
        {waiting ? <p className="banner-wait">{ss ? ss.text : "Finding the nearest rider… the order is queued and a rider is assigned as soon as one is online."}</p>
          : <p><b>{rider.full_name}</b> · {rider.vehicle_number || "vehicle not listed"} · <a href={`tel:${rider.phone}`}>{rider.phone}</a><br /><span className="muted">Status: {String(delivery.status).replaceAll("_", " ").toLowerCase()}</span></p>}
        {img ? <img className="qr" src={img} alt="Pickup QR code for the rider" /> : <div className="qr placeholder">{delivery ? "Getting the code…" : "Waiting for the delivery to be created…"}</div>}
        <p className="muted center">Let the rider scan this code with the rider app when they arrive. Pack the bag and keep the bill with it.</p>
        {err && <p className="error" role="alert">{err} <button className="btn small" onClick={retry} disabled={retrying}>{retrying ? "Retrying…" : "Retry rider assignment"}</button></p>}
        <div className="actions">
          <button className="btn" onClick={() => window.print()} disabled={!img}>🖨 Print slip</button>
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
        <div className="print-only slip"><h3>SehatWaadi pickup slip</h3>{img && <img src={img} alt="" />}<p>Order {String(orderId).slice(0, 8)}</p></div>
      </div>
    </div>
  );
}
