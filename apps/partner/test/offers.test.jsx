import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { RiderProvider } from "../src/contexts/RiderContext.jsx";
import { OfferOverlay } from "../src/components/OfferOverlay.jsx";
import { TestGate } from "./helpers.jsx";
import { localDeadline, remainingMs, remainingSeconds, endedKind, fractionLeft } from "../src/services/offers.js";
import { canRiderCancel, STEPS } from "../src/services/deliveryMachine.js";
import { errorText } from "../src/services/errors.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const rider = { fullName: "Asha", vehicleType: "SCOOTER", vehicleNumber: "JK01", status: "ONLINE", verificationStatus: "VERIFIED", cashInHand: 0, maxFloatingCash: 2000, pendingSettlement: 0, codBlocked: false, earningsBalance: 0 };
const wait = async (ms = 20) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const offerPayload = (over = {}) => ({ offerId: "o1", deliveryId: "d1", round: 1, secondsLeft: 12, windowSeconds: 15, earnings: 55, pickupDistanceKm: 1.2, tripKm: 3.4,
  requiresPrescription: true, paymentMode: "CASH", cashToCollect: 760, pharmacy: { name: "Nowshera Pharmacy", address: "Nowshera, Srinagar" }, dropArea: "Opp. Park", ...over });
const job = (status = "ACCEPTED") => ({ status, arrivedAtCustomer: false, order: { deliveryId: "d1", earnings: 55, items: [{ name: "X", qty: 1 }], pharmacy: { name: "Nowshera Pharmacy", lat: 34.08, lng: 74.79 }, customer: { name: "Aaliya", lat: 34.09, lng: 74.8 }, cashToCollect: 760, payment: { mode: "CASH", verified: false } } });
const geo = { watchPosition: () => 1, clearWatch: () => {}, getCurrentPosition: (ok) => ok({ coords: { latitude: 34.08, longitude: 74.79, accuracy: 20 }, timestamp: Date.now() }) };

let root, el, handlers;
const fakeApi = (over = {}) => ({
  getMyRider: vi.fn(async () => ({ ok: true, rider })), getActiveDelivery: vi.fn(async () => ({ ok: true, delivery: null })),
  subscribeDeliveries: vi.fn(() => () => {}), subscribeOffers: vi.fn((uid, h) => { handlers = h; return () => {}; }),
  setStatus: vi.fn(async (s) => ({ ok: true, status: s })), pushLocations: vi.fn(async () => ({ ok: true })), getRecentDeliveries: vi.fn(async () => ({ ok: true, rows: [] })),
  getMyOffer: vi.fn(async () => ({ ok: true, offer: offerPayload() })), acceptOffer: vi.fn(async () => ({ ok: true, delivery: job() })),
  declineOffer: vi.fn(async () => ({ ok: true })), cancelDelivery: vi.fn(async () => ({ ok: true })), ...over,
});
beforeEach(() => { el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el); localStorage.clear(); handlers = null; });
const mount = async (api) => { await act(async () => { root.render(<RiderProvider api={api} session={{ user: { id: "u1" } }} onSignOut={() => {}} geo={geo}><TestGate /><OfferOverlay /></RiderProvider>); }); await wait(); };
const click = async (node) => { await act(async () => { node.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await wait(); };
const byText = (t) => [...el.querySelectorAll("button,a,label")].find((b) => b.textContent.includes(t));

describe("pure offer logic", () => {
  it("turns the server's seconds-left into a deadline on the phone's own clock, measured from when we asked", () => {
    expect(localDeadline(1000, 12)).toBe(13000); expect(localDeadline(1000, -3)).toBe(1000); expect(localDeadline(1000, undefined)).toBe(1000);
    expect(remainingMs(13000, 4000)).toBe(9000); expect(remainingMs(13000, 20000)).toBe(0); expect(remainingSeconds(13000, 12100)).toBe(1);
    expect(fractionLeft({ deadlineMs: 8000, windowSeconds: 15 }, 500)).toBeCloseTo(0.5, 2);
  });
  it("tells 'another rider took it' from 'it simply lapsed'", () => {
    expect(endedKind({ deadlineMs: 20000 }, 5000)).toBe("taken"); expect(endedKind({ deadlineMs: 20000 }, 20000)).toBe("expired"); expect(endedKind({ deadlineMs: 20000 }, 19500)).toBe("expired");
  });
  it("only allows cancelling before pickup; has clear text for every new server answer", () => {
    expect(canRiderCancel(STEPS.EN_ROUTE_TO_PHARMACY)).toBe(true); expect(canRiderCancel(STEPS.PICKUP_VERIFICATION)).toBe(true);
    for (const s of [STEPS.EN_ROUTE_TO_CUSTOMER, STEPS.DROPOFF_OTP, STEPS.RETURNING_TO_PHARMACY, STEPS.IDLE]) expect(canRiderCancel(s)).toBe(false);
    for (const e of ["offer_taken", "offer_expired", "offer_closed", "rider_not_available", "cash_limit", "invalid_reason", "cancel_after_pickup"]) expect(errorText({ ok: false, error: e })).not.toMatch(/Couldn't complete/);
  });
});

describe("incoming offer", () => {
  it("shows the facts needed to decide, a countdown, and no customer details", async () => {
    await mount(fakeApi());
    expect(el.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect(el.textContent).toContain("Nowshera Pharmacy"); expect(el.textContent).toContain("₹55"); expect(el.textContent).toContain("Opp. Park"); expect(el.textContent).toContain("Prescription order"); expect(el.textContent).toContain("₹760");
    expect(el.querySelector(".offer-secs").textContent).toMatch(/^1[0-2]s$/);
    expect(el.textContent).not.toMatch(/Aaliya|Augmentin/);
  });
  it("a double tap sends ONE accept, and the order is shown as ours only after the server confirms", async () => {
    let release; let accepted = false;
    const api = fakeApi({ acceptOffer: vi.fn(() => new Promise((res) => { release = () => { accepted = true; res({ ok: true, delivery: job() }); }; })),
                          getActiveDelivery: vi.fn(async () => ({ ok: true, delivery: accepted ? job() : null })) });
    await mount(api);
    const btn = byText("Accept");
    await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await wait();
    expect(api.acceptOffer).toHaveBeenCalledTimes(1); expect(api.acceptOffer).toHaveBeenCalledWith("o1");
    expect(el.textContent).not.toContain("Head to the pharmacy");                 // not assigned yet: the server hasn't said so
    await act(async () => { release(); }); await wait(40);
    expect(el.textContent).toContain("Head to the pharmacy"); expect(el.querySelector('[role="alertdialog"][aria-label="New order offer"]')).toBeNull();
  });
  it("losing the race shows a clear message and no order", async () => {
    await mount(fakeApi({ acceptOffer: vi.fn(async () => ({ ok: false, error: "offer_taken" })) }));
    await click(byText("Accept"));
    expect(el.textContent).toContain("Another rider accepted this order first"); expect(el.textContent).not.toContain("Head to the pharmacy"); expect(el.querySelector('[aria-label="New order offer"]')).toBeNull();
  });
  it("no signal: says so, keeps the offer on screen, and a retry can still win", async () => {
    const accept = vi.fn().mockResolvedValueOnce({ ok: false, error: "network" }).mockResolvedValueOnce({ ok: true, delivery: job() });
    const api = fakeApi({ acceptOffer: accept }); await mount(api);
    await click(byText("Accept"));
    expect(el.textContent).toContain("No signal"); expect(el.querySelector('[aria-label="New order offer"]')).toBeTruthy(); expect(el.textContent).not.toContain("Head to the pharmacy");
    api.getActiveDelivery.mockResolvedValue({ ok: true, delivery: job() });
    await click(byText("Accept")); await wait(40);
    expect(accept).toHaveBeenCalledTimes(2); expect(el.textContent).toContain("Head to the pharmacy");
  });
  it("when the countdown runs out the offer closes, says 'expired', and Accept is never sent", async () => {
    const api = fakeApi({ getMyOffer: vi.fn().mockResolvedValueOnce({ ok: true, offer: offerPayload({ secondsLeft: 0.4 }) }).mockResolvedValue({ ok: true, offer: null }) });
    await mount(api); expect(el.querySelector('[aria-label="New order offer"]')).toBeTruthy();
    await wait(700);
    expect(el.querySelector('[aria-label="New order offer"]')).toBeNull(); expect(el.textContent).toContain("That offer expired"); expect(api.acceptOffer).not.toHaveBeenCalled();
  });
  it("an offer the server already considers over is not shown, however late the notification", async () => {
    await mount(fakeApi({ getMyOffer: vi.fn(async () => ({ ok: true, offer: null })) }));
    expect(el.querySelector('[aria-label="New order offer"]')).toBeNull();
  });
  it("decline hides it at once and tells the server", async () => {
    const api = fakeApi(); await mount(api); await click(byText("Decline"));
    expect(api.declineOffer).toHaveBeenCalledWith("o1"); expect(el.querySelector('[aria-label="New order offer"]')).toBeNull(); expect(api.acceptOffer).not.toHaveBeenCalled();
  });
  it("an offer that disappears on the server before our clock ends is reported as taken (woken by realtime)", async () => {
    const getMyOffer = vi.fn().mockResolvedValueOnce({ ok: true, offer: offerPayload({ secondsLeft: 14 }) }).mockResolvedValue({ ok: true, offer: null });
    await mount(fakeApi({ getMyOffer }));
    expect(el.querySelector('[aria-label="New order offer"]')).toBeTruthy();
    await act(async () => { handlers.onChange({}); }); await wait(250);
    expect(el.querySelector('[aria-label="New order offer"]')).toBeNull(); expect(el.textContent).toContain("Another rider accepted");
  });
});

describe("cancelling an accepted order", () => {
  const withJob = (status) => fakeApi({ getMyOffer: vi.fn(async () => ({ ok: true, offer: null })), getActiveDelivery: vi.fn(async () => ({ ok: true, delivery: job(status) })) });
  it("before pickup: a reason is required, then it is sent with the notes", async () => {
    const api = withJob("ACCEPTED"); await mount(api);
    await click(byText("Cancel")); expect(el.textContent).toContain("Cancel this order?");
    const confirm = byText("Cancel order"); expect(confirm.disabled).toBe(true);
    await click(byText("Pickup is too far"));
    const ta = el.querySelector(".sheet textarea"); await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, "far away"); ta.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(byText("Cancel order").disabled).toBe(false); await click(byText("Cancel order"));
    expect(api.cancelDelivery).toHaveBeenCalledWith("d1", "TOO_FAR", "far away");
  });
  it("after pickup there is no cancel button (report a problem instead)", async () => {
    await mount(withJob("PICKED_UP"));
    expect(byText("Can't take this order")).toBeUndefined(); expect(byText("Report a problem")).toBeTruthy();
  });
  it("if the server refuses (already picked up elsewhere) the rider sees why", async () => {
    const api = withJob("ACCEPTED"); api.cancelDelivery.mockResolvedValue({ ok: false, error: "cancel_after_pickup" }); await mount(api);
    await click(byText("Cancel")); await click(byText("Other reason")); await click(byText("Cancel order"));
    expect(el.textContent).toContain("already collected the medicines");
  });
});
