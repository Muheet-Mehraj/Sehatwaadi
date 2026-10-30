// Android hardware back button: one listener drives a stack of handlers. Sheets and sub-screens push while open, so Back
// always closes the topmost layer first. Empty stack => send the app to the background (the foreground location service
// keeps the rider online); it never kills the app mid-delivery.
import { App as CapApp } from "@capacitor/app";
import { isNative } from "./platform.js";
const stack = []; let installed = false;
export function initBackButton() {
  if (installed || !isNative()) return;
  installed = true;
  CapApp.addListener("backButton", () => {
    const top = stack[stack.length - 1];
    if (top) { top(); return; }
    CapApp.minimizeApp().catch(() => {});
  });
}
export function pushBackHandler(fn) {
  stack.push(fn);
  return () => { const i = stack.lastIndexOf(fn); if (i > -1) stack.splice(i, 1); };
}
