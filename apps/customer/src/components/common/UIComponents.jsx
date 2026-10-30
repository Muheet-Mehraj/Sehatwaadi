import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { hapticTap } from '../../utils/native';
import { useNetwork } from '../../context/NetworkContext';

export function ErrorBanner({ message }) {
  if (!message) return null;
  return <div className="sw-err" role="alert">⚠ {message}</div>;
}

const OFFLINE_STYLE = {
  position: "fixed", top: 0, left: 0, right: 0, zIndex: 300,
  background: "#B42318", color: "#fff", textAlign: "center",
  fontWeight: 700, fontSize: ".82rem",
  padding: "calc(6px + env(safe-area-inset-top)) 12px 6px",
};

export function OfflineBanner() {
  const { online } = useNetwork();
  const ref = useRef(null);

  // Publish the banner's height so fixed layouts (the top bar) sit below it instead of under it.
  useLayoutEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--offline-h', online ? '0px' : `${ref.current?.offsetHeight || 30}px`);
    return () => root.setProperty('--offline-h', '0px');
  }, [online]);

  if (online) return null;
  return <div ref={ref} style={OFFLINE_STYLE} role="status">You're offline. Reconnect to browse and order.</div>;
}

export function QtyStepper({ qty, onAdd, onRemove }) {
  const add = () => { hapticTap(); onAdd(); };
  const remove = () => { hapticTap(); onRemove(); };
  
  if (qty === 0) {
    return <button className="sw-add" onClick={add}>ADD</button>;
  }
  return (
    <div className="sw-step">
      <button onClick={remove} aria-label="Remove one">−</button>
      <b>{qty}</b>
      <button onClick={add} disabled={qty >= 10} aria-label="Add one">+</button>
    </div>
  );
}

const SEARCH_HINTS = ["Paracetamol", "Bandages", "Dettol", "ORS", "Vitamin C", "Cough syrup"];

export function SearchBar({ value, onChange }) {
  const [hint, setHint] = useState(0);
  const [focused, setFocused] = useState(false);
  
  useEffect(() => {
    const t = setInterval(() => setHint((h) => (h + 1) % SEARCH_HINTS.length), 2400);
    return () => clearInterval(t);
  }, []);
  
  return (
    <div className="sw-search">
      <svg className="mag" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
      </svg>
      <input value={value} onChange={(e) => onChange(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        aria-label="Search medicines" />
      {!value && (
        <div className="sw-hint" aria-hidden="true">
          Search '<span key={hint}>{SEARCH_HINTS[hint]}</span>'{focused ? "" : "…"}
        </div>
      )}
      {value && <button className="clear" onClick={() => onChange("")} aria-label="Clear search">✕</button>}
    </div>
  );
}
