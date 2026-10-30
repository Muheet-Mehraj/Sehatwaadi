import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

vi.mock("../src/services/kyc.js", async (orig) => ({ ...(await orig()), prepareImage: vi.fn(async () => ({ base64: "QUJD", previewUrl: "blob:x", bytes: 3 })) }));
import Profile from "../src/components/Profile.jsx";
import { RiderProvider } from "../src/contexts/RiderContext.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const ALL = ["SELFIE", "AADHAAR_FRONT", "AADHAAR_BACK", "PAN", "DL_FRONT"];
const D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
const INV = [0,4,3,2,1,5,6,7,8,9];
const AADHAAR = (() => { const e = "23456789012"; let c = 0; [...e].reverse().forEach((d, i) => { c = D[c][P[(i + 1) % 8][+d]]; }); return e + INV[c]; })();

const rider = (over = {}) => ({ fullName: "Asha Khan", phone: "919876543210", vehicleType: "SCOOTER", vehicleNumber: "JK01AB1234", status: "OFFLINE", verificationStatus: "PENDING", cashInHand: 0, maxFloatingCash: 2000, pendingSettlement: 0, codBlocked: false, earningsBalance: 0, ...over });
const kyc0 = (over = {}) => ({ status: "DRAFT", verificationStatus: "PENDING", required: ALL, docs: {}, canEdit: true, rejectReason: null, dob: null, aadhaarMasked: null, aadhaarLast4: null, pan: null, dlNumber: null, dlExpiry: null, ...over });
const geo = { watchPosition: () => 1, clearWatch: () => {}, getCurrentPosition: () => {} };
const wait = async (ms = 20) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
let root, el;
beforeEach(() => { el = document.createElement("div"); document.body.appendChild(el); root = createRoot(el); localStorage.clear(); });

function fakeApi({ r = rider(), k = kyc0() } = {}) {
  const state = { k: structuredClone(k) };
  return { state,
    getMyRider: vi.fn(async () => ({ ok: true, rider: r })), getActiveDelivery: vi.fn(async () => ({ ok: true, delivery: null })), subscribeDeliveries: vi.fn(() => () => {}), subscribeOffers: vi.fn(() => () => {}),
    getRecentDeliveries: vi.fn(async () => ({ ok: true, rows: [] })), getMyOffer: vi.fn(async () => ({ ok: true, offer: null })),
    getMyKyc: vi.fn(async () => ({ ok: true, kyc: state.k })),
    kycUploadDoc: vi.fn(async (kind) => { state.k.docs[kind] = { status: "PENDING" }; return { ok: true, kind }; }),
    kycSubmit: vi.fn(async () => { state.k.status = "SUBMITTED"; state.k.canEdit = false; state.k.aadhaarMasked = "XXXX XXXX 9012"; return { ok: true, status: "SUBMITTED" }; }) };
}
const mount = async (api, props = { onboarding: true }) => {
  await act(async () => { root.render(<RiderProvider api={api} session={{ user: { id: "u1" } }} onSignOut={() => {}} geo={geo}><Profile onSignOut={() => {}} onBack={() => {}} {...props} /></RiderProvider>); }); await wait(30);
};
const setVal = async (input, v) => { await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, v); input.dispatchEvent(new Event("input", { bubbles: true })); }); };
const inputBy = (ph) => [...el.querySelectorAll("input")].find((i) => i.placeholder === ph);
const dateInputs = () => [...el.querySelectorAll('input[type="date"]')];
const sendBtn = () => [...el.querySelectorAll("button")].find((b) => /Send (again )?for verification/.test(b.textContent));
const pickFile = async (kind) => { const input = el.querySelector(`li[data-kind="${kind}"] input[type=file]`); Object.defineProperty(input, "files", { value: [new File(["x"], "a.jpg", { type: "image/jpeg" })], configurable: true }); await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); }); await wait(30); };
async function fillDetails() {
  const d = dateInputs(); await setVal(d[0], "1995-04-12"); await setVal(inputBy("0000 0000 0000"), AADHAAR); await setVal(inputBy("ABCPE1234F"), "ABCPE1234F");
  await setVal(inputBy("JK01 20190012345"), "JK01 2019 0012345"); await setVal(dateInputs()[1], "2031-06-30");
}

describe("rider profile / KYC screen", () => {
  it("a new rider sees every document to add, and Send is disabled", async () => {
    await mount(fakeApi());
    expect(el.textContent).toContain("Complete your profile"); expect(el.textContent).toContain("Not verified yet");
    expect(el.querySelectorAll("li.doc")).toHaveLength(5); expect(el.textContent).toContain("Your photo (selfie)");
    expect(sendBtn().disabled).toBe(true); expect(el.textContent).toMatch(/Still needed: Add: Your photo/);
  });
  it("a bicycle rider is not asked for a licence", async () => {
    await mount(fakeApi({ r: rider({ vehicleType: "BICYCLE" }), k: kyc0({ required: ["SELFIE", "AADHAAR_FRONT", "AADHAAR_BACK", "PAN"] }) }));
    expect(el.querySelectorAll("li.doc")).toHaveLength(4); expect(el.textContent).not.toContain("Driving licence"); expect(el.textContent).toContain("bicycle");
  });
  it("picking a photo shrinks it, uploads it, and shows it as added", async () => {
    const api = fakeApi(); await mount(api); await pickFile("PAN");
    expect(api.kycUploadDoc).toHaveBeenCalledWith("PAN", "QUJD");
    expect(el.querySelector('li[data-kind="PAN"]').textContent).toContain("Added"); expect(el.querySelector('li[data-kind="PAN"] img').getAttribute("src")).toBe("blob:x");
  });
  it("the selfie opens the front camera; the cards do not force the camera", async () => {
    await mount(fakeApi());
    expect(el.querySelector('li[data-kind="SELFIE"] input').getAttribute("capture")).toBe("user"); expect(el.querySelector('li[data-kind="PAN"] input').hasAttribute("capture")).toBe(false);
  });
  it("a refused upload shows the reason and the photo is not marked added", async () => {
    const api = fakeApi(); api.kycUploadDoc.mockResolvedValueOnce({ ok: false, error: "invalid_image" }); await mount(api); await pickFile("SELFIE");
    expect(el.textContent).toContain("could not be used"); expect(el.querySelector('li[data-kind="SELFIE"]').textContent).toContain("Not added");
  });
  it("with everything filled in, Send works and the rider sees 'under review'; only the LAST 4 Aadhaar digits are sent", async () => {
    const api = fakeApi(); await mount(api);
    for (const k of ALL) await pickFile(k); await fillDetails();
    expect(sendBtn().disabled).toBe(false);
    await act(async () => { sendBtn().click(); }); await wait(40);
    expect(api.kycSubmit).toHaveBeenCalledTimes(1);
    const sent = api.kycSubmit.mock.calls[0][0];
    expect(sent).toEqual({ dob: "1995-04-12", aadhaarLast4: AADHAAR.slice(-4), pan: "ABCPE1234F", dlNumber: "JK0120190012345", dlExpiry: "2031-06-30" });
    expect(JSON.stringify(api.kycSubmit.mock.calls)).not.toContain(AADHAAR);
    expect(el.textContent).toContain("with the SehatWaadi team"); expect(sendBtn()).toBeUndefined();
    expect(el.textContent).not.toContain(AADHAAR); expect(inputBy("0000 0000 0000")).toBeUndefined();
  });
  it("a mistyped Aadhaar keeps Send disabled", async () => {
    const api = fakeApi(); await mount(api); for (const k of ALL) await pickFile(k); await fillDetails();
    await setVal(inputBy("0000 0000 0000"), AADHAAR.slice(0, 11) + String((+AADHAAR[11] + 1) % 10));
    expect(sendBtn().disabled).toBe(true); expect(el.textContent).toContain("Aadhaar number correctly");
  });
  it("a rider under 18 or with an expired licence cannot send", async () => {
    const api = fakeApi(); await mount(api); for (const k of ALL) await pickFile(k); await fillDetails();
    await setVal(dateInputs()[0], "2015-01-01"); expect(sendBtn().disabled).toBe(true);
    await setVal(dateInputs()[0], "1995-04-12"); await setVal(dateInputs()[1], "2020-01-01"); expect(sendBtn().disabled).toBe(true);
  });
  it("a server refusal on submit is shown in words", async () => {
    const api = fakeApi(); api.kycSubmit.mockResolvedValueOnce({ ok: false, error: "pan_in_use" }); await mount(api); for (const k of ALL) await pickFile(k); await fillDetails();
    await act(async () => { sendBtn().click(); }); await wait(40); expect(el.textContent).toContain("already registered with another rider");
  });
  it("after a rejection the reason and the pictures to retake are shown, saved details come back, and she can send again", async () => {
    const docs = Object.fromEntries(ALL.map((k) => [k, { status: "PENDING" }])); docs.PAN = { status: "REJECTED", note: "PAN photo is blurry" };
    const api = fakeApi({ k: kyc0({ status: "REJECTED", rejectReason: "PAN photo is blurry", docs, dob: "1995-04-12", pan: "ABCPE1234F", dlNumber: "JK0120190012345", dlExpiry: "2031-06-30", aadhaarLast4: "9012", aadhaarMasked: "XXXX XXXX 9012" }) });
    await mount(api);
    expect(el.textContent).toContain("sent back"); expect(el.textContent).toContain("PAN photo is blurry");
    expect(el.querySelector('li[data-kind="PAN"]').textContent).toContain("Retake"); expect(el.textContent).toContain("Saved XXXX XXXX 9012");
    expect(sendBtn().disabled).toBe(true); expect(el.textContent).toMatch(/Add: PAN card/);
    await pickFile("PAN"); expect(sendBtn().disabled).toBe(false);
    await act(async () => { sendBtn().click(); }); await wait(40);
    expect(api.kycSubmit.mock.calls[0][0]).toMatchObject({ aadhaarLast4: "9012", pan: "ABCPE1234F" });
  });
  it("while under review everything is read-only and masked", async () => {
    const docs = Object.fromEntries(ALL.map((k) => [k, { status: "PENDING" }]));
    await mount(fakeApi({ k: kyc0({ status: "SUBMITTED", canEdit: false, docs, dob: "1995-04-12", pan: "ABCPE1234F", aadhaarMasked: "XXXX XXXX 9012", dlNumber: "JK0120190012345", dlExpiry: "2031-06-30" }) }));
    expect(sendBtn()).toBeUndefined(); expect(el.querySelectorAll("input[type=file]")).toHaveLength(0);
    expect(el.textContent).toContain("XXXX XXXX 9012"); expect(el.textContent).not.toContain("ABCPE1234F"); expect(el.textContent).toContain("AB••••••4F");
  });
  it("a verified rider sees approved documents and a Back button (not Sign out)", async () => {
    const docs = Object.fromEntries(ALL.map((k) => [k, { status: "APPROVED" }]));
    await mount(fakeApi({ r: rider({ verificationStatus: "VERIFIED" }), k: kyc0({ status: "APPROVED", canEdit: false, docs, verificationStatus: "VERIFIED", aadhaarMasked: "XXXX XXXX 9012" }) }), { onboarding: false });
    expect(el.textContent).toContain("Verified"); expect(el.textContent).toContain("approved ✓"); expect(el.textContent).toContain("Back"); expect(el.textContent).not.toContain("Sign out");
  });
  it("an older verified rider with no documents is gently asked to add them (not blocked)", async () => {
    await mount(fakeApi({ r: rider({ verificationStatus: "VERIFIED" }), k: kyc0({ verificationStatus: "VERIFIED" }) }), { onboarding: false });
    expect(el.textContent).toContain("Please add your documents");
  });
});
