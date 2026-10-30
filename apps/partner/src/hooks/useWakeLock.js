import { useEffect } from "react";
import { KeepAwake } from "@capacitor-community/keep-awake";
import { isNative } from "../services/platform.js";
// Keep the screen awake while it matters. Web: the whole time the rider is working (a sleeping tab loses GPS).
// Android app: only during a delivery (navigation); the foreground location service keeps GPS alive with the screen off.
// Silently does nothing where unsupported.
export function useWakeLock(enabled) {
  useEffect(() => {
    if (!enabled) return undefined;
    if (isNative()) { KeepAwake.keepAwake().catch(() => {}); return () => { KeepAwake.allowSleep().catch(() => {}); }; }
    if (!("wakeLock" in navigator)) return undefined;
    let lock = null, cancelled = false;
    const acquire = async () => { try { lock = await navigator.wakeLock.request("screen"); } catch { /* denied / battery saver */ } };
    const onVis = () => { if (document.visibilityState === "visible" && !cancelled) acquire(); };
    acquire(); document.addEventListener("visibilitychange", onVis);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", onVis); try { lock?.release(); } catch { /* ignore */ } };
  }, [enabled]);
}
