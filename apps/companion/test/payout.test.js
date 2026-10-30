import { describe, it, expect } from "vitest";
import { money, stepOf, actionsFor, canClaim, validDisputeNote, STATUS_TEXT } from "../src/lib/payout.js";

describe("settlement wording and rules", () => {
  it("shows rupees with two decimals and Indian grouping", () => { expect(money(1084.5)).toBe("₹1,084.50"); expect(money(0)).toBe("₹0.00"); expect(money(125000)).toBe("₹1,25,000.00"); expect(money(undefined)).toBe("₹0.00"); });
  it("knows which step of claim → paid → confirmed a payout is on", () => {
    expect(stepOf("REQUESTED")).toBe(1); expect(stepOf("PAID")).toBe(2); expect(stepOf("DISPUTED")).toBe(2); expect(stepOf("CONFIRMED")).toBe(3); expect(stepOf("CANCELLED")).toBe(0); expect(stepOf("??")).toBe(0);
  });
  it("only offers the buttons that make sense: confirm/not-received after payment, withdraw before it", () => {
    expect(actionsFor("REQUESTED")).toEqual({ withdraw: true, confirm: false, dispute: false });
    expect(actionsFor("PAID")).toEqual({ withdraw: false, confirm: true, dispute: true });
    expect(actionsFor("DISPUTED")).toEqual({ withdraw: false, confirm: false, dispute: false });
    expect(actionsFor("CONFIRMED")).toEqual({ withdraw: false, confirm: false, dispute: false });
  });
  it("can claim only when something is waiting and no claim is already open", () => {
    expect(canClaim({ unsettled: { amount: 684, orders: 1 }, open: null })).toBe(true);
    expect(canClaim({ unsettled: { amount: 0, orders: 0 }, open: null })).toBe(false);
    expect(canClaim({ unsettled: { amount: 684, orders: 1 }, open: { status: "PAID" } })).toBe(false);
    expect(canClaim(null)).toBe(false);
  });
  it("a 'not received' report needs a few words", () => { expect(validDisputeNote("")).toBe(false); expect(validDisputeNote("  ab ")).toBe(false); expect(validDisputeNote("no credit")).toBe(true); });
  it("has plain words for every state", () => { for (const k of ["REQUESTED", "PAID", "DISPUTED", "CONFIRMED", "CANCELLED"]) expect(STATUS_TEXT[k]).toBeTruthy(); });
});
