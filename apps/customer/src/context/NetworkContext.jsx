import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Network } from '@capacitor/network';
import { HUB_URL } from '../api/client.js';

const NetworkContext = createContext({ online: true });

const PROBE_EVERY_MS = 8000;
const PROBE_TIMEOUT_MS = 5000;

// Emulators and captive Wi-Fi often report "disconnected" while requests work, and a false "offline" blocks checkout.
// So when the plugin says offline we ask the Hub itself; any HTTP answer at all (even an error page) means we're online.
async function hubReachable() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(HUB_URL, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function NetworkProvider({ children }) {
  const [pluginOnline, setPluginOnline] = useState(true);
  const [probeOnline, setProbeOnline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let handle = null;

    Network.getStatus().then((s) => { if (!cancelled) setPluginOnline(s.connected); }).catch(() => {});
    Network.addListener('networkStatusChange', (s) => setPluginOnline(s.connected)).then((h) => {
      if (cancelled) h.remove(); else handle = h;
    });

    return () => { cancelled = true; if (handle) handle.remove(); };
  }, []);

  useEffect(() => {
    if (pluginOnline) return undefined;
    let alive = true;
    const probe = async () => { const ok = await hubReachable(); if (alive) setProbeOnline(ok); };
    probe();
    const timer = setInterval(probe, PROBE_EVERY_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [pluginOnline]);

  const value = useMemo(() => ({ online: pluginOnline || probeOnline }), [pluginOnline, probeOnline]);
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useNetwork() {
  return useContext(NetworkContext);
}
