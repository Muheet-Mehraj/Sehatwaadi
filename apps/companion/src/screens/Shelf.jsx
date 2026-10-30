import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client.js";
import { readSession } from "../api/client.js";
import { useHub } from "../hub/HubContext.jsx";

// "Virtual shelf": items we will not offer this pharmacy. Created by Out-of-stock taps (they expire on their own) or by hand here.
export default function Shelf() {
  const { notify } = useHub();
  const [blocks, setBlocks] = useState(null); const [q, setQ] = useState(""); const [hits, setHits] = useState([]);
  const load = useCallback(() => api("/api/companion/shelf").then((r) => setBlocks(r.blocks)).catch((e) => notify(e.message, "bad")), [notify]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return undefined; }
    const t = setTimeout(async () => { try { const s = readSession(); const r = await fetch(`${s.hubUrl.replace(/\/+$/, "")}/api/medicines/search?q=${encodeURIComponent(q.trim())}`); setHits(await r.json()); } catch { setHits([]); } }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const block = async (name) => { await api("/api/companion/shelf/block", { method: "POST", body: { name } }).catch((e) => notify(e.message, "bad")); setQ(""); load(); };
  const restock = async (name) => { await api("/api/companion/shelf/restock", { method: "POST", body: { name } }).catch((e) => notify(e.message, "bad")); load(); };
  const until = (b) => (b.expires_at === "infinity" || new Date(b.expires_at).getFullYear() > 3000) ? "until you mark it restocked" : `auto-clears ${new Date(b.expires_at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`;
  return (
    <div>
      <div className="card">
        <h2>Items not available at your shop</h2>
        <p className="muted">We offer you every order by default. Items you mark out of stock are skipped for you until they are restocked.</p>
        <input className="search" placeholder="Search a medicine to mark out of stock…" value={q} onChange={(e) => setQ(e.target.value)} />
        {hits.length > 0 && <ul className="hits">{hits.map((h) => <li key={h.id}><span>{h.name}</span><button className="btn small" onClick={() => block(h.name)}>Mark out of stock</button></li>)}</ul>}
      </div>
      <div className="card">
        {!blocks ? <p className="muted">Loading…</p> : !blocks.length ? <p className="muted">Nothing is blocked. Every item can be offered to you.</p> :
          <ul className="hits">{blocks.map((b) => <li key={b.item_name}><span><b>{b.item_name}</b><br /><span className="muted small">{b.reason === "MANUAL" ? "Set by you" : "Out of stock on an order"} · {until(b)}</span></span><button className="btn small primary" onClick={() => restock(b.item_name)}>Mark restocked</button></li>)}</ul>}
      </div>
    </div>
  );
}
