import { useEffect, useState } from "react";
import { useRider } from "../contexts/RiderContext.jsx";
import { Button, Card, ErrorNote, Money } from "./ui.jsx";
import Wallet, { CashMeter, DepositSheet } from "./Wallet.jsx";
import Profile from "./Profile.jsx";
import { cashStatus, deliveredMessage, earningsView } from "../services/wallet.js";

export default function Dashboard({ onSignOut }) {
  const { rider, actions, busy, error, api, loc, stale, result, notice } = useRider();
  const [history, setHistory] = useState([]); const [settle, setSettle] = useState(false); const [wallet, setWallet] = useState(false); const [profile, setProfile] = useState(false); const [sum, setSum] = useState(null);
  useEffect(() => { let on = true; api.getRecentDeliveries(15).then((r) => on && r.ok && setHistory(r.rows)); return () => { on = false; }; }, [api, result, rider?.earningsBalance]);
  useEffect(() => { let on = true; if (api.getMyEarnings) api.getMyEarnings().then((r) => on && r.ok && setSum(r)); return () => { on = false; }; }, [api, result, rider?.earningsBalance, rider?.cashInHand]);
  const earnedToday = earningsView(sum, "today");
  const online = rider.status === "ONLINE";
  const cs = cashStatus(rider);
  if (wallet) return <Wallet onBack={() => setWallet(false)} />;
  if (profile) return <Profile onBack={() => setProfile(false)} />;
  return (
    <main className="screen">
      <header className="top"><div><b>{rider.fullName}</b><small className="muted"> · {rider.vehicleType.toLowerCase()} {rider.vehicleNumber || ""}</small></div><button className="link" onClick={onSignOut}>Sign out</button></header>
      <ErrorNote text={error} onClose={actions.clearError} />
      {stale && <div className="note warn">Offline: showing your last known status.</div>}
      {notice && <div className="note info">{notice} <button className="link" onClick={actions.clearNotice}>OK</button></div>}
      {result && <div className="note ok">{deliveredMessage(result)} <button className="link" onClick={actions.dismissResult}>OK</button></div>}
      <Card className={`status ${online ? "on" : "off"}`}>
        <div className="row between"><div><h2>{online ? "You're online" : "You're offline"}</h2><p className="muted">{online ? "You'll be alerted when an order is available. Keep this screen open." : "Go online to receive orders."}</p></div>
          <label className="toggle"><input type="checkbox" checked={online} disabled={busy} onChange={(e) => actions.setOnline(e.target.checked)} aria-label="Online" /><i /></label></div>
        {online && <p className="muted small">GPS: {loc.geoStatus === "ok" ? "good" : loc.geoStatus === "denied" ? "blocked: allow location access" : loc.geoStatus === "acquiring" ? "searching…" : "unavailable"}{loc.pending > 0 ? ` · ${loc.pending} points waiting to sync` : ""}</p>}
      </Card>
      <Card title="Wallet">
        <div className="grid2">
          {earnedToday
            ? <div><small className="muted">You earned today</small><div className="big"><Money v={earnedToday.total} /></div><small className="muted">{earnedToday.deliveries} {earnedToday.deliveries === 1 ? "delivery" : "deliveries"}</small></div>
            : <div><small className="muted">SehatWaadi will pay you</small><div className="big"><Money v={rider.earningsBalance} /></div></div>}
          <div><small className="muted">Cash in hand</small><div className="big"><Money v={rider.cashInHand} /></div><small className="muted">to give SehatWaadi</small></div></div>
        <CashMeter rider={rider} />
        <div className="row"><Button kind={cs.level === "ok" ? "ghost" : "primary"} disabled={!cs.canSettle} onClick={() => setSettle(true)}>Deposit cash</Button><Button kind="ghost" onClick={() => setWallet(true)}>Wallet &amp; history</Button></div>
      </Card>
      <Card title="Recent deliveries">
        {history.length === 0 ? <p className="muted">Nothing yet.</p> : <ul className="list">{history.map((h) => <li key={h.id}><span>{new Date(h.delivered_at || h.returned_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span><span className="muted">{h.status === "RETURNED" ? "Returned" : h.payment_mode}</span><b>{h.status === "DELIVERED" ? <Money v={h.estimated_earnings} /> : "–"}</b></li>)}</ul>}
      </Card>
      <Button kind="ghost" onClick={() => setProfile(true)}>Profile &amp; documents</Button>
      {settle && <DepositSheet rider={rider} onClose={() => setSettle(false)} />}
    </main>
  );
}
