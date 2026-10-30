import { describe, it, expect } from "vitest";
import { validAadhaar, cleanAadhaar, groupAadhaar, validPan, cleanPan, validDl, cleanDl, validDob, validExpiry, problems, docOrder } from "../src/services/kyc.js";

// Build a valid Aadhaar number the same way UIDAI does (Verhoeff check digit) so the tests don't rely on a real person's number.
const D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
const INV = [0,4,3,2,1,5,6,7,8,9];
const withCheck = (eleven) => { let c = 0; [...eleven].reverse().forEach((d, i) => { c = D[c][P[(i + 1) % 8][+d]]; }); return eleven + INV[c]; };
const GOOD = withCheck("23456789012");
const NOW = new Date("2026-10-25T10:00:00Z");

describe("Aadhaar", () => {
  it("accepts a number with the right check digit, with or without spaces", () => { expect(GOOD).toHaveLength(12); expect(validAadhaar(GOOD)).toBe(true); expect(validAadhaar(groupAadhaar(GOOD))).toBe(true); });
  it("rejects a single mistyped digit anywhere", () => {
    for (let i = 0; i < 12; i++) { const bad = GOOD.slice(0, i) + String((+GOOD[i] + 1) % 10) + GOOD.slice(i + 1); expect(validAadhaar(bad)).toBe(false); }
  });
  it("rejects swapped neighbours, short, long, letters, and numbers starting with 0 or 1", () => {
    const swapped = GOOD[1] === GOOD[2] ? null : GOOD[0] + GOOD[2] + GOOD[1] + GOOD.slice(3); if (swapped) expect(validAadhaar(swapped)).toBe(false);
    expect(validAadhaar(GOOD.slice(0, 11))).toBe(false); expect(validAadhaar("")).toBe(false); expect(validAadhaar(null)).toBe(false);
    expect(validAadhaar(withCheck("03456789012"))).toBe(false); expect(validAadhaar(withCheck("13456789012"))).toBe(false);
  });
  it("cleans and groups while typing", () => { expect(cleanAadhaar("2345-6789 0123 99")).toBe("234567890123"); expect(groupAadhaar("234567890123")).toBe("2345 6789 0123"); expect(groupAadhaar("23456")).toBe("2345 6"); });
});
describe("PAN", () => {
  it("accepts an individual's PAN in any case", () => { expect(validPan("ABCPE1234F")).toBe(true); expect(validPan("abcpe1234f")).toBe(true); expect(validPan(" ABCPE 1234 F ")).toBe(true); });
  it("rejects wrong shapes and non-individual types (4th letter must be P)", () => {
    for (const x of ["ABCPE1234", "ABCPE12345", "12345ABCDE", "ABCDE1234F", "ABCCE1234F", "", null]) expect(validPan(x)).toBe(false);
  });
  it("uppercases and strips while typing", () => expect(cleanPan("abc-pe 1234f99")).toBe("ABCPE1234F"));
});
describe("driving licence", () => {
  it("accepts the common layouts, ignoring spaces and dashes", () => { for (const x of ["JK01 20190012345", "jk-01-2019-0012345", "DL0420110149646", "MH1220180001234"]) expect(validDl(x)).toBe(true); expect(cleanDl("jk01 2019-0012345")).toBe("JK0120190012345"); });
  it("rejects junk", () => { for (const x of ["", "123", "JKJK20190012345", "JK01", null]) expect(validDl(x)).toBe(false); });
});
describe("dates", () => {
  it("must be 18..70", () => {
    expect(validDob("1995-04-12", NOW)).toBe(true); expect(validDob("2008-10-26", NOW)).toBe(false); expect(validDob("2008-10-25", NOW)).toBe(true);
    expect(validDob("1950-01-01", NOW)).toBe(false); expect(validDob("1995-02-31", NOW)).toBe(false); expect(validDob("", NOW)).toBe(false); expect(validDob("12/04/1995", NOW)).toBe(false);
  });
  it("licence must expire in the future", () => { expect(validExpiry("2030-01-01", NOW)).toBe(true); expect(validExpiry("2026-10-25", NOW)).toBe(false); expect(validExpiry("2020-01-01", NOW)).toBe(false); expect(validExpiry("", NOW)).toBe(false); });
});
describe("what is still missing", () => {
  const ok = { docs: Object.fromEntries(["SELFIE", "AADHAAR_FRONT", "AADHAAR_BACK", "PAN", "DL_FRONT"].map((k) => [k, { status: "PENDING" }])), required: ["SELFIE", "AADHAAR_FRONT", "AADHAAR_BACK", "PAN", "DL_FRONT"], dob: "1995-04-12", aadhaar: GOOD, pan: "ABCPE1234F", dl: "JK0120190012345", dlExpiry: "2030-01-01" };
  it("nothing when complete", () => expect(problems(ok, NOW)).toEqual([]));
  it("lists missing and rejected pictures first", () => {
    const p = problems({ ...ok, docs: { ...ok.docs, PAN: { status: "REJECTED" }, SELFIE: undefined } }, NOW).map((x) => x.field);
    expect(p).toEqual(["SELFIE", "PAN"]);
  });
  it("a bicycle rider needs no licence", () => expect(problems({ ...ok, required: ["SELFIE", "AADHAAR_FRONT", "AADHAAR_BACK", "PAN"], dl: "", dlExpiry: "" }, NOW)).toEqual([]));
  it("a saved Aadhaar (last 4) counts when the rider does not retype it, but a mistyped new one does not", () => {
    expect(problems({ ...ok, aadhaar: "", aadhaarLast4: "9012" }, NOW)).toEqual([]);
    expect(problems({ ...ok, aadhaar: GOOD.slice(0, 11) + String((+GOOD[11] + 1) % 10), aadhaarLast4: "9012" }, NOW).map((x) => x.field)).toEqual(["aadhaar"]);
    expect(problems({ ...ok, aadhaar: "", aadhaarLast4: null }, NOW).map((x) => x.field)).toEqual(["aadhaar"]);
  });
  it("document order follows the screen order", () => expect(docOrder(["PAN", "SELFIE"])).toEqual(["SELFIE", "PAN"]));
});
