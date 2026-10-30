import { useEffect, useMemo, useState } from "react";
import { canDispatch, packedNames, keyOf, stageOf, secondsLeft, timerState, mmss } from "../lib/pickLogic.js";
import { load, save, remove, ticksKey } from "../lib/storage.js";
import { useNow } from "./OrderList.jsx";

// One order, start to finish: OFFERED (summary) -> PICKING (prescription check, tick every line) -> Dispatch rider.
export default function PickWorkspace({ hub, order, onDispatched }) {
  const { api, patchOrder, markHandled, notify } = hub;
  const id = order.orderId;
  const now = useNow();
  const [full, setFull] = useState(null);                  // order incl. prescription image
  const [ticked, setTicked] = useState(() => load(ticksKey(id), {}));
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [oos, setOos] = useState(null);                    // {selected:{key:true}} while the out-of-stock dialog is open
  const [zoom, setZoom] = useState(false);
  const stage = stageOf(order);

  useEffect(() => { setTicked(load(ticksKey(id), {})); setErr(""); setOos(null); setFull(null); }, [id]);
  useEffect(() => { if (stage === "PICKING") save(ticksKey(id), ticked); }, [ticked, id, stage]);
  useEffect(() => { if (stage === "PICKING" && order.requiresRx && !full) api.getOrder(id).then((r) => setFull(r.order)).catch(() => {}); }, [stage, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const left = secondsLeft(order.deadlineAt, now);
  const tstate = stage === "PICKING" ? timerState({ deadlineMs: order.deadlineAt, totalSeconds: order.totalSeconds, now }) : "ok";
  const gate = useMemo(() => canDispatch({ lines: order.lines, ticked, requiresRx: order.requiresRx, rxStatus: order.rxStatus }), [order, ticked]);

  function gone(e) {
    if (e.code === "ORDER_REASSIGNED") {
      markHandled(id); remove(ticksKey(id));
      notify(e.message || "This order timed out and was reassigned to another pharmacy.", "warn");
      return true;
    }
    return false;
  }
  async function run(label, fn) {
    setBusy(label); setErr("");
    try { return await fn(); } catch (e) { if (!gone(e)) setErr(e.message); return null; } finally { setBusy(""); }
  }

  const open = () => run("open", async () => {
    const r = await api.startPicking(id);
    patchOrder(id, { pickingStarted: true, totalSeconds: r.order.timeoutSeconds, deadlineAt: Date.now() + r.order.timeoutSeconds * 1000, extensionUsed: r.order.extensionUsed });
  });
  const extend = () => run("extend", async () => {
    const r = await api.extend(id);
    patchOrder(id, { extensionUsed: true, deadlineAt: Date.now() + r.order.timeoutSeconds * 1000 });
  });
  const busyRelease = () => run("release", async () => {
    await api.release(id, "BUSY"); markHandled(id); remove(ticksKey(id)); notify("Order passed to the next pharmacy.");
  });
  const verifyRx = (ok) => run("rx", async () => {
    if (ok) { await api.verifyRx(id, "verified"); patchOrder(id, { rxStatus: "VERIFIED" }); }
    else {
      if (!window.confirm("Reject this prescription as invalid? The customer's order will be cancelled.")) return;
      await api.release(id, "RX_INVALID"); markHandled(id); remove(ticksKey(id)); notify("Order cancelled: prescription rejected.");
    }
  });
  const confirmOos = () => run("oos", async () => {
    const missing = order.lines.filter((l) => oos.selected[keyOf(l.name)]).map((l) => l.name);
    await api.release(id, "OUT_OF_STOCK", missing);
    markHandled(id); remove(ticksKey(id)); setOos(null);
    notify(`Passed on. We will not offer you ${missing.length === 1 ? missing[0] : "these items"} for a while. You can undo this on the Shelf screen.`);
  });
  const dispatch = () => run("dispatch", async () => {
    const r = await api.dispatch(id, packedNames(order.lines, ticked));
    markHandled(id); remove(ticksKey(id));
    onDispatched(id, r.dispatch);
  });

  const toggle = (l) => {
    if (order.requiresRx && order.rxStatus !== "VERIFIED") return;
    setTicked((t) => ({ ...t, [keyOf(l.name)]: !t[keyOf(l.name)] }));
  };

  if (stage === "OFFERED") {
    return (
      <section className="card work">
        <div className="work-head"><h2>New order</h2><span className={`num timer big ${left <= 15 ? "urgent" : ""}`}>{mmss(left)}</span></div>
        <p className="muted">Open it to start the clock. You then tick every item as you pick it, and the rider is sent only after that.</p>
        <ItemSummary lines={order.lines} total={order.total} />
        {order.requiresRx && <p className="hint">This order has a prescription to check.</p>}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="actions">
          <button className="btn primary big" onClick={open} disabled={Boolean(busy)}>{busy === "open" ? "Opening…" : "Open order"}</button>
          <button className="btn" onClick={busyRelease} disabled={Boolean(busy)}>Can't take this now</button>
        </div>
      </section>
    );
  }

  const rxBlocked = order.requiresRx && order.rxStatus !== "VERIFIED";
  return (
    <section className="card work">
      <div className="work-head">
        <h2>Pick the order</h2>
        <span className={`num timer big ${tstate === "warn" ? "warn" : ""} ${tstate === "expired" ? "urgent" : ""}`}>{tstate === "expired" ? "Time up" : mmss(left)}</span>
      </div>
      {tstate === "warn" && !order.extensionUsed && (
        <p className="banner-warn">Running low on time. <button className="btn small" onClick={extend} disabled={Boolean(busy)}>+2 minutes (once)</button></p>
      )}
      {tstate === "expired" && <p className="banner-bad">Time is up. The Hub is passing this order to the next pharmacy.</p>}

      {order.requiresRx && (
        <div className="rxbox">
          <h3>Prescription</h3>
          {full && full.rxImage ? <img className="rximg" src={full.rxImage} alt="Customer prescription" onClick={() => setZoom(true)} /> : <p className="muted">{full ? "No image attached." : "Loading prescription…"}</p>}
          {order.rxStatus === "VERIFIED" ? <p className="ok-text">✓ Prescription verified</p> : (
            <div className="actions">
              <button className="btn primary" onClick={() => verifyRx(true)} disabled={Boolean(busy)}>✓ Prescription is valid</button>
              <button className="btn danger" onClick={() => verifyRx(false)} disabled={Boolean(busy)}>✕ Reject invalid prescription</button>
            </div>
          )}
        </div>
      )}

      <ul className="lines">
        {order.lines.map((l) => {
          const k = keyOf(l.name), done = Boolean(ticked[k]);
          return (
            <li key={k} className={`line ${done ? "done" : ""}`}>
              <div className="line-main"><b>{l.name}</b><span className="muted">Qty {l.quantity}{l.price ? ` · ₹${Number(l.price).toFixed(2)} each` : ""}</span></div>
              <div className="line-actions">
                <button className={`btn ${done ? "primary" : ""}`} onClick={() => toggle(l)} disabled={rxBlocked || Boolean(busy)} aria-pressed={done}>{done ? "✓ Packed" : "Mark packed"}</button>
                <button className="btn danger" onClick={() => setOos({ selected: { [k]: true } })} disabled={Boolean(busy)}>Out of stock</button>
              </div>
            </li>
          );
        })}
      </ul>

      {err && <p className="error" role="alert">{err}</p>}
      <div className="actions sticky">
        <button className="btn go big" onClick={dispatch} disabled={!gate.ok || Boolean(busy) || tstate === "expired"}>{busy === "dispatch" ? "Sending…" : "🛵 Dispatch rider"}</button>
        {!gate.ok && <span className="muted">{gate.reason}</span>}
        <button className="btn ghost" onClick={busyRelease} disabled={Boolean(busy)}>Can't take this now</button>
      </div>

      {oos && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="card modal-card">
            <h3>Out of stock</h3>
            <p>Tick everything you do not have. The order goes to the next pharmacy right away, and you will not be offered these items for a while.</p>
            <ul className="oos-list">
              {order.lines.map((l) => (
                <li key={keyOf(l.name)}><label><input type="checkbox" checked={Boolean(oos.selected[keyOf(l.name)])} onChange={(e) => setOos((s) => ({ selected: { ...s.selected, [keyOf(l.name)]: e.target.checked } }))} /> {l.name}</label></li>
              ))}
            </ul>
            <div className="actions">
              <button className="btn danger" onClick={confirmOos} disabled={!Object.values(oos.selected).some(Boolean) || Boolean(busy)}>Pass the order on</button>
              <button className="btn" onClick={() => setOos(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {zoom && full && <div className="modal zoom" onClick={() => setZoom(false)}><img src={full.rxImage} alt="Prescription, enlarged" /></div>}
    </section>
  );
}

function ItemSummary({ lines, total }) {
  return (
    <>
      <ul className="lines compact">{lines.map((l) => <li key={keyOf(l.name)} className="line"><div className="line-main"><b>{l.name}</b><span className="muted">Qty {l.quantity}</span></div></li>)}</ul>
      <p className="num total">Order value ₹{Number(total || 0).toFixed(2)}</p>
    </>
  );
}
