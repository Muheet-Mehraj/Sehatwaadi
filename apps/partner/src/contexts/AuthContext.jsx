import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { push } from "../services/push.js";
const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);
export function AuthProvider({ api, children }) {
  const [session, setSession] = useState(undefined);   // undefined = loading
  useEffect(() => { let on = true; api.getSession().then((s) => on && setSession(s || null)); const off = api.onAuthChange((s) => on && setSession(s || null)); return () => { on = false; off(); }; }, [api]);
  const signOut = useCallback(async () => {
    // this phone must stop receiving the previous rider's offers (best-effort: needs the session, so it goes BEFORE sign-out)
    try { const t = push.currentToken(); if (t) await api.unregisterPushDevice?.(t); } catch { /* ignore */ }
    await push.stop();
    await api.signOut(); setSession(null);
  }, [api]);
  return <Ctx.Provider value={{ api, session, signOut, loading: session === undefined }}>{children}</Ctx.Provider>;
}
