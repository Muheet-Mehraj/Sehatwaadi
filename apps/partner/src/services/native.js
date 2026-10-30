// Haptics: native-only, silent no-ops on the web build.
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import { isNative } from "./platform.js";
const run = (fn) => { if (!isNative()) return; try { Promise.resolve(fn()).catch(() => {}); } catch { /* ignore */ } };
export const hapticTap = () => run(() => Haptics.impact({ style: ImpactStyle.Light }));
export const hapticHeavy = () => run(() => Haptics.impact({ style: ImpactStyle.Heavy }));
export const hapticSuccess = () => run(() => Haptics.notification({ type: NotificationType.Success }));
export const hapticError = () => run(() => Haptics.notification({ type: NotificationType.Error }));
