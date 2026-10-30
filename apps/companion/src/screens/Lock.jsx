import { useState } from "react";
import { useAuth } from "../auth/AuthContext.jsx";

// Hides the screen at the counter. Orders still ring and the connection stays up while locked.
export default function Lock({ children }) {
  const { unlock } = useAuth();
  const [pin, setPin] = useState(""); const [bad, setBad] = useState(false);
  const submit = async (e) => { e.preventDefault(); if (!(await unlock(pin))) { setBad(true); setPin(""); } };
  return (
    <div className="center">
      {children}
      <form className="card login" onSubmit={submit}>
        <h2 className="brand">Terminal locked</h2>
        <p className="muted">Orders will still ring. Enter the staff PIN to continue.</p>
        <input className="pin" type="password" inputMode="numeric" maxLength={8} value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, "")); setBad(false); }} autoFocus />
        {bad && <div className="alert bad">Wrong PIN.</div>}
        <button className="btn primary big">Unlock</button>
      </form>
    </div>
  );
}
