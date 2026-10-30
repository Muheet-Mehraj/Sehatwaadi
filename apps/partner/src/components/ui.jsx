import { useRef, useState } from "react";
import { hapticTap, hapticHeavy } from "../services/native.js";
export const Button = ({ kind = "primary", busy, children, ...p }) => <button className={`btn ${kind}`} disabled={p.disabled || busy} {...p}>{busy ? "Please wait…" : children}</button>;
export const Card = ({ title, children, className = "" }) => <section className={`card ${className}`}>{title && <h3>{title}</h3>}{children}</section>;
export const ErrorNote = ({ text, onClose }) => text ? <div className="note err" role="alert">{text}{onClose && <button className="x" onClick={onClose} aria-label="Dismiss">×</button>}</div> : null;
export const Money = ({ v }) => <>₹{Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</>;

// Swipe-to-confirm: prevents accidental taps on state changes that can't be undone.
export function SwipeButton({ label, onConfirm, disabled, busy }) {
  const track = useRef(null); const [x, setX] = useState(0); const drag = useRef(null);
  const max = () => (track.current?.clientWidth || 280) - 56;
  const down = (e) => { if (disabled || busy) return; drag.current = e.clientX - x; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const move = (e) => { if (drag.current == null) return; setX(Math.max(0, Math.min(max(), e.clientX - drag.current))); };
  const up = () => { if (drag.current == null) return; drag.current = null; if (x >= max() * 0.85) { hapticHeavy(); setX(max()); Promise.resolve(onConfirm()).finally(() => setX(0)); } else setX(0); };
  return (
    <div ref={track} className={`swipe ${disabled ? "off" : ""}`} role="button" aria-label={label} aria-disabled={disabled || busy}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !disabled && !busy) onConfirm(); }} tabIndex={0}>
      <span className="swipe-label">{busy ? "Please wait…" : label}</span>
      <div className="swipe-knob" style={{ transform: `translateX(${x}px)` }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>›</div>
    </div>
  );
}

export function OtpKeypad({ value, onChange, length = 4, disabled }) {
  const press = (d) => { if (!disabled && value.length < length) { hapticTap(); onChange(value + d); } };
  return (
    <div className="otp">
      <div className="otp-boxes" aria-label="Customer code">{Array.from({ length }, (_, i) => <span key={i} className={`otp-box ${value[i] ? "full" : ""}`}>{value[i] ? "•" : ""}</span>)}</div>
      <div className="keypad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => <button key={d} type="button" onClick={() => press(d)} disabled={disabled}>{d}</button>)}
        <button type="button" onClick={() => onChange("")} disabled={disabled} aria-label="Clear">C</button>
        <button type="button" onClick={() => press("0")} disabled={disabled}>0</button>
        <button type="button" onClick={() => onChange(value.slice(0, -1))} disabled={disabled} aria-label="Backspace">⌫</button>
      </div>
    </div>
  );
}
