import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { api, readSession, writeSession } from "../api/client.js";

const PIN_KEY = "swc.pinhash";
const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("swc:" + s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const getPin = () => { try { return localStorage.getItem(PIN_KEY); } catch { return null; } };

export function AuthProvider({ children }) {
  const [session, setSession] = useState(readSession);
  const [pinHash, setPinHash] = useState(getPin);
  // With a PIN set the terminal starts locked. The lock is a counter convenience (it hides the screen), not security.
  const [locked, setLocked] = useState(() => !!readSession() && !!getPin());

  const login = useCallback(async (hubUrl, pharmacyId, apiKey) => {
    const s = { hubUrl: hubUrl.trim(), pharmacyId: pharmacyId.trim(), apiKey: apiKey.trim() };
    await api("/api/companion/heartbeat", { method: "POST", session: s });   // throws on bad credentials / unreachable Hub
    writeSession(s); setSession(s); setLocked(false);
  }, []);
  const logout = useCallback(() => { writeSession(null); setSession(null); setLocked(false); }, []);
  const setPin = useCallback(async (pin) => {
    if (!pin) { try { localStorage.removeItem(PIN_KEY); } catch { /* */ } setPinHash(null); return; }
    const h = await sha(pin); try { localStorage.setItem(PIN_KEY, h); } catch { /* */ } setPinHash(h);
  }, []);
  const unlock = useCallback(async (pin) => { if ((await sha(pin)) === pinHash) { setLocked(false); return true; } return false; }, [pinHash]);
  const lock = useCallback(() => { if (pinHash) setLocked(true); }, [pinHash]);

  const value = useMemo(() => ({ session, login, logout, locked, hasPin: !!pinHash, setPin, unlock, lock }), [session, login, logout, locked, pinHash, setPin, unlock, lock]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
