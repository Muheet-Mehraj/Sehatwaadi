import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import { isNative } from "./services/platform.js";
import { createNativeGeo } from "./services/nativeGeo.js";
import { initBackButton } from "./services/backStack.js";

const native = isNative();
if (native) initBackButton();
// Android app: background-capable GPS. Web/PWA: the browser's own geolocation (default).
createRoot(document.getElementById("root")).render(<App geo={native ? createNativeGeo() : undefined} />);
// The service worker is for the web/PWA build only; the installed app ships its own files.
if (!native && "serviceWorker" in navigator && import.meta.env.PROD) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
