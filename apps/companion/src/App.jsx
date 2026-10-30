import { useEffect, useState } from "react";
import Login from "./components/Login.jsx";
import Header from "./components/Header.jsx";
import OrderList from "./components/OrderList.jsx";
import PickWorkspace from "./components/PickWorkspace.jsx";
import HandoverModal from "./components/HandoverModal.jsx";
import Deliveries from "./components/Deliveries.jsx";
import Settlements from "./components/Settlements.jsx";
import Shelf from "./components/Shelf.jsx";
import Photos from "./components/Photos.jsx";
import Payouts from "./components/Payouts.jsx";
import { useHub } from "./hooks/useHub.js";
import { load, save, remove, CONFIG_KEY } from "./lib/storage.js";

export default function App() {
  const [config, setConfig] = useState(() => load(CONFIG_KEY, null));
  if (!config) return <Login onSave={(c) => { save(CONFIG_KEY, c); setConfig(c); }} />;
  return <Terminal config={config} onLogout={() => { remove(CONFIG_KEY); setConfig(null); }} />;
}

function Terminal({ config, onLogout }) {
  const hub = useHub(config);
  const [tab, setTab] = useState("orders");
  const [selected, setSelected] = useState(null);
  const [handover, setHandover] = useState(null);   // {orderId, dispatchResult}
  const orderIds = Object.keys(hub.orders);

  // keep a valid selection: the first order that has not been opened, else the first one
  useEffect(() => {
    if (selected && hub.orders[selected]) return;
    const first = Object.values(hub.orders).find((o) => !o.pickingStarted) || Object.values(hub.orders)[0];
    setSelected(first ? first.orderId : null);
  }, [hub.orders, selected]);

  if (hub.conn === "denied") {
    return <main className="login"><div className="card login-card"><h2>Key not accepted</h2><p>The Hub no longer accepts this pharmacy key. Ask SehatWaadi for a new one, then sign in again.</p><button className="btn primary" onClick={onLogout}>Sign in again</button></div></main>;
  }

  const current = selected ? hub.orders[selected] : null;
  const tabs = [["orders", `Orders${orderIds.length ? ` (${orderIds.length})` : ""}`], ["deliveries", `Deliveries${hub.deliveries.length ? ` (${hub.deliveries.length})` : ""}`], ["earnings", "Earnings"], ["payout", "Settlement"], ["shelf", "Shelf"], ["photos", "Photos"]];

  return (
    <div className="shell">
      <Header conn={hub.conn} paused={hub.paused} onPause={hub.setPaused} onLogout={onLogout} desktop={Boolean(window.companion)} />
      {hub.sos.length > 0 && (
        <button className="sosbar" onClick={() => setTab("deliveries")}>⚠ {hub.sos.length} delivery problem{hub.sos.length === 1 ? "" : "s"}: a rider needs help. Tap to open.</button>
      )}
      <nav className="tabs" role="tablist">{tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>)}</nav>
      <div className="toasts" aria-live="polite">{hub.notices.map((n) => <div key={n.id} className={`toast ${n.kind}`} onClick={() => hub.dismiss(n.id)}>{n.text}</div>)}</div>

      <main className="content">
        {tab === "orders" && (
          <div className="split">
            <aside><OrderList orders={hub.orders} selectedId={selected} onSelect={setSelected} /></aside>
            <div>{current ? <PickWorkspace key={current.orderId} hub={hub} order={current} onDispatched={(orderId, dispatchResult) => { setHandover({ orderId, dispatchResult }); hub.refreshDeliveries(); }} /> : <div className="empty card"><p>Select an order.</p></div>}</div>
          </div>
        )}
        {tab === "deliveries" && <Deliveries hub={hub} onShowPickup={(orderId) => setHandover({ orderId, dispatchResult: null })} />}
        {tab === "earnings" && <Settlements hub={hub} />}
        {tab === "payout" && <Payouts hub={hub} />}
        {tab === "shelf" && <Shelf hub={hub} />}
        {tab === "photos" && <Photos hub={hub} />}
      </main>
      {handover && <HandoverModal hub={hub} orderId={handover.orderId} dispatchResult={handover.dispatchResult} onClose={() => setHandover(null)} />}
    </div>
  );
}
