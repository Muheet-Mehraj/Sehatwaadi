import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { HUB_URL } from "../../api/client.js";

async function post(path, body) {
  const res = await fetch(`${HUB_URL}/api/customer/auth${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const STYLES = `
.swl-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:100; display:flex; align-items:flex-end; justify-content:center; animation:swl-fade .2s ease both; }
.swl-sheet { width:100%; max-width:440px; background:#fff; border-radius:20px 20px 0 0; padding:22px 20px calc(24px + env(safe-area-inset-bottom)); animation:swl-up .25s ease both; color:var(--ink,#1F1F1F); }
.swl-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6px; }
.swl-title { font-size:1.25rem; font-weight:800; }
.swl-sub { color:var(--muted,#6B6B6B); font-size:.9rem; margin-bottom:18px; }
.swl-x { width:32px; height:32px; border-radius:50%; background:#F0F0F0; font-size:1rem; line-height:32px; text-align:center; }
.swl-field { display:flex; align-items:center; border:1.5px solid var(--line,#E8E8E8); border-radius:12px; overflow:hidden; background:#fff; }
.swl-field:focus-within { border-color:var(--green,#0C831F); }
.swl-prefix { padding:0 12px; font-weight:700; background:#F7F7F7; align-self:stretch; display:flex; align-items:center; border-right:1px solid var(--line,#E8E8E8); }
.swl-input { flex:1; min-width:0; padding:14px; font-size:1.05rem; border:none; outline:none; letter-spacing:.04em; }
.swl-otp { text-align:center; font-size:1.4rem; letter-spacing:.5em; padding:14px 0 14px .5em; }
.swl-err { margin-top:10px; color:#B42318; background:#FEF3F2; border-radius:8px; padding:9px 12px; font-size:.86rem; }
.swl-cta { width:100%; margin-top:16px; background:var(--green,#0C831F); color:#fff; font-weight:800; padding:14px; border-radius:12px; font-size:.95rem; }
.swl-cta:disabled { opacity:.6; }
.swl-link { margin-top:12px; width:100%; text-align:center; color:var(--green,#0C831F); font-weight:700; font-size:.88rem; }
.swl-link:disabled { color:var(--muted,#6B6B6B); font-weight:500; }
@keyframes swl-up { from{transform:translateY(100%)} to{transform:translateY(0)} }
@keyframes swl-fade { from{opacity:0} to{opacity:1} }
@media (min-width:640px) {
  .swl-backdrop { align-items:center; }
  .swl-sheet { border-radius:20px; padding-bottom:24px; }
}`;

function Sheet({ onClose }) {
  const { login } = useAuth();
  const [step, setStep] = useState("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, [step]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const requestOtp = async () => {
    if (!/^[6-9]\d{9}$/.test(phone)) {
      setError("Enter a valid 10-digit mobile number.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await post("/send-otp", { phone });
      setStep("otp");
      setOtp("");
      setCooldown(30);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const confirmOtp = async () => {
    if (!/^\d{6}$/.test(otp)) {
      setError("Enter the 6-digit OTP.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const data = await post("/verify-otp", { phone, otp });
      login(data.token, data.customer);
      onClose();
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    if (!loading) (step === "phone" ? requestOtp() : confirmOtp());
  };

  return (
    <div className="swl-backdrop" onClick={onClose}>
      <style>{STYLES}</style>
      <form className="swl-sheet" role="dialog" aria-modal="true" aria-label="Login"
        onClick={(e) => e.stopPropagation()} onSubmit={onSubmit}>
        <div className="swl-head">
          <div className="swl-title">{step === "phone" ? "Login or Sign up" : "Verify OTP"}</div>
          <button type="button" className="swl-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="swl-sub">
          {step === "phone" ? "Enter your mobile number to continue." : `We sent a 6-digit code to +91 ${phone}.`}
        </div>

        {step === "phone" ? (
          <div className="swl-field">
            <span className="swl-prefix">+91</span>
            <input ref={inputRef} className="swl-input" type="tel" inputMode="numeric" autoComplete="tel-national"
              placeholder="10-digit mobile number" maxLength={10} value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))} />
          </div>
        ) : (
          <div className="swl-field">
            <input ref={inputRef} className="swl-input swl-otp" type="text" inputMode="numeric"
              autoComplete="one-time-code" placeholder="••••••" maxLength={6} value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))} />
          </div>
        )}

        {error && <div className="swl-err" role="alert">⚠ {error}</div>}

        <button type="submit" className="swl-cta" disabled={loading}>
          {loading ? "Please wait..." : step === "phone" ? "Send OTP" : "Verify & Continue"}
        </button>

        {step === "otp" && (
          <>
            <button type="button" className="swl-link" disabled={loading || cooldown > 0} onClick={requestOtp}>
              {cooldown > 0 ? `Resend OTP in ${cooldown}s` : "Resend OTP"}
            </button>
            <button type="button" className="swl-link" onClick={() => { setStep("phone"); setError(""); }}>
              Change number
            </button>
          </>
        )}
      </form>
    </div>
  );
}

// Mounting only while open means all form state resets on every open.
export default function LoginModal({ open, onClose }) {
  return open ? <Sheet onClose={onClose} /> : null;
}