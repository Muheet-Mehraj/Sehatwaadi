// Thin client for the Hub. The pharmacy id + key travel in headers (and the id in the body for POSTs, as the Hub expects).
export class ApiError extends Error {
  constructor(message, { status, code, data } = {}) { super(message); this.status = status; this.code = code; this.data = data; }
}

const trimUrl = (u) => String(u || "").trim().replace(/\/+$/, "");

export function createApi({ hubUrl, pharmacyId, apiKey }) {
  const base = trimUrl(hubUrl);
  const headers = { "Content-Type": "application/json", "x-pharmacy-id": pharmacyId, "x-pharmacy-key": apiKey };

  async function call(method, path, body, { timeoutMs = 15000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(base + path, { method, headers, signal: ctrl.signal, body: body === undefined ? undefined : JSON.stringify({ pharmacyId, ...body }) });
    } catch (e) {
      throw new ApiError(e.name === "AbortError" ? "The Hub did not answer in time." : "Cannot reach the Hub. Check the internet connection.", { code: "NETWORK" });
    } finally { clearTimeout(t); }
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    if (!res.ok || (data && data.ok === false)) {
      throw new ApiError((data && (data.message || data.error)) || `Request failed (${res.status})`, { status: res.status, code: data && (data.code || data.error), data });
    }
    return data;
  }
  const get = (p, o) => call("GET", p, undefined, o);
  const post = (p, b = {}, o) => call("POST", p, b, o);
  const q = `pharmacyId=${encodeURIComponent(pharmacyId)}`;
  const qs = q;
  // body is the picture itself (not JSON)
  async function raw(method, path, blob) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30000); let res;
    try { res = await fetch(base + path, { method, signal: ctrl.signal, headers: { "x-pharmacy-id": pharmacyId, "x-pharmacy-key": apiKey, ...(blob ? { "Content-Type": blob.type || "application/octet-stream" } : {}) }, body: blob }); }
    catch (e) { throw new ApiError(e.name === "AbortError" ? "The Hub did not answer in time." : "Cannot reach the Hub. Check the internet connection.", { code: "NETWORK" }); }
    finally { clearTimeout(t); }
    let data = null; try { data = await res.json(); } catch { /* not json */ }
    if (!res.ok || (data && data.ok === false)) throw new ApiError((data && (data.message || data.error)) || `Request failed (${res.status})`, { status: res.status, code: data && data.error, data });
    return data;
  }

  return {
    // presence
    heartbeat: (paused) => post("/api/companion/heartbeat", { paused: Boolean(paused) }),
    // orders
    listOrders: () => get(`/api/companion/orders?${q}`),
    getOrder: (id) => get(`/api/companion/orders/${id}?${q}`, { timeoutMs: 30000 }),
    startPicking: (id) => post(`/api/companion/orders/${id}/start-picking`),
    extend: (id) => post(`/api/companion/orders/${id}/extend`),
    release: (id, reason, missingItems = []) => post(`/api/companion/orders/${id}/release`, { reason, missingItems }),
    dispatch: (id, packed) => post(`/api/companion/orders/${id}/dispatch`, { packed }),
    verifyRx: (id, decision) => post(`/api/orders/${id}/verify-rx`, { decision }),
    // deliveries (existing delivery module)
    retryDispatch: (orderId) => post("/api/delivery/dispatch", { orderId }),
    deliveries: () => get(`/api/delivery/pharmacy/${pharmacyId}`),
    pickupQr: (deliveryId) => get(`/api/delivery/${deliveryId}/pickup-qr`),
    returnQr: (deliveryId) => get(`/api/delivery/${deliveryId}/return-qr`),
    reassign: (deliveryId, reason) => post(`/api/delivery/${deliveryId}/reassign`, { reason }),
    initiateReturn: (deliveryId, reason) => post(`/api/delivery/${deliveryId}/return`, { reason }),
    // money + shelf
    terms: () => get(`/api/companion/terms?${q}`),
    settlements: (days = 30) => get(`/api/companion/settlements?${q}&days=${days}`),
    blocks: () => get(`/api/companion/blocks?${q}`),
    restock: (itemKey) => post("/api/companion/blocks/restock", { itemKey }),
    blockItem: (name) => post("/api/companion/blocks/block", { name }),
    searchMedicines: (text) => fetch(`${base}/api/medicines/search?q=${encodeURIComponent(text)}`).then((r) => r.json()),
    // settlement payouts (claim -> SehatWaadi pays -> you confirm)
    payouts: () => get(`/api/companion/payouts?${q}`),
    requestPayout: () => post("/api/companion/payouts/request"),
    withdrawPayout: (id) => post(`/api/companion/payouts/${id}/withdraw`),
    confirmPayout: (id) => post(`/api/companion/payouts/${id}/confirm`),
    disputePayout: (id, note) => post(`/api/companion/payouts/${id}/dispute`, { note }),
    // catalog photos (chemist verifies a medicine by photographing it)
    listCatalogImages: ({ q = "", missing = false, limit = 40 } = {}) => get(`/api/companion/catalog-images?${qs}&q=${encodeURIComponent(q)}&missing=${missing ? 1 : 0}&limit=${limit}`),
    uploadCatalogImage: (id, blob) => raw("PUT", `/api/companion/catalog-images/${id}`, blob),
    removeCatalogImage: (id) => raw("DELETE", `/api/companion/catalog-images/${id}`),
    health: () => fetch(`${base}/health`).then((r) => r.ok),
  };
}
