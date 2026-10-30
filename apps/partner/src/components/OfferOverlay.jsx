import { useEffect, useState } from "react";
import { useRider } from "../contexts/RiderContext.jsx";
import { ENDED_TEXT, fractionLeft, remainingMs, remainingSeconds } from "../services/offers.js";
import { formatKm } from "../services/geo.js";
import { Button, ErrorNote, Money } from "./ui.jsx";

// Re-render a few times a second while an offer is open so the countdown stays honest.
function useNow(active, ms = 250) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!active) return undefined; setNow(Date.now()); const i = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(i); }, [active, ms]);
  return now;
}

// An incoming order OFFER: a short countdown, the facts needed to decide, Accept / Decline. Nothing here assigns the order: only the
// server's "ok" to accept does (RiderContext then swaps this screen for the job). The offer deliberately carries no customer details.
export function OfferOverlay() {
  const { offer, offerEnded, offerBusy, error, job, actions } = useRider();
  const now = useNow(!!offer);
  const left = offer ? remainingMs(offer.deadlineMs, now) : 0;
  useEffect(() => { if (offer && left <= 0) actions.offerLapsed(); }, [offer, left, actions]);          // our own clock ran out: close it
  useEffect(() => { if (!offerEnded) return undefined; const t = setTimeout(actions.dismissOfferEnded, 6000); return () => clearTimeout(t); }, [offerEnded, actions]);
  if (job) return null;

  if (offer && left > 0) {
    const secs = remainingSeconds(offer.deadlineMs, now); const low = secs <= 5;
    const toPharmacy = Number(offer.pickupDistanceKm), trip = Number(offer.tripKm);
    return (
      <div className="overlay alert offer" role="alertdialog" aria-label="New order offer"><div className="sheet">
        <div className="offer-top"><h2>New order</h2><b className={`offer-secs ${low ? "low" : ""}`} aria-label={`${secs} seconds left`}>{secs}s</b></div>
        <div className="bar offer-bar" aria-hidden="true"><i className={low ? "low" : ""} style={{ width: `${Math.round(fractionLeft(offer, now) * 100)}%` }} /></div>
        <p className="big"><Money v={offer.earnings} /></p>
        <p><b>{offer.pharmacy?.name}</b><br /><span className="muted">{offer.pharmacy?.address}</span></p>
        <p className="muted">{Number.isFinite(toPharmacy) ? `${formatKm(toPharmacy)} to the pharmacy` : ""}{Number.isFinite(trip) && trip > 0 ? ` · ${formatKm(trip)} delivery` : ""}</p>
        <p className="muted">Drop-off area: {offer.dropArea || "customer location"}</p>
        {offer.requiresPrescription && <p className="note info">Prescription order: keep the bag sealed until the customer verifies the code.</p>}
        {offer.paymentMode === "CASH" && Number(offer.cashToCollect) > 0 && <p className="note warn">Cash on delivery: you'll collect <Money v={offer.cashToCollect} /></p>}
        <ErrorNote text={error} onClose={actions.clearError} />
        <div className="row">
          <Button kind="ghost" disabled={offerBusy} onClick={actions.declineOffer}>Decline</Button>
          <Button busy={offerBusy} disabled={left <= 0} onClick={actions.acceptOffer}>Accept</Button>
        </div>
      </div></div>
    );
  }
  if (offerEnded) {
    return <div className="offer-toast" role="status">{ENDED_TEXT[offerEnded]} <button className="link" onClick={actions.dismissOfferEnded}>OK</button></div>;
  }
  return null;
}
