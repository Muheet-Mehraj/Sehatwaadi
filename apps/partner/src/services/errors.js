const TEXT = {
  network: "No signal. Your action was not sent. Try again when you're back online.",
  not_authenticated: "Your session expired. Please sign in again.",
  forbidden: "You don't have permission to do that.",
  server: "Something went wrong on our side. Try again.",
  not_verified: "Your account is still being verified by SehatWaadi.",
  suspended: "Your account is suspended. Contact support.",
  on_delivery: "Finish your current order first.",
  invalid_state: "This order has moved on. Refreshing…",
  not_authorized: "This order is not assigned to you.",
  invalid_otp: "That code is wrong.", otp_locked: "Too many wrong codes. The pharmacy has been alerted; contact support.",
  qr_mismatch: "That QR doesn't match this order. Ask the pharmacy to show the right one.", qr_locked: "Too many wrong scans. Contact the pharmacy.",
  qr_not_available: "The pharmacy hasn't generated the QR yet. Ask them to open it.",
  manual_not_allowed: "Pickup needs the pharmacy's QR code.",
  payment_mismatch: "This order was already paid online. Collect no cash.",
  payment_not_verified: "UPI payment isn't confirmed yet. Collect cash, or wait for confirmation.",
  invalid_payment_mode: "Invalid payment mode.", invalid_issue_type: "Choose an issue type.",
  invalid_amount: "Enter a valid amount.", invalid_upi_ref: "Enter the 12-digit UPI reference (UTR) from your payment app.", invalid_reference: "Enter the 12-digit UPI reference (UTR) from your payment app.", duplicate_reference: "That UPI reference has already been used.", amount_exceeds_cash: "That's more than the cash you hold.",
  offer_taken: "Another rider accepted this order first.", offer_expired: "That offer has expired.", offer_closed: "That offer is no longer available.", offer_not_found: "That offer is no longer available.",
  rider_not_available: "Go online (and stay verified) to accept orders.", cash_limit: "You're holding too much cash for a cash-on-delivery order. Deposit it first.", already_on_delivery: "Finish your current order first.",
  invalid_reason: "Choose a reason.", notes_too_long: "Keep the details under 300 characters.", cancel_after_pickup: "You've already collected the medicines, so you can't cancel. Use Report a problem and the pharmacy will arrange a handover.",
  kyc_locked: "Your documents are with SehatWaadi for review. You can change them if they are sent back.",
  invalid_image: "That picture could not be used. Take it again.", image_too_large: "That picture is too large. Take it again.", invalid_document: "That document isn't needed for your vehicle.",
  documents_missing: "Some documents are still missing.", invalid_dob: "Check your date of birth (you must be 18 or older).", invalid_aadhaar: "Check your Aadhaar number.",
  invalid_pan: "Check your PAN. It looks like ABCPE1234F.", invalid_dl: "Check your driving licence number.", invalid_dl_expiry: "Check the licence expiry date.", dl_expired: "Your driving licence has expired.",
  pan_in_use: "This PAN is already registered with another rider. Contact support if that is a mistake.", dl_in_use: "This driving licence is already registered with another rider. Contact support if that is a mistake.",
  rate_limited: "Too many attempts. Wait a minute and try again.", invalid_code: "That sign-in code is wrong or expired.",
};
export function errorText(res) {
  if (!res || res.ok !== false) return "";
  const base = TEXT[res.error] || `Couldn't complete that (${res.error || "error"}).`;
  const left = res.attemptsLeft ?? res.attempts_left ?? res.left;
  return res.error === "invalid_otp" && left != null ? `${base} ${left} ${left === 1 ? "try" : "tries"} left.` : base;
}
export const isRetryable = (res) => res?.error === "network" || res?.error === "server";
