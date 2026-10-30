import React from "react";
import { render, screen, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { Network } from "@capacitor/network";
import { NetworkProvider, useNetwork } from "./context/NetworkContext.jsx";
import { OfflineBanner } from "./components/common/UIComponents.jsx";

const Probe = () => { const { online } = useNetwork(); return <><span>{online ? "ONLINE" : "OFFLINE"}</span><OfflineBanner /></>; };
const flush = async (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.documentElement.style.removeProperty("--offline-h"); });

describe("network state", () => {
  it("trusts the plugin when it says online", async () => {
    Network.getStatus = async () => ({ connected: true }); const f = vi.fn(); vi.stubGlobal("fetch", f);
    render(<NetworkProvider><Probe /></NetworkProvider>); await flush(50);
    expect(screen.getByText("ONLINE")).toBeTruthy(); expect(f).not.toHaveBeenCalled(); expect(screen.queryByRole("status")).toBeNull();
  });

  it("a plugin that wrongly says OFFLINE is overruled when the Hub is reachable (the emulator case)", async () => {
    Network.getStatus = async () => ({ connected: false }); const f = vi.fn(async () => ({ type: "opaque" })); vi.stubGlobal("fetch", f);
    render(<NetworkProvider><Probe /></NetworkProvider>); await flush(100);
    expect(f).toHaveBeenCalled(); expect(f.mock.calls[0][1].method).toBe("HEAD"); expect(screen.getByText("ONLINE")).toBeTruthy(); expect(screen.queryByRole("status")).toBeNull();
  });

  it("really offline: banner shows and pushes the top bar down; recovers by itself when the Hub answers again", async () => {
    Network.getStatus = async () => ({ connected: false }); let up = false; vi.stubGlobal("fetch", vi.fn(async () => { if (!up) throw new TypeError("Failed to fetch"); return {}; }));
    render(<NetworkProvider><Probe /></NetworkProvider>); await flush(100);
    expect(screen.getByText("OFFLINE")).toBeTruthy(); expect(screen.getByRole("status").textContent).toMatch(/offline/);
    expect(document.documentElement.style.getPropertyValue("--offline-h")).toMatch(/^\d+px$/); expect(document.documentElement.style.getPropertyValue("--offline-h")).not.toBe("0px");
    up = true; await flush(8200); expect(screen.getByText("ONLINE")).toBeTruthy(); expect(document.documentElement.style.getPropertyValue("--offline-h")).toBe("0px");
  });
});
