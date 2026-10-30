// Repeating two-tone ring for as long as an order waits for the chemist. Stops the moment he responds.
let ctx = null, timer = null;

function beep() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime;
    [[880, 0], [660, 0.32]].forEach(([f, off]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "square"; o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, t + off);
      g.gain.exponentialRampToValueAtTime(0.35, t + off + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.28);
      o.start(t + off); o.stop(t + off + 0.3);
    });
  } catch { /* no audio device: the flashing banner and the window pop-up still tell him */ }
}
export function startRing() { if (timer) return; beep(); timer = setInterval(beep, 1500); }
export function stopRing() { if (timer) { clearInterval(timer); timer = null; } }
export const isRinging = () => timer !== null;
export const testBeep = beep;
