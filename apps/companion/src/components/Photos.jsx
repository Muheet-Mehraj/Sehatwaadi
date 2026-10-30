import { useCallback, useEffect, useRef, useState } from "react";
import { shrinkImage } from "../lib/image.js";

// The chemist photographs a medicine once; every customer then sees that photo. He is looking at the real pack and at the screen,
// so pressing "Save photo" is his verification that the picture matches the medicine.
export default function Photos({ hub }) {
  const { api, notify } = hub;
  const [text, setText] = useState("");
  const [missingOnly, setMissingOnly] = useState(true);
  const [data, setData] = useState(null);
  const [pending, setPending] = useState(null);   // { med, blob, url }
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const target = useRef(null);                     // the medicine the file picker was opened for

  const load = useCallback(() => api.listCatalogImages({ q: text.trim(), missing: missingOnly }).then(setData).catch((e) => notify(e.message, "warn")), [api, text, missingOnly, notify]);
  useEffect(() => { const t = setTimeout(load, text ? 250 : 0); return () => clearTimeout(t); }, [load, text]);
  useEffect(() => () => { if (pending?.url) URL.revokeObjectURL(pending.url); }, [pending]);

  async function picked(file) {
    const med = target.current; if (!file || !med) return;
    try { const blob = await shrinkImage(file); setPending({ med, blob, url: URL.createObjectURL(blob) }); }
    catch (e) { notify(e.message, "warn"); }
  }
  const choose = (med) => { target.current = med; fileRef.current?.click(); };
  const onPaste = (med) => (e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/")); if (f) { e.preventDefault(); target.current = med; picked(f); } };

  async function save() {
    setBusy(true);
    try { await api.uploadCatalogImage(pending.med.id, pending.blob); notify(`Photo saved for ${pending.med.name}.`); setPending(null); load(); }
    catch (e) { notify(e.message, "warn"); } finally { setBusy(false); }
  }
  async function remove(med) {
    if (!window.confirm(`Remove the photo of ${med.name}?`)) return;
    try { await api.removeCatalogImage(med.id); load(); } catch (e) { notify(e.message, "warn"); }
  }

  return (
    <div className="photos">
      <h2>Medicine photos</h2>
      <p className="muted">Photograph the front of the pack on a plain background and add it here. Customers see this photo when they browse and buy. Only add a photo when it matches the medicine in your hand.</p>
      {data && <p className="muted"><b>{data.withImage}</b> of <b>{data.total}</b> medicines have a photo.</p>}
      <div className="photo-tools">
        <input className="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search a medicine…" />
        <label className="check"><input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} /> Only without a photo</label>
      </div>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { picked(e.target.files[0]); e.target.value = ""; }} />
      {!data ? <p className="muted">Loading…</p> : !data.items.length ? <div className="empty card"><p>{missingOnly ? "Nothing left without a photo here." : "No medicine matches."}</p></div> : (
        <ul className="photo-list">
          {data.items.map((m) => (
            <li key={m.id} className="card photo-row" tabIndex={0} onPaste={onPaste(m)} title="Click the row and press Ctrl+V to paste a picture">
              <div className="thumb">{m.imageUrl ? <img src={m.imageUrl} alt="" loading="lazy" /> : <span className="muted">No photo</span>}</div>
              <div className="grow"><b>{m.name}</b><br /><span className="muted">{m.hasImage ? "Photo added" : m.imageUrl ? "Linked photo" : "Needs a photo"}</span></div>
              <button className="btn primary" onClick={() => choose(m)}>{m.hasImage ? "Replace" : "Add photo"}</button>
              {m.hasImage && <button className="btn" onClick={() => remove(m)}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {pending && (
        <div className="modal-back" role="dialog" aria-modal="true" aria-label="Check the photo">
          <div className="card modal">
            <h3>{pending.med.name}</h3>
            <img className="preview" src={pending.url} alt="Preview of the photo to save" />
            <p className="muted">Does this photo clearly show this medicine? ({Math.round(pending.blob.size / 1024)} KB)</p>
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => { const m = pending.med; setPending(null); choose(m); }}>Choose another</button>
              <button className="btn" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save photo"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
