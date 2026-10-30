import { describe, it, expect, vi } from "vitest";
import { createPush, OFFER_CHANNEL } from "../src/services/push.js";

function fakePlugin({ perm = "granted", requestResult = "granted" } = {}) {
  const listeners = {};
  return {
    listeners,
    createChannel: vi.fn().mockResolvedValue(),
    addListener: vi.fn(async (name, cb) => { listeners[name] = cb; return { remove: vi.fn().mockResolvedValue() }; }),
    checkPermissions: vi.fn().mockResolvedValue({ receive: perm }),
    requestPermissions: vi.fn().mockResolvedValue({ receive: requestResult }),
    register: vi.fn().mockResolvedValue(),
    removeAllDeliveredNotifications: vi.fn().mockResolvedValue(),
  };
}

describe("push notifications (FCM)", () => {
  it("does nothing in the browser/PWA build", async () => {
    const plugin = fakePlugin(); const p = createPush({ plugin, native: () => false });
    expect(await p.start({})).toEqual({ ok: false, reason: "not_native" });
    expect(plugin.register).not.toHaveBeenCalled();
  });
  it("creates the loud channels BEFORE registering, so the first push already rings", async () => {
    const order = []; const plugin = fakePlugin();
    plugin.createChannel.mockImplementation(async (c) => { order.push("channel:" + c.id); });
    plugin.register.mockImplementation(async () => { order.push("register"); });
    await createPush({ plugin, native: () => true }).start({});
    expect(order).toEqual(["channel:offers", "channel:jobs", "register"]);
    expect(OFFER_CHANNEL.importance).toBe(5);
  });
  it("hands the token to the app, and again if Firebase rotates it", async () => {
    const plugin = fakePlugin(); const onToken = vi.fn(); const p = createPush({ plugin, native: () => true });
    await p.start({ onToken });
    plugin.listeners.registration({ value: "tok-1" }); plugin.listeners.registration({ value: "tok-2" });
    expect(onToken.mock.calls.map((c) => c[0])).toEqual(["tok-1", "tok-2"]); expect(p.currentToken()).toBe("tok-2");
  });
  it("a push received in the app, and a tap on one, both wake the app with the data", async () => {
    const plugin = fakePlugin(); const onWake = vi.fn();
    await createPush({ plugin, native: () => true }).start({ onWake });
    plugin.listeners.pushNotificationReceived({ data: { type: "OFFER", offerId: "o1" } });
    plugin.listeners.pushNotificationActionPerformed({ notification: { data: { type: "OFFER", offerId: "o1" } } });
    expect(onWake).toHaveBeenNthCalledWith(1, { type: "OFFER", offerId: "o1" }, "foreground");
    expect(onWake).toHaveBeenNthCalledWith(2, { type: "OFFER", offerId: "o1" }, "tap");
  });
  it("asks for permission once when it has not been granted, and does not register if refused", async () => {
    const asked = fakePlugin({ perm: "prompt", requestResult: "granted" });
    expect((await createPush({ plugin: asked, native: () => true }).start({})).ok).toBe(true); expect(asked.requestPermissions).toHaveBeenCalledTimes(1);
    const refused = fakePlugin({ perm: "prompt", requestResult: "denied" }); const p = createPush({ plugin: refused, native: () => true });
    expect(await p.start({})).toEqual({ ok: false, reason: "permission_denied" }); expect(refused.register).not.toHaveBeenCalled(); expect(p.lastError()).toBe("permission_denied");
  });
  it("starting twice does not register twice; stop() lets it start again", async () => {
    const plugin = fakePlugin(); const p = createPush({ plugin, native: () => true });
    await p.start({}); expect((await p.start({})).already).toBe(true); expect(plugin.register).toHaveBeenCalledTimes(1);
    await p.stop(); await p.start({}); expect(plugin.register).toHaveBeenCalledTimes(2);
  });
  it("a plugin failure is reported, never thrown", async () => {
    const plugin = fakePlugin(); plugin.register.mockRejectedValue(new Error("no google services"));
    expect(await createPush({ plugin, native: () => true }).start({})).toEqual({ ok: false, reason: "no google services" });
  });
  it("can clear delivered notifications, and ignores failure", async () => {
    const plugin = fakePlugin(); const p = createPush({ plugin, native: () => true });
    await p.clearDelivered(); expect(plugin.removeAllDeliveredNotifications).toHaveBeenCalled();
    plugin.removeAllDeliveredNotifications.mockRejectedValue(new Error("x")); await expect(p.clearDelivered()).resolves.toBeUndefined();
  });
});
