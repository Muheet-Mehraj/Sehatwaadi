// Run after `npx cap add android` (already done in this zip; safe to re-run). Adds what the Capacitor template doesn't:
//   - CAMERA + VIBRATE permissions (delivery photo, QR scan, haptics)
//   - push: FCM default channel + POST_NOTIFICATIONS, and a warning if google-services.json is missing
//   - allowBackup=false (the sign-in session must not be copied into cloud/device backups)
// The location, foreground-service and notification permissions come from the plugins' own manifests (merged at build time).
import fs from "node:fs";
import path from "node:path";
const file = path.join(process.cwd(), "android", "app", "src", "main", "AndroidManifest.xml");
if (!fs.existsSync(file)) { console.error("android/ not found. Run: npx cap add android"); process.exit(1); }
let x = fs.readFileSync(file, "utf8"); const before = x;
const perms = ["android.permission.CAMERA", "android.permission.VIBRATE"];
for (const p of perms) if (!x.includes(`"${p}"`)) x = x.replace("</manifest>", `    <uses-permission android:name="${p}" />\n</manifest>`);
if (!x.includes("android.hardware.camera")) x = x.replace("</manifest>", `    <uses-feature android:name="android.hardware.camera" android:required="false" />\n</manifest>`);
// Push (FCM): a push that arrives without a channel id falls into the loud "offers" channel (the app also creates it on start);
// Android 13+ needs the notification permission declared.
if (!x.includes("default_notification_channel_id")) x = x.replace("</application>", `        <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="offers" />\n    </application>`);
if (!x.includes("android.permission.POST_NOTIFICATIONS")) x = x.replace("</manifest>", `    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n</manifest>`);
if (!fs.existsSync(path.join(process.cwd(), "android", "app", "google-services.json"))) console.warn("WARNING: android/app/google-services.json is missing. The app builds, but push notifications will not work until you add it (see FCM_SETUP.md).");
x = x.replace('android:allowBackup="true"', 'android:allowBackup="false"');
if (x !== before) { fs.writeFileSync(file, x); console.log("AndroidManifest.xml updated"); } else console.log("AndroidManifest.xml already up to date");

// The name under the app icon on the phone and in Settings -> Apps (the package / appId stays com.sehatwaadi.rider so existing installs and Firebase keep working).
const APP_NAME = "SehatWaadi Partner";
const strings = path.join(process.cwd(), "android", "app", "src", "main", "res", "values", "strings.xml");
if (fs.existsSync(strings)) {
  const sx = fs.readFileSync(strings, "utf8");
  const sy = sx.replace(/(<string name="app_name">)[^<]*(<\/string>)/, `$1${APP_NAME}$2`).replace(/(<string name="title_activity_main">)[^<]*(<\/string>)/, `$1${APP_NAME}$2`);
  if (sy !== sx) { fs.writeFileSync(strings, sy); console.log(`App name set to "${APP_NAME}"`); } else console.log("App name already up to date");
}
