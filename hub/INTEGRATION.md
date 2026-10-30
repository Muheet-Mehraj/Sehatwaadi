# Hub patch for the companion app

Files
- `neon/04_companion.sql`        run once on the Hub database (the one with `orders` and `network_pharmacies`). Safe to re-run.
- `hub/routes/companionRoutes.js` new. Copy to your Hub's `routes/` folder.
- `hub/server.js`                 your server.js with the changes below already applied. `server.patch` shows exactly what changed.
- `test/`                         `npm install && npm test` (15 tests, no database needed).

## What changed in server.js
1. `findCandidates` has a `MATCH_MODE`. Default `learned`: online + fresh heartbeat + nearby + no active `pharmacy_item_blocks` row for any cart item. Set `MATCH_MODE=inventory` to get the old stock-row behaviour back.
2. `sendToNextCandidate` now saves `offer_deadline` before notifying the pharmacy, and the timer moved into `armOfferTimer()` so the companion can re-arm it for the longer picking window. The timeout also emits `order_withdrawn` to the pharmacy.
3. `pending-orders` and `register_spoke` read the saved deadline instead of the in-memory one, so a restart does not reset countdowns.
4. Companion routes are mounted at `/api/companion` and a 10-second sweeper advances orders whose saved deadline passed (fixes orders stranded by a restart).

## The flow
OFFERED (rings, 60 s, `CASCADE_TIMEOUT_SECONDS`) -> chemist opens it: `start-picking` (300 s, `PICK_SECONDS`) -> ticks every line (+2 min once) -> `dispatch`, which is the moment the order becomes ACCEPTED, the commission rate is frozen (`accrue_order_commission`) and the rider is assigned (`dispatchForOrder`).
The order stays `SENT_TO_PHARMACY` while picking, so the customer app and the existing cascade need no new status. An invalid prescription ends the order as `REJECTED`; "out of stock" and "busy" pass it on.

## Settings (all optional)
`PICK_SECONDS=300`  `PICK_EXTEND_SECONDS=120`  `BLOCK_HOURS=24`  `SWEEP_MS=10000`  `MATCH_MODE=learned|inventory`

## Before you rely on it
- Rotate the pharmacy key that appeared in `respond.json`.
- Nothing here was run against a real Postgres. Check on a copy of the database: the migration, `findCandidates`, and that `dispatch_order` accepts the four arguments `deliveryRoutes.js` passes.
- Old POS spokes that still call `/respond` keep working (accept there still dispatches immediately).
- Settlements shows what the `deliveries` table holds (value, commission, net). It has no payout/UTR status because I have not seen a column for it.

---
# Added: rider push notifications (FCM) and catalog photos

New files
- `hub/routes/pushWorker.js`          sends rider pushes through Firebase. Does nothing unless `FIREBASE_SERVICE_ACCOUNT_JSON` is set.
- `hub/routes/catalogImageRoutes.js`  public image URL + chemist upload / list / remove.
- `neon/05_catalog_images.sql`        run once on the Hub (Neon) database. Adds `global_medicines.image_url` and `medicine_images`.
- `hub/server.js`                     two small blocks added (push worker after the delivery worker; catalog images before the companion mount).
- Also run on the DELIVERY database (Supabase): `20261022000100_push_notifications.sql` (in the delivery zip), then `npm i` in the Hub (adds `firebase-admin`).

New settings (Render)
`FIREBASE_SERVICE_ACCOUNT_JSON`  Firebase service-account key (raw JSON or base64)
`PUBLIC_HUB_URL`                 e.g. https://your-hub.example.com, the address stored in photo links
`PUSH_TICK_MS=1500`  `PUSH_DISABLED=1` (off switch)

Tests: `TEST_DATABASE_URL=postgres://... npm test` (35 tests; the photo tests use a real Postgres and are skipped without that variable).

Photos: the customer app needs no change. It already shows `image_url`, and the catalog endpoints already read that column when it exists.
Capacity: photos are kept in the database (about 30-60 KB each, hard cap 150 KB). 5,000 photos is roughly 250 MB, so watch Neon's free-tier size.
