import { describe, it, expect } from "vitest";
import { fitWithin, shrinkImage, TARGET_BYTES } from "../src/lib/image.js";

describe("photo shrinking", () => {
  it("fits inside the limit, keeps the shape, never enlarges", () => {
    expect(fitWithin(4000, 3000, 640)).toEqual({ width: 640, height: 480 });
    expect(fitWithin(3000, 4000, 640)).toEqual({ width: 480, height: 640 });
    expect(fitWithin(300, 200, 640)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(0, 10)).toEqual({ width: 0, height: 0 });
  });
  const stub = (sizes, calls = []) => ({
    decode: async () => ({ source: "img", width: 4000, height: 3000 }),
    canvasFactory: (w, h) => ({ w, h, getContext: () => ({ fillRect() {}, drawImage: (...a) => calls.push(a), set fillStyle(v) {} }),
      toBlob: (cb, type, q) => cb({ type, size: sizes.shift() ?? 1, q }) }),
  });
  it("draws at the shrunk size on a white background and returns the first encoding under the target", async () => {
    const calls = []; const blob = await shrinkImage({}, stub([TARGET_BYTES + 1, 50000], calls));
    expect(blob.size).toBe(50000); expect(blob.type).toBe("image/webp"); expect(calls[0].slice(1)).toEqual([0, 0, 640, 480]);
  });
  it("falls back to JPEG when the browser cannot encode WebP", async () => {
    const s = stub([]); const f = s.canvasFactory; s.canvasFactory = (w, h) => { const c = f(w, h); c.toBlob = (cb, type) => cb({ type: type === "image/webp" ? "image/png" : type, size: 40000 }); return c; };
    expect((await shrinkImage({}, s)).type).toBe("image/jpeg");
  });
  it("gives a clear error when it cannot get small enough, or the file is not a picture", async () => {
    await expect(shrinkImage({}, stub(Array(10).fill(TARGET_BYTES * 2)))).rejects.toThrow(/too detailed/);
    await expect(shrinkImage({}, { decode: async () => ({ source: null, width: 0, height: 0 }) })).rejects.toThrow(/not a readable picture/);
  });
});
