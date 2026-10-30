import { describe, it, expect } from "vitest";
import { searchState } from "../src/lib/dispatchState.js";

describe("searchState (rider search progress shown to the chemist)", () => {
  it("is null once a rider is assigned, and in the old assign-instantly mode (no extra fields)", () => {
    expect(searchState({ riders: { full_name: "Asha" }, live_offers: 3 })).toBeNull();
    expect(searchState({ status: "DISPATCHED", riders: null })).toBeNull();
    expect(searchState(null)).toBeNull();
  });
  it("says how many riders are being asked, with correct singular/plural", () => {
    expect(searchState({ riders: null, live_offers: 4, dispatch_round: 1 })).toMatchObject({ kind: "asking" });
    expect(searchState({ riders: null, live_offers: 4, dispatch_round: 2 }).text).toBe("Asking 4 nearby riders to accept (search 2)…");
    expect(searchState({ riders: null, live_offers: 1, dispatch_round: 1 }).text).toContain("Asking 1 nearby rider to accept");
  });
  it("tells the chemist plainly when every search round found nobody (and that we keep trying)", () => {
    const s = searchState({ riders: null, live_offers: 0, dispatch_round: 5, dispatch_exhausted_at: "2026-10-22T10:00:00Z" });
    expect(s.kind).toBe("none"); expect(s.text).toMatch(/No rider has accepted yet/); expect(s.text).toMatch(/keep searching/);
  });
});
