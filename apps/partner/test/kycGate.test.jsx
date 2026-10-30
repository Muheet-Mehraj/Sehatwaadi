import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
vi.mock("../src/services/push.js", () => ({ push: { start: vi.fn(async () => ({ ok: true })), stop: vi.fn(async () => {}), clearDelivered: vi.fn(async () => {}), currentToken: () => "t", lastError: () => null } }));
import App from "../src/App.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const ALL = ["SELFIE", "AADHAAR_FRONT", "AADHAAR_BACK", "PAN", "DL_FRONT"];
const geo = { watchPosition: () => 1, clearWatch: () => {}, getCurrentPosition: () => {} };
const wait = async (ms = 30) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const rider = (over = {}) => ({ fullName: "Asha Khan", phone: "919876543210", vehicleType: "SCOOTER", vehicleNumber: "JK01AB1234", status: "OFFLINE", verificationStatus: "PENDING", cashInHand: 0, maxFloatingCash: 2000, pendingSettlement: 0, codBlocked: false, earningsBalance: 0, ...over });
const api = (r, withKyc = true) => ({
  getSession: async () => ({ user: { id: "u1" } }), onAuthChange: () => () => {}, signOut: async () => {},
  getMyRider: vi.fn(async () => ({ ok: true, rider: r })), getActiveDelivery: async () => ({ ok: true, delivery: null }), subscribeDeliveries: () => () => {}, subscribeOffers: () => () => {},
  getRecentDeliveries: async () => ({ ok: true, rows: [] }), getMyOffer: async () => ({ ok: true, offer: null }),
  ...(withKyc ? { getMyKyc: async () => ({ ok: true, kyc: { status: "DRAFT", required: ALL, docs: {}, canEdit: true } }) } : {}),
});
let root, el;
beforeEach(() => { el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el); localStorage.clear(); });
const mount = async (a) => { await act(async () => { root.render(<App api={a} geo={geo} />); }); await wait(60); };

describe("who sees what", () => {
  it("an unverified rider lands on the profile / documents screen, not the dashboard", async () => {
    await mount(api(rider())); expect(el.textContent).toContain("Complete your profile"); expect(el.textContent).not.toContain("You're offline");
  });
  it("a suspended rider only sees the suspended screen (no way to upload or go online)", async () => {
    await mount(api(rider({ verificationStatus: "SUSPENDED" })));
    expect(el.textContent).toContain("Account suspended"); expect(el.querySelectorAll("input[type=file]")).toHaveLength(0);
  });
  it("an older server without KYC support falls back to the plain 'verification in progress' screen", async () => {
    await mount(api(rider(), false)); expect(el.textContent).toContain("Verification in progress");
  });
  it("a verified rider gets the dashboard with a Profile & documents button that opens the profile and comes back", async () => {
    await mount(api(rider({ verificationStatus: "VERIFIED" })));
    expect(el.textContent).toContain("You're offline");
    const open = [...el.querySelectorAll("button")].find((b) => /Profile & documents/.test(b.textContent));
    await act(async () => { open.click(); }); await wait();
    expect(el.textContent).toContain("Profile"); expect(el.textContent).toContain("Documents");
    const back = [...el.querySelectorAll("button")].find((b) => /Back/.test(b.textContent));
    await act(async () => { back.click(); }); await wait(); expect(el.textContent).toContain("You're offline");
  });
});
