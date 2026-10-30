// After ~5 minutes in the background Android throttles HTTP started from the WebView, which would silently stop location pushes
// (and the rider would drop offline). On Android we send Supabase's JSON calls through CapacitorHttp (native networking)
// instead. Uploads (the delivery photo: Blob/FormData) and websockets keep using the normal fetch.
export function createNativeFetch({ http, baseFetch = (...a) => globalThis.fetch(...a), native = true } = {}) {
  const NULL_BODY = new Set([101, 204, 205, 304]);
  return async function nativeFetch(input, init = {}) {
    if (!native || !http || typeof input !== "string") return baseFetch(input, init);
    const body = init.body;
    const textBody = body == null || typeof body === "string";
    if (!textBody || /\/storage\/v1\//.test(input)) return baseFetch(input, init);
    const signal = init.signal;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const headers = {}; new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
    const req = http.request({ url: input, method: (init.method || "GET").toUpperCase(), headers, data: body ?? undefined, responseType: "text" });
    const abort = signal ? new Promise((_, rej) => signal.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")), { once: true })) : null;
    const res = await (abort ? Promise.race([req, abort]) : req);
    const text = typeof res.data === "string" ? res.data : res.data == null ? "" : JSON.stringify(res.data);
    return new Response(NULL_BODY.has(res.status) ? null : text, { status: res.status, headers: res.headers || {} });
  };
}
