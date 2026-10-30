// Rider KYC helpers: the checks the phone makes BEFORE anything is sent (the database repeats them), and picture preparation.
// The full Aadhaar number never leaves the phone: it is checked here (12 digits + Verhoeff check digit) and only the last 4 digits are sent.

export const DOCS = {
  SELFIE: { label: "Your photo (selfie)", hint: "Face clearly visible, good light, no cap or sunglasses.", capture: "user", maxSide: 900 },
  AADHAAR_FRONT: { label: "Aadhaar card - front", hint: "All four corners visible. Text must be readable.", maxSide: 1400 },
  AADHAAR_BACK: { label: "Aadhaar card - back", hint: "All four corners visible. Text must be readable.", maxSide: 1400 },
  PAN: { label: "PAN card", hint: "Whole card, no glare.", maxSide: 1400 },
  DL_FRONT: { label: "Driving licence", hint: "Front of the licence, showing the number and the expiry date.", maxSide: 1400 },
};
export const docOrder = (required = Object.keys(DOCS)) => Object.keys(DOCS).filter((k) => required.includes(k));

// ---- Aadhaar: 12 digits, first digit 2-9, Verhoeff check digit ----------------------------------------------------------------------
const D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
export const cleanAadhaar = (s) => String(s || "").replace(/\D/g, "").slice(0, 12);
export const validAadhaar = (s) => {
  const n = cleanAadhaar(s); if (!/^[2-9][0-9]{11}$/.test(n)) return false;
  let c = 0; const rev = n.split("").reverse().map(Number);
  rev.forEach((d, i) => { c = D[c][P[i % 8][d]]; });
  return c === 0;
};
export const groupAadhaar = (s) => cleanAadhaar(s).replace(/(\d{4})(?=\d)/g, "$1 ");

// ---- PAN: AAAAA9999A, 4th letter P (an individual) -------------------------------------------------------------------------------------
export const cleanPan = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
export const validPan = (s) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(cleanPan(s)) && cleanPan(s)[3] === "P";

// ---- licence: state(2) RTO(2) then year + serial; spaces and dashes are ignored ------------------------------------------------------
export const cleanDl = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 17);
export const validDl = (s) => /^[A-Z]{2}[0-9]{2}[A-Z0-9]{9,13}$/.test(cleanDl(s));

const iso = (d) => d.toISOString().slice(0, 10);
export const validDob = (s, now = new Date()) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false; const d = new Date(s + "T00:00:00Z"); if (Number.isNaN(+d) || iso(d) !== s) return false;
  const y = (n) => { const t = new Date(now); t.setUTCFullYear(t.getUTCFullYear() - n); return iso(t); };
  return s <= y(18) && s >= y(70);
};
export const validExpiry = (s, now = new Date()) => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !Number.isNaN(+new Date(s + "T00:00:00Z")) && s > iso(now);

// What is still missing / wrong, in the order the rider fills the screen. `needsDl` is false for bicycles.
export function problems({ docs = {}, required = [], dob, aadhaar, aadhaarLast4, pan, dl, dlExpiry }, now = new Date()) {
  const out = [];
  for (const k of required) if (!docs[k] || docs[k].status === "REJECTED") out.push({ field: k, text: `Add: ${DOCS[k]?.label || k}` });
  if (!validDob(dob, now)) out.push({ field: "dob", text: "Enter your date of birth (you must be 18 or older)" });
  if (!(aadhaar ? validAadhaar(aadhaar) : /^[0-9]{4}$/.test(aadhaarLast4 || ""))) out.push({ field: "aadhaar", text: "Enter your 12-digit Aadhaar number correctly" });
  if (!validPan(pan)) out.push({ field: "pan", text: "Enter your PAN (like ABCPE1234F)" });
  if (required.includes("DL_FRONT")) {
    if (!validDl(dl)) out.push({ field: "dl", text: "Enter your driving licence number" });
    if (!validExpiry(dlExpiry, now)) out.push({ field: "dlExpiry", text: "Your licence must not be expired" });
  }
  return out;
}

// ---- pictures: shrink a camera photo to a small JPEG (<= ~150 KB) and return base64 -----------------------------------------------
export const MAX_BYTES = 150 * 1024;
export async function prepareImage(file, { maxSide = 1400, maxBytes = MAX_BYTES } = {}) {
  const bmp = await (typeof createImageBitmap === "function" ? createImageBitmap(file) : Promise.reject(new Error("no_image_support")));
  let scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  for (let attempt = 0; attempt < 8; attempt++) {
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h);
    for (const q of [0.82, 0.7, 0.58, 0.46]) {
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", q));
      if (blob && blob.size <= maxBytes) { bmp.close?.(); return { base64: await blobToBase64(blob), previewUrl: URL.createObjectURL(blob), bytes: blob.size }; }
    }
    scale *= 0.8;
  }
  bmp.close?.(); throw new Error("image_too_large");
}
const blobToBase64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1] || ""); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
