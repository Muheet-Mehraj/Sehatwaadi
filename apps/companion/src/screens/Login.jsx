import { useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";
import { unlockAudio } from "../services/siren.js";

export default function Login() {
  const { login } = useAuth();
  const [hubUrl, setHubUrl] = useState(import.meta.env.VITE_HUB_URL || "http://localhost:8080");
  const [pharmacyId, setPharmacyId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); unlockAudio(); setBusy(true); setErr("");
    try { await login(hubUrl, pharmacyId, apiKey); } catch (x) { setErr(x.status === 403 ? "Pharmacy ID or key is not correct." : x.message); }
    setBusy(false);
  };
  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <h1 className="brand">SehatWaadi <span>Chemist</span></h1>
        <p className="muted">Sign in once on this computer. Orders will ring here while the app is open.</p>
        <label>Pharmacy ID<input value={pharmacyId} onChange={(e) => setPharmacyId(e.target.value)} placeholder="From your SehatWaadi onboarding" required autoFocus /></label>
        <label>Pharmacy key<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required /></label>
        <label>Server address<input value={hubUrl} onChange={(e) => setHubUrl(e.target.value)} required /></label>
        {err && <div className="alert bad">{err}</div>}
        <button className="btn primary big" disabled={busy}>{busy ? "Checking…" : "Sign in"}</button>
      </form>
    </div>
  );
}
