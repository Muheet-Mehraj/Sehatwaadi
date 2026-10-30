// Pure rules for the tick-to-pick screen. No React, so they can be tested on their own.
export const keyOf = (name) => String(name || "").trim().toLowerCase();

// "OFFERED" until the chemist opens the order, "PICKING" after, then handed to the Hub on dispatch.
export const stageOf = (order) => (order && order.pickingStarted ? "PICKING" : "OFFERED");

export function canDispatch({ lines = [], ticked = {}, requiresRx = false, rxStatus = "NOT_REQUIRED" } = {}) {
  if (!lines.length) return { ok: false, reason: "This order has no items." };
  if (requiresRx && rxStatus !== "VERIFIED") return { ok: false, reason: "Check the prescription first." };
  const left = lines.filter((l) => !ticked[keyOf(l.name)]).length;
  if (left > 0) return { ok: false, reason: `${left} item${left === 1 ? "" : "s"} still to pick.`, left };
  return { ok: true, left: 0 };
}

export const packedNames = (lines, ticked) => lines.filter((l) => ticked[keyOf(l.name)]).map((l) => l.name);

// Seconds left until a deadline timestamp (ms). Never negative.
export const secondsLeft = (deadlineMs, now = Date.now()) => Math.max(0, Math.ceil((deadlineMs - now) / 1000));

// Soft warning once 70% of the picking window has gone.
export function timerState({ deadlineMs, totalSeconds, now = Date.now() }) {
  const left = secondsLeft(deadlineMs, now);
  if (left <= 0) return "expired";
  if (totalSeconds > 0 && (totalSeconds - left) / totalSeconds >= 0.7) return "warn";
  return "ok";
}

export const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
