// localStorage can be missing or throw (private windows, blocked storage), so every access is guarded.
export function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}
export function remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }

export const CONFIG_KEY = "swc.config";
export const PAUSED_KEY = "swc.paused";
export const ticksKey = (orderId) => `swc.ticks.${orderId}`;
