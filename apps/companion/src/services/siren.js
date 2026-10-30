// Repeating two-tone chime for incoming orders. Browsers only allow sound after a click, so unlockAudio() runs on the
// first pointer event; the Electron/Tauri wrapper can remove that limit (see README).
let ctx = null, timer = null;
const AC = () => window.AudioContext || window.webkitAudioContext;

export function unlockAudio() {
  try { ctx = ctx || new (AC())(); if (ctx.state === "suspended") ctx.resume(); } catch { /* no audio */ }
}
export const audioReady = () => !!ctx && ctx.state === "running";

function beep(freq, at, len = 0.28) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = "sine"; o.frequency.value = freq; o.connect(g); g.connect(ctx.destination);
  g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.5, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  o.start(at); o.stop(at + len + 0.02);
}
export function startSiren() {
  if (timer) return;
  const ring = () => { try { unlockAudio(); if (!ctx || ctx.state !== "running") return; const t = ctx.currentTime; beep(880, t); beep(660, t + 0.35); beep(880, t + 0.7); beep(660, t + 1.05); } catch { /* ignore */ } };
  ring(); timer = setInterval(ring, 2200);
}
export function stopSiren() { clearInterval(timer); timer = null; }
