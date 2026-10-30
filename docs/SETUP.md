# Setup

1. **Supabase**: create a project, run `database/supabase/migrations/*.sql` in order. For local login testing add Supabase *test phone numbers* (Auth settings) so no SMS provider is needed.
2. **Neon**: run `hub/neon/04_companion.sql` and `hub/neon/05_catalog_images.sql`.
3. **Hub**: `cd hub && npm i`. Integrate into your Express `server.js` with `node apply-delivery-patch.js server.js` and `node apply-hub-additions.js server.js` (idempotent). See `hub/INTEGRATION.md` for every environment variable.
4. **Partner app**: copy `apps/partner/.env.example` to `.env`, set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SETTLEMENT_UPI_ID`; `npm run dev`. For Android: `npm run android:sync` (see `apps/partner/SETUP.md`, `FCM_SETUP.md`).
5. **Companion**: copy `.env.example`, `npm run dev`.
6. **Push (optional)**: create a Firebase project, add the Android app `com.sehatwaadi.rider`, place `google-services.json` in `apps/partner/android/app/` (git-ignored) and set `FIREBASE_SERVICE_ACCOUNT_JSON` on the Hub.
