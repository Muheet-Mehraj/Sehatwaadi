// Where is the rider search for a delivery that has no rider yet? The Hub only sends counts (never which riders are being asked).
// In the old "assign instantly" mode none of these fields exist, so this returns null and the screens show what they always showed.
export function searchState(d) {
  if (!d || d.riders) return null;
  if (d.dispatch_exhausted_at) return { kind: "none", text: "No rider has accepted yet. We keep searching: keep the order packed and ready." };
  const n = Number(d.live_offers) || 0;
  if (n > 0) return { kind: "asking", text: `Asking ${n} nearby rider${n === 1 ? "" : "s"} to accept (search ${Math.max(1, Number(d.dispatch_round) || 1)})…` };
  return null;
}
