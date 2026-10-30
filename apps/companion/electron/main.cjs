// Desktop shell: keeps the order terminal running on the billing PC.
//  - one instance only; closing the window hides it to the tray (orders keep arriving)
//  - starts with Windows
//  - when an order rings, the window comes to the front over the billing software and flashes until it is answered
//  - the PC is kept from "app suspension" so the live connection to the Hub is not paused
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, powerSaveBlocker, shell } = require("electron");
const path = require("path");

if (!app.requestSingleInstanceLock()) { app.quit(); return; }

let win = null, tray = null, quitting = false, ringing = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 640,
    backgroundColor: "#F7F3EC", title: "SehatWaadi Companion",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.removeMenu();
  const dev = process.env.COMPANION_DEV_URL;
  if (dev) win.loadURL(dev); else win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function setRinging(on) {
  if (!win || ringing === on) return;
  ringing = on;
  if (on) {
    showWindow();
    win.setAlwaysOnTop(true, "screen-saver");   // above full-screen billing software
    win.flashFrame(true);
  } else {
    win.setAlwaysOnTop(false);
    win.flashFrame(false);
  }
}

app.whenReady().then(() => {
  powerSaveBlocker.start("prevent-app-suspension");
  if (process.platform === "win32") app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
  createWindow();
  if (process.argv.includes("--hidden")) win.hide();

  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "..", "assets", "tray.png")));
  tray.setToolTip("SehatWaadi Companion");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open", click: showWindow },
    { type: "separator" },
    { label: "Quit (stops receiving orders)", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", showWindow);

  ipcMain.on("ring", (_e, on) => setRinging(Boolean(on)));
  ipcMain.handle("app-info", () => ({ version: app.getVersion(), autostart: process.platform === "win32" ? app.getLoginItemSettings().openAtLogin : false }));
  ipcMain.handle("set-autostart", (_e, on) => { if (process.platform === "win32") app.setLoginItemSettings({ openAtLogin: Boolean(on), args: ["--hidden"] }); return Boolean(on); });
});

app.on("second-instance", showWindow);
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { /* stay alive in the tray */ });
