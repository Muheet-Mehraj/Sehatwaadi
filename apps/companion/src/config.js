// Settings kept on this PC: where the Hub is, who the shop is, and the counter PIN (stored as a hash, never in clear).
const K = { hub: "sw.hubUrl", creds: "sw.creds", pin: "sw.pinHash", paused: "sw.paused" };
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked: the app still works, just asks to sign in again */ } };

export const DEFAULT_HUB = (import.meta.env && import.meta.env.VITE_HUB_URL) || "http://localhost:8080";
export const getHubUrl = () => (read(K.hub) || DEFAULT_HUB).replace(/\/+$/, "");
export const setHubUrl = (u) => write(K.hub, String(u || "").trim().replace(/\/+$/, "") || null);

export function getCreds() { try { const c = JSON.parse(read(K.creds) || "null"); return c && c.pharmacyId && c.apiKey ? c : null; } catch { return null; } }
export const setCreds = (c) => write(K.creds, c ? JSON.stringify({ pharmacyId: c.pharmacyId, apiKey: c.apiKey, name: c.name || "" }) : null);

export const getPaused = () => read(K.paused) === "1";
export const setPaused = (p) => write(K.paused, p ? "1" : null);

async function sha(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`sw-pin:${text}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const hasPin = () => Boolean(read(K.pin));
export async function setPin(pin) { write(K.pin, pin ? await sha(pin) : null); }
export async function checkPin(pin) { return (await sha(pin)) === read(K.pin); }

// Ticks survive a reload or a crash mid-pick, per order.
export const loadTicks = (orderId) => { try { return JSON.parse(read(`sw.ticks.${orderId}`) || "[]"); } catch { return []; } };
export const saveTicks = (orderId, ticks) => write(`sw.ticks.${orderId}`, ticks.length ? JSON.stringify(ticks) : null);
export const clearTicks = (orderId) => write(`sw.ticks.${orderId}`, null);
