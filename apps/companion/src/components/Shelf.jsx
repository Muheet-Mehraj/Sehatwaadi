import { useEffect, useState } from "react";

const when = (iso) => new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

// Items this shop will not be offered. They get here when the chemist says "out of stock" on an order, or by hand below.
export default function Shelf({ hub }) {
  const { api, notify } = hub;
  const [blocks, setBlocks] = useState(null);
  const [text, setText] = useState("");
  const [found, setFound] = useState([]);

  const load = () => api.blocks().then((r) => setBlocks(r.blocks)).catch((e) => notify(e.message, "warn"));
  useEffect(() => { load(); }, [api]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (text.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => api.searchMedicines(text.trim()).then((r) => setFound(Array.isArray(r) ? r : [])).catch(() => setFound([])), 250);
    return () => clearTimeout(t);
  }, [text, api]);

  async function restock(k) { try { await api.restock(k); load(); } catch (e) { notify(e.message, "warn"); } }
  async function block(name) { try { await api.blockItem(name); setText(""); setFound([]); load(); notify(`${name} marked out of stock.`); } catch (e) { notify(e.message, "warn"); } }

  return (
    <div className="shelf">
      <h2>Items you are not offered</h2>
      <p className="muted">New orders skip your shop for these items. Press “Restocked” when you have one again. Learned items clear on their own after a day, and clear when you pack an order that contains them.</p>
      {!blocks ? <p className="muted">Loading…</p> : !blocks.length ? <div className="empty card"><p>Nothing is blocked. You will be offered every order near you.</p></div> : (
        <ul className="blocks">
          {blocks.map((b) => (
            <li key={b.item_key} className="card block">
              <div><b>{b.item_name}</b><br /><span className="muted">{b.source === "MANUAL" ? "Marked by you" : "Out of stock on an order"} · since {when(b.created_at)}{b.source === "ORDER" ? ` · clears ${when(b.blocked_until)}` : ""}</span></div>
              <button className="btn primary" onClick={() => restock(b.item_key)}>Mark restocked</button>
            </li>
          ))}
        </ul>
      )}
      <h2>Mark something out of stock</h2>
      <input className="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search a medicine…" />
      {found.length > 0 && <ul className="found">{found.map((m) => <li key={m.id}><span>{m.name}</span><button className="btn small" onClick={() => block(m.name)}>Out of stock</button></li>)}</ul>}
    </div>
  );
}
