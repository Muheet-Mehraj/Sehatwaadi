# Push notifications (FCM) for the rider app

What it does: the moment an order is offered to a rider who is ONLINE, the phone gets a loud, high-priority notification, even with the
app closed or the screen off. Tapping it opens the app straight onto the offer (the 15 s countdown comes from the server, so a late tap
simply shows "expired"). The push carries only the pharmacy name, earnings and distance, never customer details.

## One-time setup (about 15 minutes)
1. Firebase console -> create a project (or use one) -> **Add app -> Android**, package name **com.sehatwaadi.rider**.
2. Download **google-services.json** and put it at `rider-app/android/app/google-services.json`. (Without it the app still builds, push just stays off.)
3. Firebase console -> Project settings -> Service accounts -> **Generate new private key**. On Render (the Hub) add the env var
   `FIREBASE_SERVICE_ACCOUNT_JSON` = the whole JSON (or its base64). Never put this file in the app or in git.
4. Supabase SQL editor: run `supabase/migrations/20261022000100_push_notifications.sql`.
5. Hub: copy `routes/pushWorker.js`, use the new `server.js` (3 added lines), `npm i firebase-admin`, redeploy.
6. Rider app: `npm install && npm run android:sync`, bump `APP_VERSION` and Android `versionCode`, build and install.

## Check it works
- Hub log shows `[PUSH] Firebase ready for project ...` on start.
- Rider signs in on the phone -> a row appears in `push_devices`.
- Set `dispatch_mode = 'OFFER'`, put the rider ONLINE, close the app, create an order: a notification arrives within ~2 s.
- `select kind, sent_at, last_error from push_outbox order by id desc limit 10;` shows what was sent or why not
  (`no_device` = that rider has no registered phone, `offer_no_longer_live` = it ended before the Hub got to it).

## Things to know
- **Online + app closed:** the "you're online" foreground service keeps sending location, so the rider stays eligible. If Android
  kills the app completely (swipe from recents on some brands, or battery saver), location stops, the rider turns stale after
  90 s (`rider_fresh_seconds`) and is no longer offered orders. Tell riders to allow **Unrestricted battery** for the app
  (Settings -> Apps -> SehatWaadi Partner -> Battery). Xiaomi/Oppo/Vivo/Realme also need "Autostart" on.
- A phone that was **force-stopped** from Settings receives nothing until the app is opened once (an Android rule).
- AUTO mode: assigned orders also push ("New order assigned").
- Roll back: `PUSH_DISABLED=1` on the Hub stops sending; `rollback/20261022000100_push_notifications_down.sql` removes the tables.
