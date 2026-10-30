import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { RiderProvider } from "../src/contexts/RiderContext.jsx";
import { TestGate } from "./helpers.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const rider = { fullName: "Asha", vehicleType: "SCOOTER", vehicleNumber: "JK01", status: "OFFLINE", verificationStatus: "VERIFIED", cashInHand: 1500, maxFloatingCash: 2000, pendingSettlement: 0, codBlocked: false, earningsBalance: 320 };
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
const fakeApi = (over = {}) => ({
  getMyRider: vi.fn(async () => ({ ok: true, rider })), getActiveDelivery: vi.fn(async () => ({ ok: true, delivery: null })),
  subscribeDeliveries: vi.fn(() => () => {}), setStatus: vi.fn(async (s) => ({ ok: true, status: s })), pushLocations: vi.fn(async () => ({ ok: true })),
  getRecentDeliveries: vi.fn(async () => ({ ok: true, rows: [] })), getLedger: vi.fn(async () => ({ ok: true, rows: [{ id: 1, entry_type: "COD_COLLECTED", amount: 760, cash_in_hand_after: 1500, created_at: new Date().toISOString() }] })),
  settleCash: vi.fn(async () => ({ ok: true })), ...over,
});
const geo = { watchPosition: () => 1, clearWatch: () => {}, getCurrentPosition: (ok) => ok({ coords: { latitude: 34.08, longitude: 74.79, accuracy: 20 }, timestamp: Date.now() }) };
const queue = { enqueue: vi.fn(async () => true), takeBatch: vi.fn(async () => []), remove: vi.fn(), size: vi.fn(async () => 0) };
let root, el;
beforeEach(() => { el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el); localStorage.clear(); });
const mount = async (api, child = <TestGate />) => { await act(async () => { root.render(<RiderProvider api={api} session={{ user: { id: "u1" } }} onSignOut={() => {}} geo={geo}>{child}</RiderProvider>); }); await flush(); };
const click = async (node) => { await act(async () => { node.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await flush(); };
const byText = (t) => [...el.querySelectorAll("button,a,label")].find((b) => b.textContent.includes(t));

describe("rider dashboard", () => {
  it("shows the cash meter with a warning near the limit", async () => {
    await mount(fakeApi());
    expect(el.textContent).toContain("Cash in hand"); expect(el.textContent).toContain("Deposit soon"); expect(el.querySelector('[role="progressbar"]').getAttribute("aria-valuenow")).toBe("75");
  });
  it("going online pushes a position immediately so a waiting order can be assigned", async () => {
    const api = fakeApi(); await mount(api);
    await click(el.querySelector('input[aria-label="Online"]'));
    expect(api.setStatus).toHaveBeenCalledWith("ONLINE");
    expect(api.pushLocations).toHaveBeenCalled();
    expect(api.pushLocations.mock.calls[0][0][0]).toMatchObject({ lat: 34.08, lng: 74.79 });
  });
  it("the deposit sheet only enables Submit with a valid amount and UPI reference, then calls settleCash", async () => {
    const api = fakeApi(); await mount(api);
    await click(byText("Deposit cash"));
    const submit = byText("Submit deposit"); expect(submit.disabled).toBe(true);
    const input = el.querySelectorAll(".sheet input")[1];
    await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, "412345678901"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(byText("Submit deposit").disabled).toBe(false);
    await click(byText("Submit deposit"));
    expect(api.settleCash).toHaveBeenCalledWith(1500, "412345678901"); expect(el.textContent).toContain("Deposit submitted");
  });
  it("a made-up or malformed reference keeps Submit disabled and explains why; a spaced valid one is sent cleaned", async () => {
    const api = fakeApi(); await mount(api);
    await click(byText("Deposit cash"));
    const input = () => el.querySelectorAll(".sheet input")[1];
    const type = async (v) => { await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input(), v); input().dispatchEvent(new Event("input", { bubbles: true })); }); };
    await type("UPIREF000001"); expect(byText("Submit deposit").disabled).toBe(true); expect(el.textContent).toContain("no letters");
    await type("123456789012"); expect(byText("Submit deposit").disabled).toBe(true); expect(el.textContent).toContain("doesn't look like a real");
    await type("4829 1055 7301"); expect(byText("Submit deposit").disabled).toBe(false);
    await click(byText("Submit deposit")); expect(api.settleCash).toHaveBeenCalledWith(1500, "482910557301");
  });
  it("the wallet screen lists history", async () => {
    await mount(fakeApi()); await click(byText("Wallet & history"));
    expect(el.textContent).toContain("Cash collected"); expect(el.textContent).toContain("+₹760");
  });
});

describe("drop-off with cash", () => {
  it("requires the rider to confirm the cash before completing", async () => {
    const job = { status: "PICKED_UP", arrivedAtCustomer: true, order: { deliveryId: "d1", earnings: 40, items: [{ name: "X", qty: 1 }], pharmacy: { name: "P", lat: 1, lng: 2 }, customer: { name: "C", lat: 3, lng: 4 }, cashToCollect: 760, payment: { verified: false, mode: "CASH" } } };
    await mount(fakeApi({ getActiveDelivery: vi.fn(async () => ({ ok: true, delivery: job })) }));
    const gate = el.querySelector(".cashgate"); expect(gate).toBeTruthy();
    for (const d of ["1", "2", "3", "4"]) await click([...el.querySelectorAll(".keypad button")].find((b) => b.textContent === d));
    expect(byText("Complete delivery").disabled).toBe(true);
    await click(gate); expect(byText("Complete delivery").disabled).toBe(false);
  });
});
