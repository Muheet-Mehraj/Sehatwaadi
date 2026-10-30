// Push notifications (Firebase Cloud Messaging) for the installed Android app.
// The Hub sends a HIGH-priority push the moment an order is offered to this rider, so Android shows it with sound even when the
// app is closed or the screen is off. Tapping it (or receiving it while the app is open) just asks the server "what is my offer now?":
// the push carries no authority, the server's answer is still the only truth.
import { PushNotifications } from "@capacitor/push-notifications";
import { isNative } from "./platform.js";

// Channels must exist BEFORE the first push arrives, otherwise Android drops it into a quiet default channel.
export const OFFER_CHANNEL = { id: "offers", name: "New order offers", description: "Rings when an order is offered to you", importance: 5, visibility: 1, vibration: true, lights: true };
export const JOB_CHANNEL = { id: "jobs", name: "Assigned orders", description: "When an order is assigned to you", importance: 5, visibility: 1, vibration: true, lights: true };

export function createPush({ plugin = PushNotifications, native = isNative } = {}) {
  let handles = [], token = null, started = false, lastError = null;

  // callbacks: onToken(token) when Firebase gives (or rotates) this phone's token; onWake(data, how) when a push arrives or is tapped.
  async function start({ onToken, onWake } = {}) {
    if (!native()) return { ok: false, reason: "not_native" };
    if (started) return { ok: true, already: true };
    started = true;
    try {
      await plugin.createChannel(OFFER_CHANNEL); await plugin.createChannel(JOB_CHANNEL);
      handles.push(await plugin.addListener("registration", (t) => { token = t?.value || null; lastError = null; if (token) onToken?.(token); }));
      handles.push(await plugin.addListener("registrationError", (e) => { lastError = e?.error || "registration_failed"; }));
      handles.push(await plugin.addListener("pushNotificationReceived", (n) => onWake?.(n?.data || {}, "foreground")));
      handles.push(await plugin.addListener("pushNotificationActionPerformed", (a) => onWake?.(a?.notification?.data || {}, "tap")));
      let perm = await plugin.checkPermissions();
      if (perm.receive !== "granted") perm = await plugin.requestPermissions();   // Android 13+ asks the rider once
      if (perm.receive !== "granted") { lastError = "permission_denied"; return { ok: false, reason: "permission_denied" }; }
      await plugin.register();
      return { ok: true };
    } catch (e) { started = false; lastError = e?.message || "push_failed"; return { ok: false, reason: lastError }; }
  }

  async function stop() {
    const hs = handles; handles = []; started = false;
    for (const h of hs) { try { await h?.remove?.(); } catch { /* ignore */ } }
  }
  // Remove any offer notifications still in the tray (the offer is over, or the rider is looking at the app).
  const clearDelivered = async () => { if (!native()) return; try { await plugin.removeAllDeliveredNotifications(); } catch { /* ignore */ } };

  return { start, stop, clearDelivered, currentToken: () => token, lastError: () => lastError };
}
export const push = createPush();
