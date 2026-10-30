// Rider profile + KYC. Used two ways:
//   onboarding  - a new rider who is not verified yet: add photos and details, send them, then wait (screen updates by itself on approval)
//   (default)   - a verified rider looking at their own profile and documents
// The full Aadhaar number is checked on the phone and only its last 4 digits are sent.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRider } from "../contexts/RiderContext.jsx";
import { Button, Card, ErrorNote } from "./ui.jsx";
import { errorText } from "../services/errors.js";
import { DOCS, docOrder, problems, prepareImage, cleanAadhaar, groupAadhaar, cleanPan, cleanDl } from "../services/kyc.js";

const BADGE = { APPROVED: ["Approved ✓", "ok"], PENDING: ["Added", "info"], REJECTED: ["Retake", "err"] };
const mask = (s, keepStart, keepEnd) => (s ? s.slice(0, keepStart) + "•".repeat(Math.max(0, s.length - keepStart - keepEnd)) + s.slice(s.length - keepEnd) : "—");

function DocTile({ kind, doc, preview, busy, canEdit, onPick }) {
  const meta = DOCS[kind]; const input = useRef(null);
  const [text, tone] = doc ? BADGE[doc.status] || ["Added", "info"] : ["Not added", "warn"];
  return (
    <li className="doc" data-kind={kind}>
      <div className="docpic">{preview ? <img src={preview} alt={meta.label} /> : <span aria-hidden="true">{doc ? "✓" : "＋"}</span>}</div>
      <div className="docinfo">
        <b>{meta.label}</b>
        <span className={`pill ${tone}`}>{text}</span>
        {doc?.status === "REJECTED" && doc.note && <small className="err-ink">{doc.note}</small>}
        {!doc && <small className="muted">{meta.hint}</small>}
      </div>
      {canEdit && (
        <label className={`btn ghost small-btn${busy ? " disabled" : ""}`}>
          {busy ? "Uploading…" : doc ? "Retake" : "Add photo"}
          <input ref={input} type="file" accept="image/*" capture={meta.capture} hidden disabled={busy} aria-label={meta.label}
            onChange={(e) => { const f = e.target.files?.[0]; if (input.current) input.current.value = ""; if (f) onPick(kind, f); }} />
        </label>
      )}
    </li>
  );
}

export default function Profile({ onBack, onSignOut, onboarding = false }) {
  const { rider, api, refreshRider } = useRider();
  const [kyc, setKyc] = useState(undefined); const [error, setError] = useState(""); const [previews, setPreviews] = useState({});
  const [busyKind, setBusyKind] = useState(null); const [sending, setSending] = useState(false); const [touched, setTouched] = useState(false);
  const [form, setForm] = useState({ dob: "", aadhaar: "", pan: "", dl: "", dlExpiry: "" });

  const load = useCallback(async () => {
    const r = await api.getMyKyc();
    if (r.ok && r.kyc) { setKyc(r.kyc); } else if (!r.ok) setError(errorText(r));
    return r;
  }, [api]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {   // prefill once from what the server already has (a rejected rider fixing one thing)
    if (kyc && !touched) setForm((f) => ({ ...f, dob: kyc.dob || f.dob, pan: kyc.pan || f.pan, dl: kyc.dlNumber || f.dl, dlExpiry: kyc.dlExpiry || f.dlExpiry }));
  }, [kyc, touched]);
  const inReview = kyc?.status === "SUBMITTED";
  useEffect(() => {   // while waiting: look again every 10 s (an approval flips the whole app)
    if (!(onboarding || inReview)) return undefined;
    const i = setInterval(() => { load(); refreshRider?.(); }, 10000); return () => clearInterval(i);
  }, [onboarding, inReview, load, refreshRider]);
  useEffect(() => () => { Object.values(previews).forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k, v) => { setTouched(true); setForm((f) => ({ ...f, [k]: v })); };
  const required = kyc?.required || [];
  const needsDl = required.includes("DL_FRONT");
  const canEdit = !!kyc?.canEdit;
  const list = problems({ docs: kyc?.docs || {}, required, dob: form.dob, aadhaar: form.aadhaar, aadhaarLast4: kyc?.aadhaarLast4, pan: form.pan, dl: form.dl, dlExpiry: form.dlExpiry });

  const pick = async (kind, file) => {
    setError(""); setBusyKind(kind);
    try {
      const img = await prepareImage(file, { maxSide: DOCS[kind].maxSide });
      const r = await api.kycUploadDoc(kind, img.base64);
      if (!r.ok) { setError(errorText(r)); try { URL.revokeObjectURL(img.previewUrl); } catch { /* ignore */ } }
      else { setPreviews((p) => ({ ...p, [kind]: img.previewUrl })); await load(); }
    } catch (e) { setError(errorText({ ok: false, error: e.message === "image_too_large" ? "image_too_large" : "invalid_image" })); }
    setBusyKind(null);
  };
  const send = async () => {
    setError(""); setSending(true);
    const a = cleanAadhaar(form.aadhaar);
    const r = await api.kycSubmit({ dob: form.dob, aadhaarLast4: a ? a.slice(-4) : kyc.aadhaarLast4, pan: cleanPan(form.pan), dlNumber: needsDl ? cleanDl(form.dl) : null, dlExpiry: needsDl ? form.dlExpiry : null });
    setSending(false);
    if (!r.ok) return setError(errorText(r));
    setForm((f) => ({ ...f, aadhaar: "" }));     // the full number is not kept anywhere
    await load(); refreshRider?.();
  };

  if (kyc === undefined) return <main className="screen"><p className="muted">Loading your profile…</p></main>;
  const verified = rider.verificationStatus === "VERIFIED";
  return (
    <main className="screen profile">
      <header className="top">
        <div><b>{onboarding ? "Complete your profile" : "Profile"}</b></div>
        {onboarding ? <button className="link" onClick={onSignOut}>Sign out</button> : <button className="link" onClick={onBack}>← Back</button>}
      </header>
      <ErrorNote text={error} onClose={() => setError("")} />
      <Card>
        <div className="row between"><div><h2>{rider.fullName}</h2><p className="muted">{rider.phone} · {rider.vehicleType.toLowerCase()} {rider.vehicleNumber || ""}</p></div>
          <span className={`pill ${verified ? "ok" : "warn"}`}>{verified ? "Verified" : "Not verified yet"}</span></div>
      </Card>

      {kyc.status === "SUBMITTED" && <div className="note info" role="status">Your documents are with the SehatWaadi team. We usually finish within a day. This screen updates by itself once you are approved.</div>}
      {kyc.status === "REJECTED" && <div className="note err" role="alert"><b>Your documents were sent back.</b><br />{kyc.rejectReason}<br /><small>Fix what is marked below and send them again.</small></div>}
      {kyc.status === "APPROVED" && <div className="note ok" role="status">Your documents are approved ✓</div>}
      {kyc.status === "DRAFT" && !verified && <div className="note warn" role="status">You can start taking orders as soon as SehatWaadi has checked your documents. Add them below.</div>}
      {kyc.status === "DRAFT" && verified && <div className="note warn" role="status">Please add your documents so your profile is complete.</div>}

      <Card title="Documents">
        <ul className="docs">{docOrder(required).map((k) => <DocTile key={k} kind={k} doc={kyc.docs?.[k]} preview={previews[k]} busy={busyKind === k} canEdit={canEdit && !sending} onPick={pick} />)}</ul>
        {!needsDl && <p className="muted small">You ride a bicycle, so a driving licence is not needed.</p>}
      </Card>

      <Card title="Details on your documents">
        {canEdit ? (<>
          <label className="field"><span>Date of birth</span><input type="date" value={form.dob} onChange={(e) => set("dob", e.target.value)} max={new Date().toISOString().slice(0, 10)} /></label>
          <label className="field"><span>Aadhaar number</span>
            <input inputMode="numeric" autoComplete="off" value={groupAadhaar(form.aadhaar)} placeholder={kyc.aadhaarMasked || "0000 0000 0000"} onChange={(e) => set("aadhaar", e.target.value)} />
            <small className="muted">{kyc.aadhaarLast4 && !form.aadhaar ? `Saved ${kyc.aadhaarMasked}. Type it again only to change it. ` : ""}We check it here and keep only the last 4 digits.</small></label>
          <label className="field"><span>PAN</span><input autoCapitalize="characters" autoComplete="off" value={form.pan} placeholder="ABCPE1234F" onChange={(e) => set("pan", cleanPan(e.target.value))} /></label>
          {needsDl && <>
            <label className="field"><span>Driving licence number</span><input autoCapitalize="characters" autoComplete="off" value={form.dl} placeholder="JK01 20190012345" onChange={(e) => set("dl", cleanDl(e.target.value))} /></label>
            <label className="field"><span>Licence valid until</span><input type="date" value={form.dlExpiry} onChange={(e) => set("dlExpiry", e.target.value)} /></label></>}
        </>) : (
          <ul className="list">
            <li><span className="muted">Date of birth</span><span>{kyc.dob || "—"}</span></li>
            <li><span className="muted">Aadhaar</span><span>{kyc.aadhaarMasked || "—"}</span></li>
            <li><span className="muted">PAN</span><span>{mask(kyc.pan, 2, 2)}</span></li>
            {needsDl && <li><span className="muted">Licence</span><span>{mask(kyc.dlNumber, 4, 3)}{kyc.dlExpiry ? ` · until ${kyc.dlExpiry}` : ""}</span></li>}
          </ul>)}
      </Card>

      {canEdit && <>
        {list.length > 0 && <p className="muted small" role="status">Still needed: {list[0].text}{list.length > 1 ? ` (+${list.length - 1} more)` : ""}</p>}
        <Button busy={sending} disabled={list.length > 0 || busyKind !== null} onClick={send}>{kyc.status === "REJECTED" ? "Send again for verification" : "Send for verification"}</Button>
      </>}
      <p className="muted small">Your photos are seen only by SehatWaadi's verification team. We never store your full Aadhaar number.</p>
      {!onboarding && <Button kind="ghost" onClick={onBack}>Back</Button>}
    </main>
  );
}
