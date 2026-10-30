import { dedupeMedicines } from "../utils/helpers.js";

export const HUB_URL = import.meta.env?.VITE_HUB_URL || "http://localhost:8080";

if (import.meta.env?.PROD && HUB_URL.startsWith("http://")) {
  // Android blocks cleartext traffic in release builds. Set VITE_HUB_URL to an https:// URL.
  console.error("[SehatWaadi] VITE_HUB_URL is not HTTPS; requests will fail on release Android builds.");
}

// ── Auth plumbing (registered by AuthProvider / AuthUIProvider; avoids circular imports) ──
let authToken = null;
let onUnauthorized = null;
export const setAuthToken = (token) => { authToken = token || null; };
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn || null; };

/**
 * options.auth (default true): attach the JWT and treat 401 as "session expired".
 * Pass auth:false for the OTP endpoints, where a 401 just means a wrong code.
 */
export async function apiRequest(path, options = {}) {
  const { auth = true, headers, ...rest } = options;
  const finalHeaders = { "Content-Type": "application/json", ...(headers || {}) };
  if (auth && authToken) finalHeaders.Authorization = `Bearer ${authToken}`;

  let res;
  try {
    res = await fetch(`${HUB_URL}${path}`, { ...rest, headers: finalHeaders });
  } catch {
    throw new Error("Can't reach SehatWaadi. Check your internet connection.");
  }

  const data = await res.json().catch(() => ({}));

  if (res.status === 401 && auth && authToken && onUnauthorized) {
    onUnauthorized();
    throw new Error("Your session expired. Please log in again.");
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data.code;      // e.g. ACTIVE_ORDER, TOO_LATE
    err.data = data;
    throw err;
  }
  return data;
}

// The Hub can return one row per batch; collapse to one card per medicine.
// Handles a bare array or the common wrapper keys.
function dedupeResponse(r) {
  if (Array.isArray(r)) return dedupeMedicines(r);
  if (r && typeof r === "object") {
    for (const key of ["medicines", "results", "items", "data"]) {
      if (Array.isArray(r[key])) return { ...r, [key]: dedupeMedicines(r[key]) };
    }
  }
  return r;
}

export const api = {
  searchMedicines: (q, opts = {}) =>
    apiRequest(`/api/medicines/search?q=${encodeURIComponent(q)}${opts.rx ? "&rx=1" : ""}`).then(dedupeResponse),
  createOrder: (payload) =>
    apiRequest(`/api/orders/create`, { method: "POST", body: JSON.stringify(payload) }),
  getOrder: (orderId) => apiRequest(`/api/orders/${orderId}`),
  getMyOrders: () => apiRequest(`/api/orders/mine`),
  // Delivery (rider) tracking + the 4-digit handover code. Both need the customer's login and only work for their own order.
  getDelivery: (orderId) => apiRequest(`/api/delivery/by-order/${orderId}`),
  // The customer's one in-progress order (or null). The Hub also refuses a second order while this is set.
  getActiveOrder: () => apiRequest(`/api/delivery/my-active-order`),
  // Allowed until the rider has picked the order up.
  cancelOrder: (orderId) => apiRequest(`/api/delivery/by-order/${orderId}/cancel`, { method: "POST", body: "{}" }),
  getDeliveryOtp: (orderId) => apiRequest(`/api/delivery/by-order/${orderId}/otp`),
  // Tells the rider where to go: the address text + landmark the customer typed for THIS order.
  saveDeliveryAddress: (orderId, { line, landmark }) =>
    apiRequest(`/api/delivery/by-order/${orderId}/address`, { method: "POST", body: JSON.stringify({ line, landmark }) }),
  // Public catalog for the home screen (auth:false so an expired login can never log someone out of just browsing).
  getCatalogHome: () => apiRequest(`/api/catalog/home`, { auth: false }),
  getMedicine: (id) => apiRequest(`/api/catalog/medicine/${encodeURIComponent(id)}`, { auth: false }),
  getCatalogCategory: (key) => apiRequest(`/api/catalog/category/${encodeURIComponent(key)}`, { auth: false }),
};
