// One quick position (cached or coarse is fine) used the moment a rider goes online, so the server can hand over a waiting
// order immediately instead of after the first continuous GPS fix.
export function getOnce(geo, { timeout = 6000, maximumAge = 60000, enableHighAccuracy = false } = {}) {
  return new Promise((resolve) => {
    if (!geo?.getCurrentPosition) { resolve(null); return; }
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => finish(null), timeout + 1000);
    try {
      geo.getCurrentPosition((pos) => {
        const c = pos?.coords; if (!c) { finish(null); return; }
        finish({ t: pos.timestamp || Date.now(), lat: c.latitude, lng: c.longitude, accuracy: c.accuracy ?? null, speed: c.speed ?? null, bearing: c.heading ?? null });
      }, () => finish(null), { timeout, maximumAge, enableHighAccuracy });
    } catch { finish(null); }
  });
}
