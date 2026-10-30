# SehatWaadi Partner (rider app): Android app + wallet (v0.4.0)

## Build the Android app (Windows PowerShell, same toolchain as the customer app: Node 22, JDK 21, SDK Platform 36)
```
npm install
copy .env.example .env        # then fill in VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_SETTLEMENT_UPI_ID
npm run android:sync          # builds the web app, syncs it into android/, patches the manifest
npm run android:open          # opens Android Studio; press Run (or: npm run android:run)
```
The `android/` project is already generated. To build an installable file: Android Studio > Build > Build APK(s).
Use a real phone for the first test (GPS, camera, UPI apps and the background service don't behave on an emulator).

## What the Android app adds over the web version
- Location keeps flowing with the screen off or the app in the background (foreground service + "You're online" notification), so the rider stays online on the server.
- Network calls to Supabase go through native HTTP, because Android throttles WebView requests after ~5 minutes in the background.
- New-order alert is a native notification (rings with the app closed to the background), plus vibration/haptics.
- Back button closes sheets/wallet first, then sends the app to the background (never kills it mid-delivery).
- Screen stays awake only during a delivery.

## Going online -> order assigned
On "Go online" (and when the app opens while already online) the app sends one quick position straight away. The server hands any waiting order to the nearest online rider as soon as it sees a fresh position (see test/e2e.mjs section 11).

## Cash & UPI settlement
- Wallet screen: cash in hand with a limit meter (warn at 70%, critical at 90%, COD pauses at the limit), earnings, full history.
- Deposit: pick an amount (quick chips), pay it in the rider's UPI app (pre-filled), enter the UPI reference. Shows "awaiting verification" until the operator confirms in the Hub admin.
- Drop-off: for cash orders the rider must tick "I have collected ₹X" before Complete is enabled.

## Not done here (needs your server side / accounts)
- Push notification when the app is fully closed or killed: needs a Firebase project (google-services.json) and the server sending the push.
- Auto-verification of UPI deposits (today an operator confirms each one).
- Idle GPS uses the foreground service continuously; if battery is a concern we can add a slower idle mode.
