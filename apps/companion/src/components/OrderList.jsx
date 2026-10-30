import { useEffect, useState } from "react";
import { secondsLeft, mmss } from "../lib/pickLogic.js";

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export default function OrderList({ orders, selectedId, onSelect }) {
  const now = useNow();
  const list = Object.values(orders).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (!list.length) return <div className="empty card"><p>No orders right now.</p><p className="muted">When one arrives this screen rings and comes to the front.</p></div>;
  return (
    <ul className="orderlist">
      {list.map((o) => {
        const left = secondsLeft(o.deadlineAt, now);
        return (
          <li key={o.orderId}>
            <button className={`ordercard ${selectedId === o.orderId ? "sel" : ""} ${o.pickingStarted ? "" : "ringing"}`} onClick={() => onSelect(o.orderId)}>
              <span className="oc-top"><b>{o.lines.length} item{o.lines.length === 1 ? "" : "s"}</b><span className="num">₹{Number(o.total || 0).toFixed(2)}</span></span>
              <span className="oc-mid">{o.lines.slice(0, 2).map((l) => l.name).join(", ")}{o.lines.length > 2 ? ` +${o.lines.length - 2} more` : ""}</span>
              <span className="oc-bot">
                <span className={`tag ${o.pickingStarted ? "picking" : "offered"}`}>{o.pickingStarted ? "Picking" : "New order"}</span>
                {o.requiresRx && <span className="tag rx">Rx</span>}
                <span className={`num timer ${left <= 15 ? "urgent" : ""}`}>{mmss(left)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
