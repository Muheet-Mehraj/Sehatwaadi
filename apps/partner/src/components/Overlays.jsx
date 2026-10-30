import { useRider } from "../contexts/RiderContext.jsx";
import { useOnline } from "../hooks/useOnline.js";
import { Button, Money } from "./ui.jsx";

export function NewJobOverlay() {
  const { newJob, order, actions } = useRider();
  if (!newJob || !order) return null;
  return (
    <div className="overlay alert" role="alertdialog" aria-label="New order"><div className="sheet">
      <h2>New order assigned</h2>
      <p className="big"><Money v={order.earnings} /></p>
      <p><b>{order.pharmacy?.name}</b><br /><span className="muted">{order.pharmacy?.address}</span></p>
      <p className="muted">Drop-off: {order.customer?.area || order.customer?.landmark || "customer location"} · {order.items.length} item{order.items.length === 1 ? "" : "s"}</p>
      {order.payment?.mode === "CASH" && !order.payment.verified && <p className="note warn">Cash on delivery: collect <Money v={order.cashToCollect} /></p>}
      <Button onClick={actions.dismissNewJob}>Start</Button>
    </div></div>
  );
}

export function SyncBar() {
  const online = useOnline(); const { loc } = useRider();
  if (online && !loc.lastError) return null;
  return <div className="syncbar">{online ? "Weak connection: retrying…" : "You're offline"}{loc.pending > 0 ? ` · ${loc.pending} points queued` : ""}</div>;
}

export function CompletedOverlay() {
  const { result, job, actions } = useRider();
  if (!result || job) return null;
  return null; // the dashboard shows the result banner; kept as an extension point
}
