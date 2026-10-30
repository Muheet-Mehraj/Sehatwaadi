// Pure wallet / cash-settlement logic (no React, no network). The server owns the numbers; this only explains them to the rider.
export const WARN_PCT = 70, CRITICAL_PCT = 90;

// rider = { cashInHand, maxFloatingCash, pendingSettlement, codBlocked, earningsBalance }
export function cashStatus(rider) {
  const limit = Number(rider?.maxFloatingCash) || 0;
  const cash = Number(rider?.cashInHand) || 0;
  const pending = Number(rider?.pendingSettlement) || 0;
  const due = Math.max(0, round2(cash - pending));            // cash not yet covered by a submitted deposit
  const pct = limit > 0 ? Math.min(100, Math.round((cash / limit) * 100)) : 0;
  const level = rider?.codBlocked || pct >= 100 ? "blocked" : pct >= CRITICAL_PCT ? "critical" : pct >= WARN_PCT ? "warn" : "ok";
  const room = Math.max(0, round2(limit - cash));             // how much more cash can be collected before COD pauses
  return { limit, cash, pending, due, pct, level, room, canSettle: due > 0 };
}
const round2 = (n) => Math.round(n * 100) / 100;

export const LEVEL_TEXT = {
  ok: null,
  warn: "You're holding a lot of cash. Deposit soon to keep getting cash-on-delivery orders.",
  critical: "Almost at your cash limit. Deposit now. Cash-on-delivery orders pause at the limit.",
  blocked: "Cash-on-delivery orders are paused until you deposit. Prepaid orders still come through.",
};

// "1,200" / "₹1200.50" / "abc" -> 1200 / 1200.5 / 0
export const parseAmount = (s) => { const n = Number(String(s ?? "").replace(/[^\d.]/g, "")); return Number.isFinite(n) ? round2(n) : 0; };
// A payment reference (UPI transaction id / UTR) is exactly 12 digits. Same rule as the server (valid_payment_ref), so the rider is told
// before sending: spaces are ignored; one repeated digit, runs (123456789012) and repeated blocks (121212121212) are refused as made-up.
export const cleanPaymentRef = (s) => String(s ?? "").replace(/\s+/g, "");
export const validUpiRef = (s) => {
  const r = cleanPaymentRef(s);
  if (!/^[0-9]{12}$/.test(r)) return false;
  if (/^([0-9]{1,6})\1+$/.test(r)) return false;
  return !("01234567890123456789".includes(r) || "98765432109876543210".includes(r));
};
// What to tell the rider while they type (null = nothing to say yet / looks fine)
export const refHint = (s) => {
  const r = cleanPaymentRef(s);
  if (!r) return null;
  if (/[^0-9]/.test(r)) return "The UPI reference is 12 digits, with no letters.";
  if (r.length < 12) return `${12 - r.length} more digit${12 - r.length === 1 ? "" : "s"} to go. The UPI reference has 12 digits.`;
  if (r.length > 12) return "That's more than 12 digits. Check the reference in your payment app.";
  return validUpiRef(r) ? null : "That doesn't look like a real UPI reference. Copy it from your payment app.";
};
export const canSubmitDeposit = (amount, due, ref) => amount > 0 && amount <= due && validUpiRef(ref);

// Quick-pick chips for the deposit sheet: the full amount first, then round figures that are smaller.
export function quickAmounts(due) {
  const out = []; if (due > 0) out.push({ key: "full", label: "Full amount", value: due });
  for (const v of [500, 1000, 2000]) if (v < due) out.push({ key: String(v), label: `₹${v}`, value: v });
  return out;
}

const LABELS = {
  COD_COLLECTED: "Cash collected", CASH_COLLECTED: "Cash collected", COD: "Cash collected",
  SETTLEMENT: "Cash deposited", CASH_SETTLEMENT: "Cash deposited", SETTLEMENT_PENDING: "Deposit submitted", SETTLEMENT_CONFIRMED: "Deposit verified", SETTLEMENT_REJECTED: "Deposit rejected",
  COD_FEE_KEPT: "Your delivery fee",
  EARNING: "Delivery earning", EARNINGS: "Delivery earning", DELIVERY_EARNING: "Delivery fee earned", RETURN_EARNING: "Return trip fee", PAYOUT: "Earnings payout",
  ADJUSTMENT: "Adjustment", BONUS: "Bonus", PENALTY: "Penalty", RETURN: "Returned order",
};
export const ledgerLabel = (type) => LABELS[String(type || "").toUpperCase()] || String(type || "Entry").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
// signed amount for display: "+₹40" / "-₹760"
export const signedAmount = (n) => { const v = Number(n) || 0; return `${v < 0 ? "-" : "+"}₹${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; };

// One plain sentence under each history line, so a rider never has to guess whose money it is.
const HELP = {
  COD_COLLECTED: "The order amount you took in cash. It belongs to SehatWaadi. Deposit it by UPI.",
  CASH_COLLECTED: "The order amount you took in cash. It belongs to SehatWaadi. Deposit it by UPI.",
  COD: "The order amount you took in cash. It belongs to SehatWaadi. Deposit it by UPI.",
  COD_FEE_KEPT: "Yours. Keep it out of the cash you collected, nothing to pay back.",
  DELIVERY_EARNING: "The customer paid online, so SehatWaadi pays you this fee.",
  RETURN_EARNING: "Fee for the return trip. SehatWaadi pays you this.",
  CASH_SETTLEMENT: "You paid this to SehatWaadi. It lowers the cash you hold.",
  SETTLEMENT: "You paid this to SehatWaadi. It lowers the cash you hold.",
  PAYOUT: "SehatWaadi paid your earnings out to you.",
};
export const ledgerHelp = (type) => HELP[String(type || "").toUpperCase()] || "";
const rupees = (n) => `₹${Math.abs(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
// What a history line did to the rider: { text, tone } where tone is earn (green: money that is yours), cash (neutral: SehatWaadi's money you hold), paid (you paid it in)
export function ledgerEffect(e) {
  const t = String(e?.entry_type || "").toUpperCase(); const a = Number(e?.amount) || 0;
  if (t === "COD_FEE_KEPT") return { text: `You keep ${rupees(a)}`, tone: "earn" };
  if (t === "DELIVERY_EARNING" || t === "RETURN_EARNING") return { text: `You earn ${rupees(a)}`, tone: "earn" };
  if (t === "COD_COLLECTED" || t === "CASH_COLLECTED" || t === "COD") return { text: `Cash held +${rupees(a)}`, tone: "cash" };
  if (t === "CASH_SETTLEMENT" || t === "SETTLEMENT") return { text: `Cash held -${rupees(a)}`, tone: "paid" };
  return { text: signedAmount(a), tone: a < 0 ? "paid" : "earn" };
}

// ---- "what have I earned": cash-order fees the rider kept + online-order fees SehatWaadi pays him ----
export const RANGES = [{ key: "today", label: "Today" }, { key: "week", label: "Last 7 days" }, { key: "all", label: "All time" }];
// summary = the server's get_my_earnings answer. null/undefined (older server) -> null, and the app falls back to the simple wallet.
export function earningsView(summary, range = "today") {
  const b = summary && summary[range]; if (!b) return null;
  const kept = round2(Number(b.keptFromCash) || 0), credited = round2(Number(b.credited) || 0);
  return { kept, credited, total: round2(kept + credited), deliveries: Number(b.deliveries) || 0, owedToRider: round2(Number(summary.owedToRider) || 0) };
}

// The line shown after a delivery is finished (dashboard banner)
export function deliveredMessage(result) {
  const fee = rupees(result?.earnings);
  return String(result?.paymentMode || "").toUpperCase() === "CASH"
    ? `Delivered ✓ Your delivery fee is ${fee}. Keep it out of the cash you collected. Deposit the rest to SehatWaadi.`
    : `Delivered ✓ ${fee} added to what SehatWaadi will pay you. You hold no cash for this order.`;
}
