export const haversineKm = (a, b) => {
  const R = 6371, r = (x) => (x * Math.PI) / 180, dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
export const formatKm = (km) => (km == null ? "" : km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);
export const mapsLink = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=two_wheeler`;
export const telLink = (phone) => (phone ? `tel:${String(phone).replace(/[^\d+]/g, "")}` : null);
export const upiLink = (vpa, amount, note) => `upi://pay?pa=${encodeURIComponent(vpa)}&am=${Number(amount).toFixed(2)}&cu=INR&tn=${encodeURIComponent(note || "SehatWaadi cash settlement")}`;
// Shrink a camera photo to ~1280px JPEG so it uploads quickly on a weak connection.
export async function compressImage(file, maxSide = 1280, quality = 0.72) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("compress failed"))), "image/jpeg", quality));
}
