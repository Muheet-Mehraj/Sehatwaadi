// Thin client for the Hub. Every call carries the pharmacy id and key; the Hub is the only place that decides anything.
export class ApiError extends Error {
  constructor(status, body) {
    super((body && (body.message || body.error)) || `Request failed (${status})`);
    this.status = status; this.body = body || {}; this.code = (body && (body.code || body.error)) || "";
  }
  get reassigned() { return this.code === "ORDER_REASSIGNED"; }
}

export function createApi({ hubUrl, pharmacyId, apiKey }) {
  async function call(method, path, body) {
    const get = method === "GET";
    const url = `${hubUrl}${path}${get ? `${path.includes("?") ? "&" : "?"}pharmacyId=${encodeURIComponent(pharmacyId)}` : ""}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { "content-type": "application/json", "x-pharmacy-key": apiKey, "x-pharmacy-id": pharmacyId },
        body: get ? undefined : JSON.stringify({ ...(body || {}), pharmacyId }),
      });
    } catch { throw new ApiError(0, { error: "network", message: "Cannot reach SehatWaadi. Check the internet connection." }); }
    let json = null; try { json = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new ApiError(res.status, json);
    return json;
  }
  const co = (p) => `/api/companion${p}`;
  const dl = (p) => `/api/delivery${p}`;
  return {
    heartbeat: (paused) => call("POST", co("/heartbeat"), { paused }),
    pendingOrders: () => call("GET", co("/orders")),
    order: (id) => call("GET", co(`/orders/${id}`)),
    startPicking: (id) => call("POST", co(`/orders/${id}/start-picking`)),
    extend: (id) => call("POST", co(`/orders/${id}/extend`)),
    release: (id, reason, missingItems) => call("POST", co(`/orders/${id}/release`), { reason, missingItems }),
    verifyRx: (id, decision) => call("POST", `/api/orders/${id}/verify-rx`, { decision }),
    dispatch: (id, packed) => call("POST", co(`/orders/${id}/dispatch`), { packed }),
    retryDispatch: (orderId) => call("POST", dl("/dispatch"), { orderId }),
    deliveries: () => call("GET", dl(`/pharmacy/${pharmacyId}`)),
    pickupQr: (deliveryId) => call("GET", dl(`/${deliveryId}/pickup-qr`)),
    returnQr: (deliveryId) => call("GET", dl(`/${deliveryId}/return-qr`)),
    reassign: (deliveryId, reason) => call("POST", dl(`/${deliveryId}/reassign`), { reason }),
    initiateReturn: (deliveryId, reason) => call("POST", dl(`/${deliveryId}/return`), { reason }),
    settlements: (days = 30) => call("GET", co(`/settlements?days=${days}`)),
    blocks: () => call("GET", co("/blocks")),
    restock: (itemKey) => call("POST", co("/blocks/restock"), { itemKey }),
    block: (name) => call("POST", co("/blocks/block"), { name }),
    searchMedicines: async (q) => { const r = await fetch(`${hubUrl}/api/medicines/search?q=${encodeURIComponent(q)}`); return r.ok ? r.json() : []; },
  };
}
