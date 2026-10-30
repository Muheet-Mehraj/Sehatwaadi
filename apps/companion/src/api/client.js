// Every call carries the pharmacy id + key. The Hub is the only thing this app talks to.
const KEY = "swc.session";

export const readSession = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } };
export const writeSession = (s) => { try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* storage blocked */ } };

export class ApiError extends Error {
  constructor(status, body) {
    super((body && (body.message || body.error)) || `Request failed (${status})`);
    this.status = status; this.code = body && body.error; this.body = body || {};
  }
}

export async function api(path, { method = "GET", body, session } = {}) {
  const s = session || readSession();
  if (!s) throw new ApiError(401, { error: "no_session" });
  let res;
  try {
    res = await fetch(s.hubUrl.replace(/\/+$/, "") + path, {
      method,
      headers: { "content-type": "application/json", "x-pharmacy-id": s.pharmacyId, "x-pharmacy-key": s.apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw new ApiError(0, { error: "network", message: "Cannot reach the SehatWaadi server. Check the internet connection." }); }
  let data = null; try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// The pickup/return QR must look like SW1.<delivery id>.<token> (the rider app validates exactly this).
const QR_RE = /^SW1\.[0-9a-f-]{36}\.[0-9a-f]{16,64}$/i;
export function findQr(obj, deliveryId) {
  const seen = new Set();
  const walk = (v) => {
    if (typeof v === "string") return QR_RE.test(v) ? v : null;
    if (v && typeof v === "object" && !seen.has(v)) { seen.add(v); for (const x of Object.values(v)) { const f = walk(x); if (f) return f; } }
    return null;
  };
  const direct = walk(obj);
  if (direct) return direct;
  const token = obj && (obj.token || obj.pickup_token || obj.return_token || (obj.r && (obj.r.token || obj.r.pickup_token || obj.r.return_token)));
  return deliveryId && typeof token === "string" ? `SW1.${deliveryId}.${token}` : null;
}
