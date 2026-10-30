import { describe, it, expect } from "vitest";
import { cashStatus, parseAmount, validUpiRef, refHint, cleanPaymentRef, canSubmitDeposit, quickAmounts, ledgerLabel, signedAmount, ledgerHelp, ledgerEffect, earningsView, deliveredMessage, RANGES } from "../src/services/wallet.js";

describe("cash status", () => {
  const r = (o) => ({ cashInHand: 0, maxFloatingCash: 2000, pendingSettlement: 0, codBlocked: false, ...o });
  it("levels follow the share of the limit used", () => {
    expect(cashStatus(r({ cashInHand: 500 })).level).toBe("ok");
    expect(cashStatus(r({ cashInHand: 1400 })).level).toBe("warn");
    expect(cashStatus(r({ cashInHand: 1800 })).level).toBe("critical");
    expect(cashStatus(r({ cashInHand: 2000 })).level).toBe("blocked");
    expect(cashStatus(r({ cashInHand: 100, codBlocked: true })).level).toBe("blocked");
  });
  it("due excludes deposits already submitted; room is what's left under the limit", () => {
    const s = cashStatus(r({ cashInHand: 760, pendingSettlement: 300 }));
    expect(s).toMatchObject({ due: 460, room: 1240, pct: 38, canSettle: true });
    expect(cashStatus(r({ cashInHand: 760, pendingSettlement: 760 })).canSettle).toBe(false);
  });
  it("copes with missing or zero limits", () => {
    expect(cashStatus({}).pct).toBe(0);
    expect(cashStatus(r({ maxFloatingCash: 0, cashInHand: 50 })).level).toBe("ok");
  });
});

describe("deposit input", () => {
  it("parses amounts leniently", () => { expect(parseAmount("₹1,200.50")).toBe(1200.5); expect(parseAmount("abc")).toBe(0); expect(parseAmount("")).toBe(0); });
  it("accepts only a real-looking 12-digit UPI reference (same rule as the server)", () => {
    for (const ok of ["412345678901", "482910557301", " 4829 1055 7301 "]) expect(validUpiRef(ok)).toBe(true);
    for (const bad of ["", "12345", "AXIS-1234", "UPIREF000001", "48291055730", "4829105573011", "48291055730a", "111111111111", "000000000000", "123456789012", "987654321098", "121212121212", "123123123123", "123456123456"])
      expect(validUpiRef(bad)).toBe(false);
    expect(cleanPaymentRef(" 4829 1055\t7301 ")).toBe("482910557301");
  });
  it("tells the rider what is wrong while they type", () => {
    expect(refHint("")).toBeNull(); expect(refHint("482910557301")).toBeNull();
    expect(refHint("4829")).toMatch(/8 more digits/); expect(refHint("48291055730")).toMatch(/1 more digit to go/);
    expect(refHint("48291055730123")).toMatch(/more than 12/); expect(refHint("UPI123")).toMatch(/no letters/); expect(refHint("123456789012")).toMatch(/doesn't look like a real/);
  });
  it("only allows a deposit within what is held, with a valid reference", () => {
    expect(canSubmitDeposit(500, 760, "412345678901")).toBe(true);
    expect(canSubmitDeposit(800, 760, "412345678901")).toBe(false);
    expect(canSubmitDeposit(0, 760, "412345678901")).toBe(false);
    expect(canSubmitDeposit(500, 760, "123")).toBe(false);
  });
  it("quick amounts: full first, then smaller round figures", () => {
    expect(quickAmounts(760).map((q) => q.value)).toEqual([760, 500]);
    expect(quickAmounts(3000).map((q) => q.value)).toEqual([3000, 500, 1000, 2000]);
    expect(quickAmounts(0)).toEqual([]);
  });
});

describe("ledger display", () => {
  it("labels known types and humanises unknown ones", () => { expect(ledgerLabel("COD_COLLECTED")).toBe("Cash collected"); expect(ledgerLabel("some_new_type")).toBe("Some new type"); });
  it("signs amounts", () => { expect(signedAmount(40)).toBe("+₹40"); expect(signedAmount(-760)).toBe("-₹760"); });
});

describe("earnings made clear", () => {
  const sum = { today: { keptFromCash: 80, credited: 40, deliveries: 3 }, week: { keptFromCash: 200, credited: 0, deliveries: 5 }, all: { keptFromCash: 0, credited: 0, deliveries: 0 }, owedToRider: 40, cashInHand: 0 };
  it("total = fees kept from cash orders + fees SehatWaadi pays you", () => {
    expect(earningsView(sum, "today")).toEqual({ kept: 80, credited: 40, total: 120, deliveries: 3, owedToRider: 40 });
    expect(earningsView(sum, "week").total).toBe(200); expect(earningsView(sum, "all").total).toBe(0);
  });
  it("rounds money to paise and copes with strings from the server", () => {
    expect(earningsView({ today: { keptFromCash: "40.10", credited: "0.2", deliveries: "2" }, owedToRider: "0" }, "today").total).toBe(40.3);
  });
  it("an older server (no summary) or an unknown range gives null, so the app falls back to the simple wallet", () => {
    expect(earningsView(null)).toBeNull(); expect(earningsView(undefined, "today")).toBeNull(); expect(earningsView(sum, "year")).toBeNull();
  });
  it("offers Today / Last 7 days / All time", () => expect(RANGES.map((r) => r.key)).toEqual(["today", "week", "all"]));
  it("every kind of history line says whose money it is", () => {
    expect(ledgerHelp("COD_COLLECTED")).toMatch(/belongs to SehatWaadi/); expect(ledgerHelp("COD_FEE_KEPT")).toMatch(/Yours/);
    expect(ledgerHelp("DELIVERY_EARNING")).toMatch(/SehatWaadi pays you/); expect(ledgerHelp("RETURN_EARNING")).toMatch(/SehatWaadi pays you/); expect(ledgerHelp("CASH_SETTLEMENT")).toMatch(/paid this to SehatWaadi/);
    expect(ledgerHelp("brand_new")).toBe("");
  });
  it("history amounts say what happened instead of a bare +/-", () => {
    expect(ledgerEffect({ entry_type: "COD_FEE_KEPT", amount: 40 })).toEqual({ text: "You keep ₹40", tone: "earn" });
    expect(ledgerEffect({ entry_type: "DELIVERY_EARNING", amount: 40 })).toEqual({ text: "You earn ₹40", tone: "earn" });
    expect(ledgerEffect({ entry_type: "COD_COLLECTED", amount: 760 })).toEqual({ text: "Cash held +₹760", tone: "cash" });
    expect(ledgerEffect({ entry_type: "CASH_SETTLEMENT", amount: 200 })).toEqual({ text: "Cash held -₹200", tone: "paid" });
    expect(ledgerEffect({ entry_type: "ADJUSTMENT", amount: -5 })).toEqual({ text: "-₹5", tone: "paid" });
  });
  it("labels the fee lines in plain words", () => { expect(ledgerLabel("COD_FEE_KEPT")).toBe("Your delivery fee"); expect(ledgerLabel("DELIVERY_EARNING")).toBe("Delivery fee earned"); expect(ledgerLabel("RETURN_EARNING")).toBe("Return trip fee"); });
  it("after a cash delivery the rider is told to keep the fee; after an online one that it will be paid", () => {
    expect(deliveredMessage({ earnings: 40, paymentMode: "CASH" })).toMatch(/fee is ₹40.*Keep it out of the cash/);
    expect(deliveredMessage({ earnings: 40, paymentMode: "UPI_QR" })).toMatch(/₹40 added to what SehatWaadi will pay you/);
    expect(deliveredMessage({ earnings: 40, paymentMode: "PREPAID" })).toMatch(/hold no cash/);
  });
});
