// Repeating two-tone alarm for incoming orders. Browsers only allow sound after the person has interacted with the page,
// so unlock() is called from the login click; inside the desktop app the window is also forced to the front.
let ctx = null, timer = null, on = false;

export function unlock() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
  } catch { /* no audio available */ }
}

function chime() {
  if (!ctx) return;
  const t0 = ctx.currentTime;
  [[880, 0], [660, 0.28], [880, 0.56], [660, 0.84]].forEach(([f, d]) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine"; o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, t0 + d);
    g.gain.exponentialRampToValueAtTime(0.6, t0 + d + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.24);
    o.start(t0 + d); o.stop(t0 + d + 0.26);
  });
}

export function startRinging() {
  if (on) return;
  on = true; unlock(); chime();
  timer = setInterval(chime, 2200);
  try { window.companion && window.companion.ring(true); } catch { /* ignore */ }
}
export function stopRinging() {
  if (!on) return;
  on = false; clearInterval(timer); timer = null;
  try { window.companion && window.companion.ring(false); } catch { /* ignore */ }
}
export const isRinging = () => on;
