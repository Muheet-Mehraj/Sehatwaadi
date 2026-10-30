// "New order assigned" alarm: vibration + a looping beep (WebAudio) + a system notification when permitted.
// On the Android app the notification is a native local notification on a max-importance channel, so it rings and
// pops up even when the app is in the background (the beep and vibration only run while the app is open).
import { LocalNotifications } from "@capacitor/local-notifications";
import { isNative } from "./platform.js";
import { hapticHeavy } from "./native.js";

let ctx = null, stopTimer = null, channelReady = false;
const CHANNEL = "orders";

export function ringAlarm(ms = 6000) {
  hapticHeavy();
  try { navigator.vibrate?.([400, 200, 400, 200, 800]); } catch { /* ignore */ }
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const start = ctx.currentTime; const beeps = Math.ceil(ms / 600);
    for (let i = 0; i < beeps; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = i % 2 ? 880 : 660; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.25, start + i * 0.6); g.gain.setValueAtTime(0, start + i * 0.6 + 0.4); o.start(start + i * 0.6); o.stop(start + i * 0.6 + 0.45);
    }
  } catch { /* autoplay blocked: vibration + the banner still tell the rider */ }
  clearTimeout(stopTimer); stopTimer = setTimeout(() => stopAlarm(), ms);
}
export function stopAlarm() { try { navigator.vibrate?.(0); } catch { /* ignore */ } try { ctx?.close(); } catch { /* ignore */ } ctx = null; }

async function ensureChannel() {
  if (channelReady || !isNative()) return;
  try { await LocalNotifications.createChannel({ id: CHANNEL, name: "New orders", description: "Alerts when an order is assigned to you", importance: 5, visibility: 1, vibration: true }); channelReady = true; } catch { /* ignore */ }
}

export async function notify(title, body) {
  try {
    if (isNative()) {
      await ensureChannel();
      await LocalNotifications.schedule({ notifications: [{ id: Math.floor(Date.now() % 2147483000), title, body, channelId: CHANNEL, autoCancel: true }] });
      return;
    }
    if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body, tag: "swr-order" });
  } catch { /* ignore */ }
}

// Android 13+ needs the notification permission for the "you're online" location notification as well as for order alerts.
export const askNotificationPermission = async () => {
  try {
    if (isNative()) { const p = await LocalNotifications.checkPermissions(); if (p.display !== "granted") await LocalNotifications.requestPermissions(); await ensureChannel(); return; }
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  } catch { /* ignore */ }
};
