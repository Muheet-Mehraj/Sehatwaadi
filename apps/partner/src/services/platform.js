// One place that knows whether we are the installed Android app or the web/PWA build.
import { Capacitor } from "@capacitor/core";
export const isNative = () => { try { return Capacitor.isNativePlatform(); } catch { return false; } };
