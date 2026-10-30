// Android location with a foreground service, so GPS keeps flowing (and the rider stays "online" server-side) with the screen
// off or the app in the background. Wrapped in the same watchPosition / clearWatch / getCurrentPosition shape as
// navigator.geolocation, so useGeolocationStream and the rest of the app don't know the difference.
import { registerPlugin } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";

const BackgroundGeolocation = registerPlugin("BackgroundGeolocation");

const toPosition = (l) => ({ coords: { latitude: l.latitude, longitude: l.longitude, accuracy: l.accuracy ?? null, speed: l.speed ?? null, heading: l.bearing ?? null }, timestamp: l.time || Date.now() });
const toError = (e) => ({ code: e?.code === "NOT_AUTHORIZED" || /denied|not authorized/i.test(e?.message || "") ? 1 : 2, message: e?.message || "location error" });

export function createNativeGeo({ plugin = BackgroundGeolocation, current = Geolocation,
  title = "SehatWaadi Partner", message = "You're online. You'll be alerted when an order is available." } = {}) {
  const watchers = new Map(); let seq = 0;
  return {
    watchPosition(success, error) {
      const token = ++seq, entry = { id: null, removed: false };
      watchers.set(token, entry);
      Promise.resolve(plugin.addWatcher(
        { backgroundTitle: title, backgroundMessage: message, requestPermissions: true, stale: false, distanceFilter: 0 },
        (loc, err) => { if (entry.removed) return; if (err) { error?.(toError(err)); return; } if (loc) success(toPosition(loc)); },
      )).then((id) => { entry.id = id; if (entry.removed) plugin.removeWatcher({ id }).catch(() => {}); })
        .catch((e) => error?.(toError(e)));
      return token;
    },
    clearWatch(token) {
      const e = watchers.get(token); if (!e) return;
      watchers.delete(token); e.removed = true;
      if (e.id != null) Promise.resolve(plugin.removeWatcher({ id: e.id })).catch(() => {});
    },
    getCurrentPosition(success, error, opts = {}) {
      Promise.resolve(current.getCurrentPosition({ enableHighAccuracy: !!opts.enableHighAccuracy, maximumAge: opts.maximumAge, timeout: opts.timeout }))
        .then((p) => success(p), (e) => error?.(toError(e)));
    },
    openSettings: () => plugin.openSettings?.(),
  };
}
