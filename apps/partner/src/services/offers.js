// Pure offer logic (no React, no network). The SERVER decides everything (who may accept, when an offer ends); this only turns
// the server's answer into something to draw on screen.

// The server says "N seconds left" (measured on ITS clock). We convert that to a deadline on OUR clock using the moment we
// ASKED, so network latency can only make us stop a little early, never late. Phone clock errors therefore don't matter.
export const localDeadline = (requestedAtMs, secondsLeft) => requestedAtMs + Math.max(0, Number(secondsLeft) || 0) * 1000;
export const remainingMs = (deadlineMs, nowMs = Date.now()) => Math.max(0, deadlineMs - nowMs);
export const remainingSeconds = (deadlineMs, nowMs = Date.now()) => Math.ceil(remainingMs(deadlineMs, nowMs) / 1000);
export const isLive = (offer, nowMs = Date.now()) => !!offer && remainingMs(offer.deadlineMs, nowMs) > 0;
// 0..1 for the countdown bar
export const fractionLeft = (offer, nowMs = Date.now()) => {
  const total = Math.max(1, Number(offer?.windowSeconds) || 15) * 1000;
  return Math.min(1, remainingMs(offer?.deadlineMs ?? 0, nowMs) / total);
};
// An offer we were showing disappeared and WE didn't act on it. If it vanished before our own deadline another rider (or the
// system) took it; if the clock ran out it simply lapsed.
export const endedKind = (offer, nowMs = Date.now()) => (offer && nowMs >= offer.deadlineMs - 800 ? "expired" : "taken");
export const ENDED_TEXT = {
  taken: "Another rider accepted this order first. Stay online: more are coming.",
  expired: "That offer expired.",
};
