import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import Payouts from "../src/components/Payouts.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const wait = async (ms = 10) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const base = (over = {}) => ({ ok: true, unsettled: { amount: 1084.5, orders: 3 }, open: null, history: [], ...over });
const open = (status, over = {}) => ({ id: "s1", status, amount: 1084.5, ordersCount: 3, requestedAt: "2026-10-24T05:00:00Z", paidRef: null, paidAt: null, disputeNote: null, ...over });
let root, el, notes;
const mount = async (api) => { notes = []; await act(async () => { root.render(<Payouts hub={{ api, notify: (t) => notes.push(t) }} />); }); await wait(); };
const btn = (t) => [...el.querySelectorAll("button")].find((b) => b.textContent.includes(t));
const click = async (b) => { await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await wait(); };
beforeEach(() => { el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el); vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(() => { act(() => root.unmount()); vi.restoreAllMocks(); });

describe("Settlement screen", () => {
  it("shows the balance and lets the chemist claim it", async () => {
    const api = { payouts: vi.fn().mockResolvedValueOnce(base()).mockResolvedValue(base({ unsettled: { amount: 0, orders: 0 }, open: open("REQUESTED") })), requestPayout: vi.fn().mockResolvedValue({ ok: true }) };
    await mount(api);
    expect(el.textContent).toContain("₹1,084.50"); expect(el.textContent).toContain("3 finished orders");
    await click(btn("Claim settlement")); expect(api.requestPayout).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain("Waiting for SehatWaadi to pay you"); expect(btn("Withdraw claim")).toBeTruthy(); expect(btn("Yes, I received it")).toBeUndefined();
  });
  it("cannot claim when nothing is waiting", async () => {
    await mount({ payouts: vi.fn().mockResolvedValue(base({ unsettled: { amount: 0, orders: 0 } })) });
    expect(btn("Claim settlement").disabled).toBe(true);
  });
  it("after SehatWaadi pays: shows the reference and amount, and confirming settles it", async () => {
    const api = { payouts: vi.fn().mockResolvedValueOnce(base({ unsettled: { amount: 0, orders: 0 }, open: open("PAID", { paidRef: "507291847362", paidAt: "2026-10-24T06:00:00Z" }) })).mockResolvedValue(base({ unsettled: { amount: 0, orders: 0 }, history: [open("CONFIRMED", { paidRef: "507291847362", confirmedAt: "2026-10-24T07:00:00Z" })] })), confirmPayout: vi.fn().mockResolvedValue({ ok: true }) };
    await mount(api);
    expect(el.textContent).toContain("507291847362"); expect(btn("Claim settlement").disabled).toBe(true);
    await click(btn("Yes, I received it"));
    expect(window.confirm).toHaveBeenCalled(); expect(api.confirmPayout).toHaveBeenCalledWith("s1"); expect(notes).toContain("Settled. Your balance is zero.");
    expect(el.textContent).toContain("Past settlements"); expect(el.textContent).toContain("Settled");
  });
  it("does nothing if the chemist cancels the confirmation prompt", async () => {
    window.confirm.mockReturnValue(false);
    const api = { payouts: vi.fn().mockResolvedValue(base({ open: open("PAID", { paidRef: "507291847362" }) })), confirmPayout: vi.fn() };
    await mount(api); await click(btn("Yes, I received it")); expect(api.confirmPayout).not.toHaveBeenCalled();
  });
  it("'I did not receive it' needs a reason, then reports it", async () => {
    const api = { payouts: vi.fn().mockResolvedValue(base({ open: open("PAID", { paidRef: "507291847362" }) })), disputePayout: vi.fn().mockResolvedValue({ ok: true }) };
    await mount(api); await click(btn("I did not receive it"));
    expect(btn("Send").disabled).toBe(true);
    const ta = el.querySelector("textarea");
    await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(ta, "Nothing in my account"); ta.dispatchEvent(new Event("input", { bubbles: true })); });
    await click(btn("Send")); expect(api.disputePayout).toHaveBeenCalledWith("s1", "Nothing in my account");
  });
  it("a disputed claim shows what the chemist wrote and offers no confirm button", async () => {
    await mount({ payouts: vi.fn().mockResolvedValue(base({ open: open("DISPUTED", { disputeNote: "Nothing in my account" }) })) });
    expect(el.textContent).toContain("Nothing in my account"); expect(btn("Yes, I received it")).toBeUndefined(); expect(btn("I did not receive it")).toBeUndefined();
  });
  it("a refusal from the Hub is shown to the chemist, not swallowed", async () => {
    const api = { payouts: vi.fn().mockResolvedValue(base()), requestPayout: vi.fn().mockRejectedValue(new Error("You already have a settlement in progress. Finish it first.")) };
    await mount(api); await click(btn("Claim settlement")); expect(notes).toContain("You already have a settlement in progress. Finish it first.");
  });
  it("refreshes itself when the Hub says SehatWaadi recorded a payment", async () => {
    const api = { payouts: vi.fn().mockResolvedValue(base()) }; await mount(api);
    const before = api.payouts.mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event("sw-payout-updated")); }); await wait(); expect(api.payouts.mock.calls.length).toBeGreaterThan(before);
  });
});
