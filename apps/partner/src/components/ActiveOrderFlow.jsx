import { useEffect, useRef, useState } from "react";
import { useRider } from "../contexts/RiderContext.jsx";
import { STEPS, STEP_TITLE, CANCEL_REASONS, canRiderCancel, destinationFor, issueOptionsFor, isValidOtp } from "../services/deliveryMachine.js";
import { compressImage, formatKm, haversineKm, mapsLink, telLink } from "../services/geo.js";
import { Button, Card, ErrorNote, Money, OtpKeypad, SwipeButton } from "./ui.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";
import { useBackHandler } from "../hooks/useBackHandler.js";
import LiveMap from "./LiveMap.jsx";
import QrScanner from "./QrScanner.jsx";

const ISSUE_TEXT = { VEHICLE_BREAKDOWN: "Vehicle breakdown", ACCIDENT: "Accident / emergency", CUSTOMER_UNREACHABLE: "Customer unreachable" };
const ORDER = [STEPS.EN_ROUTE_TO_PHARMACY, STEPS.PICKUP_VERIFICATION, STEPS.EN_ROUTE_TO_CUSTOMER, STEPS.DROPOFF_OTP];

function IssueSheet({ step, onClose }) {
  const { actions, busy, error } = useRider();
  const [type, setType] = useState(""); const [notes, setNotes] = useState(""); const [done, setDone] = useState(null);
  useBackHandler(true, onClose);
  return (
    <div className="overlay"><div className="sheet">
      <h3>Report a problem</h3>
      {done ? (<><div className="note ok">The pharmacy has been alerted and will arrange help.</div>
        {done.pharmacyPhone && <a className="btn primary" href={telLink(done.pharmacyPhone)}>Call pharmacy</a>}<Button kind="ghost" onClick={onClose}>Close</Button></>) : (<>
        <ErrorNote text={error} onClose={actions.clearError} />
        {issueOptionsFor(step).map((t) => <label key={t} className="radio"><input type="radio" name="issue" checked={type === t} onChange={() => setType(t)} /> {ISSUE_TEXT[t]}</label>)}
        <label className="field"><span>Details (optional)</span><textarea maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <div className="row"><Button kind="ghost" onClick={onClose}>Cancel</Button><Button busy={busy} disabled={!type} onClick={async () => { const r = await actions.reportIssue(type, notes); if (r.ok) setDone(r); }}>Send alert</Button></div></>)}
    </div></div>
  );
}

// Before pickup only. The reason is required (it is kept in the audit trail); the order goes back to other riders.
function CancelSheet({ onClose }) {
  const { actions, busy, error } = useRider();
  const [reason, setReason] = useState(""); const [notes, setNotes] = useState("");
  useBackHandler(true, onClose);
  return (
    <div className="overlay"><div className="sheet">
      <h3>Cancel this order?</h3>
      <p className="muted small">It goes back to other riders. Only cancel if you truly can't do it. After you collect the medicines you can't cancel here: use Report a problem.</p>
      <ErrorNote text={error} onClose={actions.clearError} />
      {CANCEL_REASONS.map(([code, text]) => <label key={code} className="radio"><input type="radio" name="cancel-reason" checked={reason === code} onChange={() => setReason(code)} /> {text}</label>)}
      <label className="field"><span>Details (optional)</span><textarea maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <div className="row"><Button kind="ghost" onClick={onClose}>Keep order</Button><Button kind="danger" busy={busy} disabled={!reason} onClick={async () => { const r = await actions.cancelDelivery(reason, notes); if (r.ok) onClose(); }}>Cancel order</Button></div>
    </div></div>
  );
}

function Dropoff() {
  const { order, plan, actions, busy, error } = useRider();
  const [otp, setOtp] = useState(""); const [photo, setPhoto] = useState(null); const [photoErr, setPhotoErr] = useState(""); const file = useRef(null);
  const needPhoto = !!order.requiresPrescription;
  const [collected, setCollected] = useState(false);   // the rider confirms the cash is in hand before the order can be completed
  const cashGate = plan.needsCash && plan.collect > 0;
  const pick = async (e) => { const f = e.target.files?.[0]; if (!f) return; try { setPhoto(await compressImage(f)); setPhotoErr(""); } catch { setPhotoErr("Couldn't read that photo. Try again."); } };
  return (<>
    <div className={`note ${plan.needsCash ? "warn" : "ok"}`}><b>{plan.label}</b>{plan.needsCash && order.payment?.mode !== "CASH" && " (UPI not confirmed yet)"}</div>
    {cashGate && <button type="button" className={`cashgate ${collected ? "on" : ""}`} onClick={() => setCollected((v) => !v)} aria-pressed={collected}><span>{collected ? "✓" : ""}</span>I have collected <Money v={plan.collect} /> in cash</button>}
    {!plan.needsCash && <p className="muted small">Payment is already confirmed. Only the customer's code is needed.</p>}
    <p className="muted">Ask the customer for their 4-digit delivery code.</p>
    <OtpKeypad value={otp} onChange={setOtp} disabled={busy} />
    <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={pick} />
    <Button kind="ghost" onClick={() => file.current.click()}>{photo ? "Retake delivery photo ✓" : needPhoto ? "Take delivery photo (required)" : "Take delivery photo (optional)"}</Button>
    <ErrorNote text={photoErr || error} onClose={actions.clearError} />
    <Button busy={busy} disabled={!isValidOtp(otp) || (needPhoto && !photo) || (cashGate && !collected)} onClick={async () => { const r = await actions.completeDelivery({ otp, proofBlob: photo }); if (!r.ok) setOtp(""); }}>Complete delivery</Button>
  </>);
}

export default function ActiveOrderFlow() {
  const { order, step, job, loc, actions, busy, error, stale } = useRider();
  const [scan, setScan] = useState(null); const [issue, setIssue] = useState(false); const [items, setItems] = useState(false); const [cancel, setCancel] = useState(false);
  useEffect(() => { setScan(null); }, [step]);
  useBackHandler(!!scan && !issue, () => setScan(null));
  const dest = destinationFor(step, order); const here = loc.fix;
  const km = here && dest?.lat != null ? haversineKm(here, dest) : null;
  const returning = step === STEPS.RETURNING_TO_PHARMACY;
  return (
    <main className="screen">
      <header className="top"><div><small className="muted">Order</small><h2>{STEP_TITLE[step]}</h2></div><div className="earn">+<Money v={order.earnings} /></div></header>
      {!returning && <div className="steps">{ORDER.map((s, i) => <i key={s} className={ORDER.indexOf(step) >= i ? "done" : ""} />)}</div>}
      {stale && <div className="note warn">No signal: showing the last known order. Actions will work when you're back online.</div>}
      {loc.pending > 0 && <div className="note info">{loc.pending} GPS points saved offline, will sync automatically.</div>}
      {job?.status && order.issue && <div className="note warn">Problem reported: {ISSUE_TEXT[order.issue.type] || order.issue.type}. Help is on the way.</div>}
      <ErrorBoundary name="map" fallback={<div className="note info">Map unavailable. Use Navigate below.</div>}>
        <LiveMap rider={here} pharmacy={order.pharmacy} customer={step === STEPS.EN_ROUTE_TO_CUSTOMER || step === STEPS.DROPOFF_OTP ? order.customer : null} />
      </ErrorBoundary>
      <Card>
        <div className="row between"><div><small className="muted">{dest.kind === "pharmacy" ? (returning ? "Return to" : "Pickup") : "Drop-off"}</small><h3>{dest.label}</h3></div>{km != null && <b>{formatKm(km)}</b>}</div>
        <p>{dest.address}{dest.landmark ? ` · ${dest.landmark}` : ""}</p>
        <div className="row">{dest.lat != null && <a className="btn ghost" href={mapsLink(dest.lat, dest.lng)} target="_blank" rel="noreferrer">Navigate</a>}{dest.phone && <a className="btn ghost" href={telLink(dest.phone)}>Call</a>}</div>
      </Card>
      <ErrorNote text={step === STEPS.DROPOFF_OTP ? "" : error} onClose={actions.clearError} />

      {step === STEPS.EN_ROUTE_TO_PHARMACY && <SwipeButton label="Swipe: I've reached the pharmacy" busy={busy} onConfirm={actions.arrivedAtPharmacy} />}
      {step === STEPS.PICKUP_VERIFICATION && (<>
        <p className="muted">Ask the pharmacist to open the pickup QR on their screen, then scan it. Check the sealed bag matches the order.</p>
        <Button onClick={() => setScan("pickup")}>Scan pickup QR</Button>
      </>)}
      {step === STEPS.EN_ROUTE_TO_CUSTOMER && (<>
        <p className="muted">Collect nothing at the pharmacy. The medicines are already paid for or collected from the customer at the door.</p>
        <SwipeButton label="Swipe: I've reached the customer" busy={busy} onConfirm={actions.arrivedAtCustomer} />
      </>)}
      {step === STEPS.DROPOFF_OTP && <Dropoff />}
      {returning && (<><div className="note warn">Take the sealed bag back to the pharmacy and scan their return QR.</div><Button onClick={() => setScan("return")}>Scan return QR</Button></>)}

      <Card><button className="link" onClick={() => setItems(!items)}>{items ? "Hide" : "Show"} items ({order.items.length})</button>
        {items && <ul className="list">{order.items.map((i, k) => <li key={k}><span>{i.name}</span><b>× {i.qty}</b></li>)}</ul>}
        {order.requiresPrescription && <p className="muted small">Prescription order. Keep the bag sealed until the customer verifies the code.</p>}</Card>
      {canRiderCancel(step) && <Button kind="ghost" onClick={() => setCancel(true)}>Can't take this order? Cancel</Button>}
      <Button kind="danger" onClick={() => setIssue(true)}>Report a problem / SOS</Button>

      {scan && <QrScanner title={scan === "pickup" ? "Scan pharmacy pickup QR" : "Scan return QR"} onCancel={() => setScan(null)}
        onResult={async (qr) => { const r = scan === "pickup" ? await actions.scanPickup(qr) : await actions.confirmReturn(qr); if (r.ok || r.error !== "network") setScan(null); }} />}
      {issue && <IssueSheet step={step} onClose={() => setIssue(false)} />}
      {cancel && <CancelSheet onClose={() => setCancel(false)} />}
    </main>
  );
}
