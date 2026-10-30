import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api, findQr } from "../api/client.js";
import { useHub } from "../hub/HubContext.jsx";
import { money } from "./useCountdown.js";

const LABEL = { DISPATCHED: "Waiting for a rider", ACCEPTED: "Rider is on the way", ARRIVED_AT_PHARMACY: "Rider has arrived", PICKED_UP: "Picked up", RETURNING_TO_PHARMACY: "Rider returning with the bag" };

// Shows the single-use QR the rider scans on this screen (pickup) or when bringing the bag back (return).
// The Hub issues the token; this component only displays it and keeps it fresh in case it is rotated (rider reassigned).
export default function QrModal({ kind = "pickup", deliveryId, orderId, slip, onClose }) {
  const { deliveries, refreshDeliveries } = useHub();
  const d = deliveries.find((x) => (deliveryId ? x.id === deliveryId : x.order_id === orderId));
  const [qr, setQr] = useState(null); const [err, setErr] = useState("");

  useEffect(() => { if (d) return undefined; const t = setInterval(refreshDeliveries, 3000); refreshDeliveries(); return () => clearInterval(t); }, [d, refreshDeliveries]);
  useEffect(() => {
    if (!d) return undefined;
    let stop = false;
    const load = async () => {
      try { const r = await api(`/api/delivery/${d.id}/${kind === "return" ? "return-qr" : "pickup-qr"}`); const f = findQr(r, d.id); if (!stop) { setQr(f); setErr(f ? "" : "The server did not return a QR code yet."); } }
      catch (e) { if (!stop) setErr(e.message); }
    };
    load(); const t = setInterval(load, 8000); return () => { stop = true; clearInterval(t); };
  }, [d && d.id, kind]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-body" onClick={(e) => e.stopPropagation()}>
        <div className="row between no-print"><h3>{kind === "return" ? "Return QR" : "Rider pickup QR"}</h3><button className="btn ghost" onClick={onClose}>Close</button></div>
        {!d ? <p className="muted no-print">Finding a rider…</p> : (
          <>
            <div className="qrbox"><div className="qrframe">{qr ? <QRCodeSVG value={qr} size={280} level="M" marginSize={2} /> : <p className="muted">{err || "Preparing the QR…"}</p>}</div></div>
            <p className="center-text no-print"><b>{LABEL[d.status] || d.status}</b></p>
            {d.riders && <p className="center-text muted no-print">{d.riders.full_name} · {d.riders.phone}{d.riders.vehicle_number ? ` · ${d.riders.vehicle_number}` : ""}</p>}
            <p className="center-text muted small no-print">{kind === "return" ? "The rider scans this when bringing the sealed bag back." : "Hold the rider's phone camera to this screen. Give the bag only after the scan is confirmed in their app."}</p>
            {err && qr && <div className="alert warn no-print">{err}</div>}
            <div className="row gap center-row no-print">{slip && <button className="btn" onClick={() => window.print()}>🖨 Print 80mm slip</button>}</div>
            {slip && qr && (
              <div className="slip">
                <h4>SehatWaadi · Order #{String(orderId || d.order_id).slice(0, 8)}</h4>
                <table><tbody>{slip.lines.map((l) => <tr key={l.name}><td>{l.quantity}×</td><td>{l.name}</td><td>{money((Number(l.price) || 0) * l.quantity)}</td></tr>)}</tbody></table>
                <div className="slip-total"><span>Total</span><b>{money(slip.total)}</b></div>
                <div className="slip-qr"><QRCodeSVG value={qr} size={170} level="M" marginSize={1} /></div>
                <p>Rider: scan to collect.</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
