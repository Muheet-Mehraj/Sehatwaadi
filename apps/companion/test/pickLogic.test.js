import { describe, it, expect } from "vitest";
import { canDispatch, packedNames, keyOf, stageOf, timerState, secondsLeft, mmss } from "../src/lib/pickLogic.js";
import { extractQr, QR_RE } from "../src/lib/qr.js";

const lines = [{ name: "Augmentin 625", quantity: 1 }, { name: " Dolo 650 ", quantity: 2 }];

describe("canDispatch", () => {
  it("blocks until every line is ticked", () => {
    expect(canDispatch({ lines, ticked: {} })).toMatchObject({ ok: false, left: 2 });
    expect(canDispatch({ lines, ticked: { [keyOf("Augmentin 625")]: true } })).toMatchObject({ ok: false, left: 1 });
    expect(canDispatch({ lines, ticked: { [keyOf("Augmentin 625")]: true, [keyOf("dolo 650")]: true } })).toEqual({ ok: true, left: 0 });
  });
  it("matches names case- and space-insensitively", () => {
    expect(keyOf(" Dolo 650 ")).toBe(keyOf("dolo 650"));
  });
  it("requires a verified prescription first", () => {
    const ticked = { [keyOf("Augmentin 625")]: true, [keyOf("dolo 650")]: true };
    expect(canDispatch({ lines, ticked, requiresRx: true, rxStatus: "PENDING" }).ok).toBe(false);
    expect(canDispatch({ lines, ticked, requiresRx: true, rxStatus: "VERIFIED" }).ok).toBe(true);
  });
  it("never dispatches an empty order", () => { expect(canDispatch({ lines: [], ticked: {} }).ok).toBe(false); });
  it("sends the original item names, only for ticked lines", () => {
    expect(packedNames(lines, { [keyOf("dolo 650")]: true })).toEqual([" Dolo 650 "]);
  });
});

describe("stage and timer", () => {
  it("is OFFERED until picking starts", () => {
    expect(stageOf({ pickingStarted: false })).toBe("OFFERED");
    expect(stageOf({ pickingStarted: true })).toBe("PICKING");
  });
  it("warns at 70% of the window and expires at zero", () => {
    const now = 1_000_000;
    expect(timerState({ deadlineMs: now + 200_000, totalSeconds: 300, now })).toBe("ok");
    expect(timerState({ deadlineMs: now + 90_000, totalSeconds: 300, now })).toBe("warn");   // 210 of 300 used = 70%
    expect(timerState({ deadlineMs: now - 1, totalSeconds: 300, now })).toBe("expired");
  });
  it("never goes negative and formats m:ss", () => {
    expect(secondsLeft(500, 9000)).toBe(0);
    expect(mmss(65)).toBe("1:05");
  });
});

describe("pickup QR", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000", token = "a1b2c3d4e5f60718";
  it("accepts a ready-made code", () => { expect(extractQr({ qr: `SW1.${id}.${token}` }, id)).toBe(`SW1.${id}.${token}`); });
  it("builds the code from a bare token", () => { expect(extractQr({ pickup_token: token }, id)).toBe(`SW1.${id}.${token}`); });
  it("rejects anything the rider app would not scan", () => {
    expect(extractQr({ qr: "hello" }, id)).toBeNull();
    expect(extractQr({ token: "zz" }, id)).toBeNull();
    expect(extractQr(null, id)).toBeNull();
    expect(QR_RE.test(`SW1.${id}.${token}`)).toBe(true);
  });
});
