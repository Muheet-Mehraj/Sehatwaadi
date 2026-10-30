// What the Settlement screen says for each state of a payout. The numbers always come from the Hub; this only words them.
export const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// 1 = you claimed it, 2 = SehatWaadi paid it, 3 = you confirmed it
export const stepOf = (status) => ({ REQUESTED: 1, PAID: 2, DISPUTED: 2, CONFIRMED: 3, CANCELLED: 0 }[status] ?? 0);

export const STATUS_TEXT = {
  REQUESTED: "Waiting for SehatWaadi to pay you",
  PAID: "SehatWaadi says it has paid you. Please check your account.",
  DISPUTED: "You told us you did not receive it. SehatWaadi will check and pay again.",
  CONFIRMED: "Settled",
  CANCELLED: "Cancelled",
};

// which buttons the chemist may press for an open claim
export const actionsFor = (status) => ({ withdraw: status === "REQUESTED", confirm: status === "PAID", dispute: status === "PAID" });

export const canClaim = (summary) => !!summary && !summary.open && Number(summary.unsettled?.amount) > 0 && Number(summary.unsettled?.orders) > 0;

// "Not received" needs a short reason (the database requires 3+ characters)
export const validDisputeNote = (s) => String(s || "").trim().length >= 3;
