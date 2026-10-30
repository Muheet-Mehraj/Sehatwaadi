import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

const pushMock = vi.hoisted(() => ({ start: vi.fn(async () => ({ ok: true })), stop: vi.fn(async () => {}), clearDelivered: vi.fn(async () => {}), currentToken: () => "tok", lastError: () => null }));
vi.mock("../src/services/push.js", () => ({ push: pushMock }));
import { RiderProvider } from "../src/contexts/RiderContext.jsx";
import { TestGate } from "./helpers.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const rider = (over = {}) => ({ fullName: "Asha", vehicleType: "SCOOTER", status: "ONLINE", verificationStatus: "VERIFIED", cashInHand: 0, maxFloatingCash: 2000, pendingSettlement: 0, codBlocked: false, earningsBalance: 0, ...over });
const geo = { watchPosition: () => 1, clearWatch: () => {}, getCurrentPosition: (ok) => ok({ coords: { latitude: 34.08, longitude: 74.79, accuracy: 20 }, timestamp: Date.now() }) };
const wait = async (ms = 20) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
let root, el;
const fakeApi = (r) => ({
  getMyRider: vi.fn(async () => ({ ok: true, rider: r })), getActiveDelivery: vi.fn(async () => ({ ok: true, delivery: null })),
  subscribeDeliveries: vi.fn(() => () => {}), subscribeOffers: vi.fn(() => () => {}), setStatus: vi.fn(async () => ({ ok: true })),
  pushLocations: vi.fn(async () => ({ ok: true })), getRecentDeliveries: vi.fn(async () => ({ ok: true, rows: [] })),
  getMyOffer: vi.fn(async () => ({ ok: true, offer: null })), registerPushDevice: vi.fn(async () => ({ ok: true })),
});
beforeEach(() => { el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el); localStorage.clear(); Object.values(pushMock).forEach((f) => f.mockClear?.()); });
const mount = async (api) => { await act(async () => { root.render(<RiderProvider api={api} session={{ user: { id: "u1" } }} onSignOut={() => {}} geo={geo}><TestGate /></RiderProvider>); }); await wait(); };

describe("push wiring in the rider app", () => {
  it("a verified rider starts push, and the phone token is registered with the server", async () => {
    const api = fakeApi(rider()); await mount(api);
    expect(pushMock.start).toHaveBeenCalledTimes(1);
    pushMock.start.mock.calls[0][0].onToken("fcm-123");
    expect(api.registerPushDevice).toHaveBeenCalledWith("fcm-123", "android", expect.any(String));
  });
  it("a push (or a tap on it) makes the app ask the server for its offer at once", async () => {
    const api = fakeApi(rider()); await mount(api);
    const before = api.getMyOffer.mock.calls.length;
    await act(async () => { pushMock.start.mock.calls[0][0].onWake({ type: "OFFER" }, "tap"); }); await wait();
    expect(api.getMyOffer.mock.calls.length).toBeGreaterThan(before);
  });
  it("a rider who is not verified yet does not register a phone", async () => {
    await mount(fakeApi(rider({ verificationStatus: "PENDING" })));
    expect(pushMock.start).not.toHaveBeenCalled();
  });
  it("an older api object without push support still works", async () => {
    const api = fakeApi(rider()); delete api.registerPushDevice; await mount(api);
    expect(pushMock.start).not.toHaveBeenCalled();
  });
  it("stops listening when the screen goes away", async () => {
    await mount(fakeApi(rider())); await act(async () => { root.unmount(); }); expect(pushMock.stop).toHaveBeenCalled();
  });
});
