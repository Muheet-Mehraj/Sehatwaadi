SehatWaadi customer app: product detail page, strict substitutes, map pin, one-order-at-a-time lock
1) Copy everything under src/ into your project's src/ (same paths; files that exist in your project are REPLACED, the rest are new).
2) Install the map library:   npm i leaflet
3) Optional build settings (.env):
     VITE_HUB_URL=https://your-hub.example.com
     VITE_ORDER_LOCK_MODE=checkout      (default is "full": the customer is held on the tracking screen while an order is in progress)
     VITE_PROMO_TEXT=FLAT 25% off on first order   (the green promo strip shows ONLY if you set this; set it only for a real offer)
     VITE_MAP_TILE_URL=<your tile provider>        (the free OpenStreetMap server is for light use only)
4) npm run build   then   npx cap sync android
Not changed (keep yours): contexts Auth/AuthUI/Cart/Location, utils/helpers.js and native.js, hooks/useBackHandler.js,
  components/checkout/AddressSelector.jsx and PrescriptionUpload.jsx, components/auth/HeaderActions.jsx, assets/global.css.
Hub: redeploy deliveryRoutes.js, re-run  node apply-delivery-patch.js server.js  (it now also guards POST /api/orders/create),
  then run sql/catalog_verified_seed.sql in Neon AFTER the medicines exist in global_medicines.
tests/ are reference tests (vitest + @testing-library/react + jsdom, Capacitor plugins and leaflet stubbed).
