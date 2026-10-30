const LABEL = { connecting: "Connecting…", live: "Connected", offline: "Offline: not receiving orders", denied: "Key not accepted" };

export default function Header({ conn, paused, onPause, onLogout, desktop }) {
  const receiving = conn === "live" && !paused;
  return (
    <header className="topbar">
      <h1 className="brand">SehatWaadi <span>Companion</span></h1>
      <div className="topbar-right">
        <span className={`pill ${conn === "live" ? "ok" : conn === "connecting" ? "wait" : "bad"}`}>{LABEL[conn] || conn}</span>
        <span className={`pill ${receiving ? "ok" : "wait"}`}>{receiving ? "Shop ONLINE" : "Shop NOT taking orders"}</span>
        <button className={`btn ${paused ? "primary" : ""}`} onClick={() => onPause(!paused)}>{paused ? "Resume orders" : "Pause orders"}</button>
        <button className="btn ghost" onClick={onLogout} title="Disconnect this PC from the shop">Sign out</button>
      </div>
      {!desktop && <p className="hint banner-warn">Sound and the always-on-top alert work best in the installed Windows app. In a browser tab, keep this tab open.</p>}
    </header>
  );
}
