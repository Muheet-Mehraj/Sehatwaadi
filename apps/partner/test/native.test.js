import { describe, it, expect, vi } from "vitest";
import { createNativeFetch } from "../src/services/nativeFetch.js";
import { createNativeGeo } from "../src/services/nativeGeo.js";
import { getOnce } from "../src/services/quickFix.js";

describe("native fetch (Android background networking)", () => {
  it("sends JSON calls through the native http plugin and rebuilds a normal Response", async () => {
    const http = { request: vi.fn().mockResolvedValue({ status: 200, headers: { "content-type": "application/json" }, data: { ok: true } }) };
    const f = createNativeFetch({ http, baseFetch: vi.fn() });
    const res = await f("https://x.supabase.co/rest/v1/rpc/push_locations", { method: "POST", headers: { apikey: "k", "content-type": "application/json" }, body: '{"p_points":[]}' });
    expect(http.request).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", data: '{"p_points":[]}', headers: expect.objectContaining({ apikey: "k" }) }));
    expect(res.status).toBe(200); expect(await res.json()).toEqual({ ok: true });
  });
  it("handles empty 204 responses", async () => {
    const f = createNativeFetch({ http: { request: async () => ({ status: 204, headers: {}, data: "" }) }, baseFetch: vi.fn() });
    expect((await f("https://x/y", { method: "POST", body: "{}" })).status).toBe(204);
  });
  it("leaves uploads, websockets and non-string requests on the normal fetch", async () => {
    const base = vi.fn().mockResolvedValue("base"); const http = { request: vi.fn() };
    const f = createNativeFetch({ http, baseFetch: base });
    await f("https://x/storage/v1/object/delivery-proofs/a.jpg", { method: "POST", body: "abc" });
    await f("https://x/y", { method: "POST", body: new Blob(["a"]) });
    expect(base).toHaveBeenCalledTimes(2); expect(http.request).not.toHaveBeenCalled();
  });
  it("does nothing special off Android", async () => {
    const base = vi.fn().mockResolvedValue("base"); const f = createNativeFetch({ http: { request: vi.fn() }, baseFetch: base, native: false });
    expect(await f("https://x/y")).toBe("base");
  });
  it("honours an already-aborted signal", async () => {
    const c = new AbortController(); c.abort();
    await expect(createNativeFetch({ http: { request: vi.fn() } })("https://x/y", { signal: c.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("native geolocation adapter", () => {
  it("maps plugin locations to the browser Position shape and removes the watcher", async () => {
    let cb; const plugin = { addWatcher: vi.fn(async (_o, c) => { cb = c; return "w1"; }), removeWatcher: vi.fn(async () => {}) };
    const geo = createNativeGeo({ plugin, current: {} }); const got = [];
    const token = geo.watchPosition((p) => got.push(p), () => {});
    await Promise.resolve(); await Promise.resolve();
    cb({ latitude: 34.1, longitude: 74.8, accuracy: 12, speed: 3, bearing: 90, time: 1700000000000 });
    expect(got[0]).toEqual({ coords: { latitude: 34.1, longitude: 74.8, accuracy: 12, speed: 3, heading: 90 }, timestamp: 1700000000000 });
    expect(plugin.addWatcher.mock.calls[0][0]).toMatchObject({ requestPermissions: true, stale: false, backgroundMessage: expect.any(String) });
    geo.clearWatch(token); expect(plugin.removeWatcher).toHaveBeenCalledWith({ id: "w1" });
  });
  it("a watcher cleared before the plugin answers is still removed", async () => {
    let resolve; const plugin = { addWatcher: vi.fn(() => new Promise((r) => { resolve = r; })), removeWatcher: vi.fn(async () => {}) };
    const geo = createNativeGeo({ plugin, current: {} }); const t = geo.watchPosition(() => {}, () => {});
    geo.clearWatch(t); resolve("late"); await new Promise((r) => setTimeout(r, 0));
    expect(plugin.removeWatcher).toHaveBeenCalledWith({ id: "late" });
  });
  it("reports a permission refusal as code 1", async () => {
    let cb; const plugin = { addWatcher: vi.fn(async (_o, c) => { cb = c; return "w"; }), removeWatcher: vi.fn() };
    const errs = []; createNativeGeo({ plugin, current: {} }).watchPosition(() => {}, (e) => errs.push(e)); await Promise.resolve(); await Promise.resolve();
    cb(undefined, { code: "NOT_AUTHORIZED", message: "no" }); expect(errs[0].code).toBe(1);
  });
});

describe("quick position on going online", () => {
  it("returns a queue-ready point", async () => {
    const geo = { getCurrentPosition: (ok) => ok({ coords: { latitude: 1, longitude: 2, accuracy: 30 }, timestamp: 5 }) };
    expect(await getOnce(geo)).toEqual({ t: 5, lat: 1, lng: 2, accuracy: 30, speed: null, bearing: null });
  });
  it("gives up quietly on error, timeout or no geolocation", async () => {
    expect(await getOnce({ getCurrentPosition: (_o, bad) => bad({ code: 1 }) })).toBeNull();
    expect(await getOnce(undefined)).toBeNull();
    expect(await getOnce({ getCurrentPosition: () => {} }, { timeout: 10 })).toBeNull();
  });
});
