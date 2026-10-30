// Shrinks a photo before upload: a 12 MP phone/webcam picture becomes a ~640 px WebP of roughly 30-60 KB (the Hub accepts up to 150 KB).
export const MAX_SIDE = 640;
export const TARGET_BYTES = 120 * 1024;

// Largest size that fits inside max x max, never enlarging.
export function fitWithin(w, h, max = MAX_SIDE) {
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0 };
  const k = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

// `canvasFactory(w, h)` and `decode(file)` are injectable so this is testable without a browser.
export async function shrinkImage(file, { max = MAX_SIDE, targetBytes = TARGET_BYTES, decode, canvasFactory } = {}) {
  const dec = decode || (async (f) => { const bmp = await createImageBitmap(f); return { source: bmp, width: bmp.width, height: bmp.height }; });
  const mk = canvasFactory || ((w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; });
  const img = await dec(file);
  const { width, height } = fitWithin(img.width, img.height, max);
  if (!width) throw new Error("That file is not a readable picture.");
  const canvas = mk(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height);          // transparent PNGs get a white background, not black
  ctx.drawImage(img.source, 0, 0, width, height);
  const toBlob = (type, q) => new Promise((res) => canvas.toBlob(res, type, q));
  let blob = null;
  for (const q of [0.85, 0.75, 0.65, 0.5, 0.4]) {
    blob = await toBlob("image/webp", q);
    if (!blob || blob.type !== "image/webp") blob = await toBlob("image/jpeg", q);   // a browser without WebP encoding falls back to JPEG
    if (blob && blob.size <= targetBytes) return blob;
  }
  if (!blob) throw new Error("Could not prepare the photo.");
  throw new Error("The photo is too detailed to shrink enough. Try a plainer background.");
}
