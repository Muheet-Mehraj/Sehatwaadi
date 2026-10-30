import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
vi.mock("../src/services/push.js", () => ({ push: { start: vi.fn(async () => ({ ok: true })), stop: vi.fn(async () => {}), clearDelivered: vi.fn(async () => {}), currentToken: () => "t", lastError: () => null } }));
import { RiderProvider, useRider } from "../src/contexts/RiderContext.jsx";
import Wallet from "../src/components/Wallet.jsx";
import Dashboard from "../src/components/Dashboard.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const geo = { watchPosition: () => 1, clearWatch: () => {}, getCurrentPosition: () => {} };
const wait = async (ms = 30) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const rider = (o = {}) => ({ fullName: "Test Rider", vehicleType: "SCOOTER", status: "OFFLINE", verificationStatus: "VERIFIED", cashInHand: 0, maxFloatingCash: 2000, pendingSettlement: 0, codBlocked: false, earningsBalance: 0, ...o });
const SUM = { ok: true, today: { keptFromCash: 80, credited: 40, deliveries: 3 }, week: { keptFromCash: 120, credited: 40, deliveries: 4 }, all: { keptFromCash: 300, credited: 40, deliveries: 9 }, owedToRider: 40, cashInHand: 0 };
const ROWS = [
  { id: "1", entry_type: "CASH_SETTLEMENT", amount: 200, cash_in_hand_after: 0, note: null, created_at: "2026-10-26T11:53:00Z" },
  { id: "2", entry_type: "COD_FEE_KEPT", amount: 40, cash_in_hand_after: 200, note: "x", created_at: "2026-10-23T06:34:00Z" },
  { id: "3", entry_type: "COD_COLLECTED", amount: 125, cash_in_hand_after: 200, note: "cash owed to SehatWaadi", created_at: "2026-10-23T06:34:00Z" },
  { id: "4", entry_type: "DELIVERY_EARNING", amount: 40, cash_in_hand_after: 0, note: "delivery fee credited", created_at: "2026-10-23T05:00:00Z" },
];
const fakeApi = (r, { earnings = SUM } = {}) => ({
  getMyRider: vi.fn(async () => ({ ok: true, rider: r })), getActiveDelivery: vi.fn(async () => ({ ok: true, delivery: null })), subscribeDeliveries: vi.fn(() => () => {}), subscribeOffers: vi.fn(() => () => {}),
  getRecentDeliveries: vi.fn(async () => ({ ok: true, rows: [] })), getMyOffer: vi.fn(async () => ({ ok: true, offer: null })),
  getLedger: vi.fn(async () => ({ ok: true, rows: ROWS })), ...(earnings ? { getMyEarnings: vi.fn(async () => earnings) } : {}),
});
let root, el;
beforeEach(() => { el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el); localStorage.clear(); });
const Screen = ({ which }) => { const { rider: r0 } = useRider(); if (!r0) return null; return (which === "wallet" ? <Wallet onBack={() => {}} /> : <Dashboard onSignOut={() => {}} />); };
const mount = async (api, which = "wallet") => { await act(async () => { root.render(<RiderProvider api={api} session={{ user: { id: "u1" } }} onSignOut={() => {}} geo={geo}><Screen which={which} /></RiderProvider>); }); await wait(60); };
const byText = (t) => [...el.querySelectorAll("button, summary, b")].find((b) => b.textContent.trim() === t);

describe("wallet screen: the rider can tell what is his", () => {
  it("shows total earned with the split, 'SehatWaadi will pay you', and 'Cash to give SehatWaadi' as separate cards", async () => {
    await mount(fakeApi(rider({ earningsBalance: 40, cashInHand: 0 })));
    const t = el.textContent;
    expect(t).toContain("What you've earned"); expect(t).toContain("₹120"); expect(t).toContain("3 deliveries");
    expect(t).toContain("Kept from cash orders"); expect(t).toContain("Already with you"); expect(t).toContain("From online-paid orders");
    expect(t).toContain("SehatWaadi will pay you"); expect(t).toContain("Cash to give SehatWaadi"); expect(t).toContain("It is SehatWaadi's money, not yours");
  });
  it("switching the period changes the numbers", async () => {
    await mount(fakeApi(rider()));
    await act(async () => { byText("All time").click(); }); await wait();
    expect(el.querySelector('[aria-label="Total earned"]').textContent).toBe("₹340"); expect(el.textContent).toContain("9 deliveries");
    await act(async () => { byText("Last 7 days").click(); }); await wait();
    expect(el.querySelector('[aria-label="Total earned"]').textContent).toBe("₹160");
  });
  it("with nothing owed it says why Earnings used to look empty", async () => {
    await mount(fakeApi(rider({ earningsBalance: 0 })));
    expect(el.textContent).toContain("Fees from cash orders are already with you");
  });
  it("history lines explain themselves and say what each one did", async () => {
    await mount(fakeApi(rider()));
    const t = el.textContent;
    expect(t).toContain("You keep ₹40"); expect(t).toContain("Yours. Keep it out of the cash you collected"); expect(t).toContain("Cash held +₹125"); expect(t).toContain("It belongs to SehatWaadi");
    expect(t).toContain("You earn ₹40"); expect(t).toContain("Cash held -₹200"); expect(t).toContain("Your delivery fee"); expect(t).not.toContain("Cod fee kept");
  });
  it("has a 'How your money works' explainer with a worked example", async () => {
    await mount(fakeApi(rider()));
    const d = el.querySelector("details.howto"); expect(d).toBeTruthy(); expect(d.textContent).toContain("₹800"); expect(d.textContent).toContain("owe SehatWaadi ₹760"); expect(d.textContent).toContain("Customer pays online");
  });
  it("an older server without the summary still shows a working wallet (no 'earned' card, no crash)", async () => {
    await mount(fakeApi(rider({ earningsBalance: 40 }), { earnings: null }));
    expect(el.textContent).not.toContain("What you've earned"); expect(el.querySelector('[aria-label="Total earned"]')).toBeNull(); expect(el.textContent).toContain("SehatWaadi will pay you"); expect(el.textContent).toContain("Cash to give SehatWaadi");
  });
});
describe("dashboard wallet card", () => {
  it("shows what was earned today and labels cash as SehatWaadi's", async () => {
    await mount(fakeApi(rider({ cashInHand: 125 })), "dash");
    expect(el.textContent).toContain("You earned today"); expect(el.textContent).toContain("₹120"); expect(el.textContent).toContain("Cash in hand"); expect(el.textContent).toContain("to give SehatWaadi");
  });
  it("older server: falls back to the owed balance", async () => {
    await mount(fakeApi(rider({ earningsBalance: 40 }), { earnings: null }), "dash");
    expect(el.textContent).not.toContain("You earned today"); expect(el.textContent).toContain("SehatWaadi will pay you");
  });
});
