// Pure trip logic (no React, no network). The SERVER is the source of truth; this only translates its job into screens.
export const STEPS = {
  IDLE: "IDLE", EN_ROUTE_TO_PHARMACY: "EN_ROUTE_TO_PHARMACY", PICKUP_VERIFICATION: "PICKUP_VERIFICATION",
  EN_ROUTE_TO_CUSTOMER: "EN_ROUTE_TO_CUSTOMER", DROPOFF_OTP: "DROPOFF_OTP", RETURNING_TO_PHARMACY: "RETURNING_TO_PHARMACY",
};
// job = { status, arrivedAtCustomer, order } as returned by get_active_delivery
export function stepFromJob(job) {
  if (!job) return STEPS.IDLE;
  switch (job.status) {
    case "ACCEPTED": return STEPS.EN_ROUTE_TO_PHARMACY;
    case "ARRIVED_AT_PHARMACY": return STEPS.PICKUP_VERIFICATION;
    case "PICKED_UP": return job.arrivedAtCustomer ? STEPS.DROPOFF_OTP : STEPS.EN_ROUTE_TO_CUSTOMER;
    case "RETURNING_TO_PHARMACY": return STEPS.RETURNING_TO_PHARMACY;
    default: return STEPS.IDLE;
  }
}
export const STEP_TITLE = {
  IDLE: "No active order", EN_ROUTE_TO_PHARMACY: "Head to the pharmacy", PICKUP_VERIFICATION: "Scan the pharmacy's QR",
  EN_ROUTE_TO_CUSTOMER: "Deliver to the customer", DROPOFF_OTP: "Hand over & verify", RETURNING_TO_PHARMACY: "Return the sealed bag",
};
// where the rider is going next
export function destinationFor(step, order) {
  if (!order) return null;
  if (step === STEPS.EN_ROUTE_TO_PHARMACY || step === STEPS.PICKUP_VERIFICATION || step === STEPS.RETURNING_TO_PHARMACY) {
    const p = order.pharmacy || {}; return { kind: "pharmacy", label: p.name, address: p.address, phone: p.phone, lat: p.lat, lng: p.lng };
  }
  const c = order.customer || {}; return { kind: "customer", label: c.name, address: c.address, landmark: c.landmark, phone: c.phone, lat: c.lat, lng: c.lng };
}
// what to collect at the door. The server decides; a UPI payment only counts once the platform has verified it.
export function paymentPlan(order) {
  const pay = order?.payment || {};
  if (pay.verified) return { mode: pay.mode, collect: 0, needsCash: false, label: pay.mode === "PREPAID" ? "Prepaid: collect nothing" : "Paid by UPI: collect nothing" };
  const collect = Number(order?.cashToCollect ?? pay.amountCollected ?? 0);
  return { mode: "CASH", collect, needsCash: true, label: `Collect ₹${collect.toFixed(0)} in cash` };
}
export const issueOptionsFor = (step) => step === STEPS.DROPOFF_OTP || step === STEPS.EN_ROUTE_TO_CUSTOMER
  ? ["VEHICLE_BREAKDOWN", "ACCIDENT", "CUSTOMER_UNREACHABLE"] : ["VEHICLE_BREAKDOWN", "ACCIDENT"];
// A rider may cancel only BEFORE they have the medicines. After pickup the server refuses (cancel_after_pickup): report a problem instead.
export const canRiderCancel = (step) => step === STEPS.EN_ROUTE_TO_PHARMACY || step === STEPS.PICKUP_VERIFICATION;
export const CANCEL_REASONS = [["VEHICLE_ISSUE", "Vehicle problem"], ["PERSONAL_EMERGENCY", "Personal emergency"], ["TOO_FAR", "Pickup is too far"], ["PHARMACY_DELAY", "Pharmacy is delaying me"], ["OTHER", "Other reason"]];
export const isValidOtp = (s, len = 4) => new RegExp(`^\\d{${len}}$`).test(String(s || ""));
export const looksLikeQr = (s) => /^SW1\.[0-9a-f-]{36}\.[0-9a-f]{16,64}$/i.test(String(s || "").trim());
export const qrBelongsTo = (qr, deliveryId) => String(qr || "").split(".")[1] === deliveryId;   // cheap client check before spending a server attempt
