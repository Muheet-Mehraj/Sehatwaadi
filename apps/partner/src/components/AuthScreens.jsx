import { useEffect, useState } from "react";
import { Button, ErrorNote } from "./ui.jsx";
import { errorText } from "../services/errors.js";
import { useRider } from "../contexts/RiderContext.jsx";

export function LoginScreen({ api }) {
  const [phone, setPhone] = useState(""); const [code, setCode] = useState(""); const [sent, setSent] = useState(false); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const send = async () => { setBusy(true); setErr(""); const r = await api.signInWithPhone(phone); setBusy(false); r.ok ? setSent(true) : setErr(errorText({ ...r, ok: false })); };
  const verify = async () => { setBusy(true); setErr(""); const r = await api.verifyPhoneOtp(phone, code); setBusy(false); if (!r.ok) setErr(errorText(r)); };
  const digits = phone.replace(/\D/g, "");
  return (
    <main className="auth"><div className="logo">+</div><h1>SehatWaadi Partner</h1><p className="muted">Sign in with your mobile number</p>
      <ErrorNote text={err} />
      {!sent ? (<>
        <label className="field"><span>Mobile number</span><input inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" /></label>
        <Button busy={busy} disabled={digits.length < 10} onClick={send}>Send code</Button>
      </>) : (<>
        <label className="field"><span>6-digit code sent to {phone}</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></label>
        <Button busy={busy} disabled={code.length < 6} onClick={verify}>Verify & sign in</Button>
        <Button kind="ghost" onClick={() => { setSent(false); setCode(""); }}>Change number</Button>
      </>)}
    </main>
  );
}

export function RegisterScreen({ onSignOut }) {
  const { actions, busy, error } = useRider();
  const [fullName, setName] = useState(""); const [vehicleType, setType] = useState("SCOOTER"); const [vehicleNumber, setNum] = useState("");
  return (
    <main className="auth"><h2>Set up your rider profile</h2><p className="muted">SehatWaadi verifies every rider before the first order.</p>
      <ErrorNote text={error} onClose={actions.clearError} />
      <label className="field"><span>Full name</span><input value={fullName} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
      <label className="field"><span>Vehicle</span><select value={vehicleType} onChange={(e) => setType(e.target.value)}><option value="SCOOTER">Scooter</option><option value="MOTORCYCLE">Motorcycle</option><option value="BICYCLE">Bicycle</option></select></label>
      {vehicleType !== "BICYCLE" && <label className="field"><span>Vehicle number</span><input value={vehicleNumber} onChange={(e) => setNum(e.target.value.toUpperCase())} placeholder="JK01AB1234" /></label>}
      <Button busy={busy} disabled={fullName.trim().length < 2} onClick={() => actions.register({ fullName: fullName.trim(), vehicleType, vehicleNumber: vehicleType === "BICYCLE" ? "" : vehicleNumber.trim() })}>Submit for verification</Button>
      <Button kind="ghost" onClick={onSignOut}>Sign out</Button>
    </main>
  );
}

export function PendingScreen({ onSignOut }) {
  const { rider, refreshRider } = useRider();
  useEffect(() => { const i = setInterval(refreshRider, 10000); return () => clearInterval(i); }, [refreshRider]);
  const suspended = rider.verificationStatus === "SUSPENDED";
  return (
    <main className="auth"><div className="logo">{suspended ? "!" : "…"}</div>
      <h2>{suspended ? "Account suspended" : "Verification in progress"}</h2>
      <p className="muted">{suspended ? "Please contact SehatWaadi support. You will not receive orders until your account is reinstated." : `Hi ${rider.fullName.split(" ")[0]}, we're verifying your documents. This screen updates by itself once you're approved.`}</p>
      <Button kind="ghost" onClick={onSignOut}>Sign out</Button>
    </main>
  );
}
