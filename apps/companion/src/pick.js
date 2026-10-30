// Pure rules for the picking screen. No React, no network, so they can be tested on their own.
export const key = (s) => String(s || "").trim().toLowerCase();

export const allTicked = (lines, ticked) => lines.length > 0 && lines.every((l) => ticked.includes(key(l.name)));

// Dispatch is possible only while PICKING, with the prescription verified (when one is needed) and every line packed.
export function canDispatch({ lines, ticked, requiresRx, rxVerified, stage }) {
  return stage === "PICKING" && (!requiresRx || rxVerified) && allTicked(lines, ticked);
}

export const secondsLeft = (deadlineAt, now = Date.now()) => Math.max(0, Math.ceil((deadlineAt - now) / 1000));

// "ok" until 70% of the window has gone, then "warn", then "over".
export function timerTone(left, windowSeconds) {
  if (left <= 0) return "over";
  if (!windowSeconds) return "ok";
  return left <= windowSeconds * 0.3 ? "warn" : "ok";
}

export const nextUntickedIndex = (lines, ticked) => lines.findIndex((l) => !ticked.includes(key(l.name)));

export const fmtClock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const QR_RE = /^SW1\.[0-9a-f-]{36}\.[0-9a-f]{16,64}$/i;
// The Hub returns the pickup/return QR text inside a JSON object whose exact field name is owned by the delivery SQL.
// Find the string that has the rider app's format instead of depending on the field name.
export function findQr(value, depth = 0) {
  if (depth > 4 || value == null) return null;
  if (typeof value === "string") return QR_RE.test(value) ? value : null;
  if (typeof value === "object") for (const v of Object.values(value)) { const f = findQr(v, depth + 1); if (f) return f; }
  return null;
}

export const money = (n) => (n == null || Number.isNaN(Number(n)) ? "-" : `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

// Active-delivery statuses worth showing a chemist, in trip order.
export const TRIP = ["DISPATCHED", "ACCEPTED", "ARRIVED_AT_PHARMACY", "PICKED_UP", "RETURNING_TO_PHARMACY"];
export const tripLabel = {
  DISPATCHED: "Finding a rider", ACCEPTED: "Rider on the way", ARRIVED_AT_PHARMACY: "Rider at your counter",
  PICKED_UP: "Out for delivery", RETURNING_TO_PHARMACY: "Returning to you",
};
