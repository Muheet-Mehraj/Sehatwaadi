import { useState } from "react";
import { createApi } from "../lib/api.js";
import { unlock } from "../lib/ringer.js";

// First-run pairing: Hub address + pharmacy id + key (the same credentials the shop already has).
export default function Login({ initial, onSave }) {
  const [hubUrl, setHubUrl] = useState(initial?.hubUrl || "");
  const [pharmacyId, setPharmacyId] = useState(initial?.pharmacyId || "");
  const [apiKey, setApiKey] = useState(initial?.apiKey || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e) {
    e.preventDefault(); setErr(""); setBusy(true);
    unlock();   // the click lets the browser play the order alarm later
    const cfg = { hubUrl: hubUrl.trim().replace(/\/+$/, ""), pharmacyId: pharmacyId.trim(), apiKey: apiKey.trim() };
    try {
      if (!/^https?:\/\//i.test(cfg.hubUrl)) throw new Error("The Hub address must start with https:// (or http:// for testing).");
      await createApi(cfg).heartbeat(true);   // proves the id and key work, without taking orders yet
      onSave(cfg);
    } catch (e2) {
      setErr(e2.status === 403 ? "The pharmacy ID or key was not accepted." : e2.message);
    } finally { setBusy(false); }
  }

  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit}>
        <h1 className="brand">SehatWaadi <span>Companion</span></h1>
        <p className="muted">Connect this PC to your shop. You only do this once.</p>
        <label>Hub address<input value={hubUrl} onChange={(e) => setHubUrl(e.target.value)} placeholder="https://your-hub.example.com" required /></label>
        <label>Pharmacy ID<input value={pharmacyId} onChange={(e) => setPharmacyId(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" required spellCheck="false" /></label>
        <label>Pharmacy key<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required /></label>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary big" disabled={busy}>{busy ? "Checking…" : "Connect shop"}</button>
      </form>
    </main>
  );
}
