import { describe, it, expect } from "vitest";
import { stepFromJob, STEPS, paymentPlan, destinationFor, issueOptionsFor, isValidOtp, looksLikeQr, qrBelongsTo } from "../src/services/deliveryMachine.js";
import { createLocationQueue, createFlusher } from "../src/services/locationQueue.js";
import { toE164, classify } from "../src/services/supabaseClient.js";
import { errorText, isRetryable } from "../src/services/errors.js";
import { haversineKm, formatKm, upiLink } from "../src/services/geo.js";

describe("trip machine", () => {
  it("maps server status to the right screen", () => {
    expect(stepFromJob(null)).toBe(STEPS.IDLE);
    expect(stepFromJob({ status: "ACCEPTED" })).toBe(STEPS.EN_ROUTE_TO_PHARMACY);
    expect(stepFromJob({ status: "ARRIVED_AT_PHARMACY" })).toBe(STEPS.PICKUP_VERIFICATION);
    expect(stepFromJob({ status: "PICKED_UP", arrivedAtCustomer: false })).toBe(STEPS.EN_ROUTE_TO_CUSTOMER);
    expect(stepFromJob({ status: "PICKED_UP", arrivedAtCustomer: true })).toBe(STEPS.DROPOFF_OTP);
    expect(stepFromJob({ status: "RETURNING_TO_PHARMACY" })).toBe(STEPS.RETURNING_TO_PHARMACY);
    expect(stepFromJob({ status: "DELIVERED" })).toBe(STEPS.IDLE);
  });
  it("payment plan: cash until the platform verifies a payment", () => {
    expect(paymentPlan({ cashToCollect: 800, payment: { verified: false, mode: "CASH" } })).toMatchObject({ mode: "CASH", collect: 800, needsCash: true });
    expect(paymentPlan({ cashToCollect: 0, payment: { verified: true, mode: "PREPAID" } })).toMatchObject({ mode: "PREPAID", collect: 0, needsCash: false });
    expect(paymentPlan({ cashToCollect: 0, payment: { verified: true, mode: "UPI_QR" } }).needsCash).toBe(false);
  });
  it("destinations and issue options follow the step", () => {
    const order = { pharmacy: { name: "P", lat: 1, lng: 2 }, customer: { name: "C", lat: 3, lng: 4 } };
    expect(destinationFor(STEPS.EN_ROUTE_TO_PHARMACY, order).kind).toBe("pharmacy");
    expect(destinationFor(STEPS.RETURNING_TO_PHARMACY, order).kind).toBe("pharmacy");
    expect(destinationFor(STEPS.DROPOFF_OTP, order).kind).toBe("customer");
    expect(issueOptionsFor(STEPS.EN_ROUTE_TO_PHARMACY)).not.toContain("CUSTOMER_UNREACHABLE");
    expect(issueOptionsFor(STEPS.DROPOFF_OTP)).toContain("CUSTOMER_UNREACHABLE");
  });
  it("validates OTP and QR shapes before spending a server attempt", () => {
    expect(isValidOtp("1234")).toBe(true); expect(isValidOtp("123")).toBe(false); expect(isValidOtp("12a4")).toBe(false);
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(looksLikeQr(`SW1.${id}.${"a".repeat(32)}`)).toBe(true); expect(looksLikeQr("hello")).toBe(false);
    expect(qrBelongsTo(`SW1.${id}.abc`, id)).toBe(true); expect(qrBelongsTo(`SW1.other.abc`, id)).toBe(false);
  });
});

describe("api helpers", () => {
  it("normalises Indian phone numbers", () => {
    expect(toE164("98765 43210")).toBe("+919876543210"); expect(toE164("+91 98765 43210")).toBe("+919876543210"); expect(toE164("919876543210")).toBe("+919876543210");
  });
  it("classifies failures", () => {
    expect(classify(new Error("TypeError: Failed to fetch")).error).toBe("network");
    expect(classify({ message: "JWT expired" }).error).toBe("not_authenticated");
    expect(classify({ code: "42501", message: "permission denied" }).error).toBe("forbidden");
    expect(classify(new Error("boom")).error).toBe("server");
    expect(isRetryable({ error: "network" })).toBe(true); expect(isRetryable({ error: "invalid_otp" })).toBe(false);
  });
  it("turns error codes into rider-friendly text", () => {
    expect(errorText({ ok: false, error: "invalid_otp", attemptsLeft: 2 })).toMatch(/wrong.*2 tries left/);
    expect(errorText({ ok: false, error: "invalid_otp", attemptsLeft: 1 })).toMatch(/1 try left/);
    expect(errorText({ ok: true })).toBe("");
  });
  it("geo helpers", () => {
    expect(haversineKm({ lat: 34.0805, lng: 74.7905 }, { lat: 34.0805, lng: 74.7905 })).toBe(0);
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeGreaterThan(110); expect(formatKm(0.45)).toBe("450 m"); expect(formatKm(2.34)).toBe("2.3 km");
    expect(upiLink("a@b", 760, "x")).toContain("am=760.00");
  });
});

describe("offline GPS queue", () => {
  const pt = (t) => ({ t, lat: 34, lng: 74 });
  it("keeps points through a failed upload and drains after recovery, oldest first", async () => {
    const queue = createLocationQueue({ idb: null }); let up = false; const seen = [];
    const f = createFlusher({ queue, now: () => Date.now() + 1e9, push: async (pts) => { if (!up) return { ok: false, error: "network" }; seen.push(...pts.map((p) => p.t)); return { ok: true }; } });
    for (const t of [1, 2, 3]) await queue.enqueue(pt(t));
    expect((await f.flush({ force: true })).failed).toBe(true); expect(await queue.size()).toBe(3);
    up = true; expect((await f.flush({ force: true })).sent).toBe(3); expect(seen).toEqual([1, 2, 3]); expect(await queue.size()).toBe(0);
  });
  it("de-dupes the same timestamp and drops oldest on overflow", async () => {
    const q = createLocationQueue({ idb: null, maxSize: 5 });
    expect(await q.enqueue(pt(1))).toBe(true); expect(await q.enqueue(pt(1))).toBe(false);
    for (let t = 2; t <= 9; t++) await q.enqueue(pt(t));
    const left = (await q.takeBatch(10)).map((b) => b.point.t); expect(left.length).toBe(5); expect(left[4]).toBe(9);
  });
  it("sends in batches and backs off exponentially", async () => {
    const queue = createLocationQueue({ idb: null }); let clock = 0; let calls = 0;
    const f = createFlusher({ queue, batchSize: 2, now: () => clock, push: async () => { calls++; return { ok: false, error: "network" }; } });
    for (let t = 1; t <= 5; t++) await queue.enqueue(pt(t));
    await f.flush(); expect((await f.flush()).skipped).toBe("backoff"); clock += 2500; await f.flush(); expect(calls).toBe(2);
    expect(f.backoffUntil - clock).toBeGreaterThanOrEqual(3000);
  });
  it("drops a batch the server will never accept instead of looping forever", async () => {
    const queue = createLocationQueue({ idb: null }); const f = createFlusher({ queue, push: async () => ({ ok: false, error: "invalid_points" }) });
    await queue.enqueue(pt(1)); await f.flush({ force: true }); expect(await queue.size()).toBe(0);
  });
  it("hands a newly auto-assigned job to the app", async () => {
    const queue = createLocationQueue({ idb: null }); let got = null; const f = createFlusher({ queue, onAssigned: (id) => (got = id), push: async () => ({ ok: true, assignedDeliveryId: "D1" }) });
    await queue.enqueue(pt(1)); await f.flush({ force: true }); expect(got).toBe("D1");
  });
});
