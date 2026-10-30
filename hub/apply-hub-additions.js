// Adds rider push (FCM), catalog photos, chemist payouts and rider KYC review to YOUR server.js without touching anything else. Safe to run twice.
//   node apply-hub-additions.js server.js
// Run `node apply-delivery-patch.js server.js` first (it mounts /api/delivery and /api/catalog); this refuses to guess if that is missing.
// Nothing is written unless every anchor is found.
const fs = require('fs');
const file = process.argv[2] || 'server.js';
let src = fs.readFileSync(file, 'utf8');
const eol = src.includes('\r\n') ? '\r\n' : '\n';
const L = (t) => t.split('\n').join(eol);

const anchor = 'deliveryModule.startWorker();';
const needs = ['createDeliveryModule', "app.use('/api/delivery', deliveryModule.router);", "deliveryModule.catalogRouter"];
for (const n of needs) if (!src.includes(n)) { console.error(`Missing "${n}" in ${file}. Run: node apply-delivery-patch.js ${file}  and then run this again. No changes made.`); process.exit(1); }
if (!src.includes('authenticatePharmacy') || !/\bconst pool\b|\blet pool\b/.test(src)) { console.error('Could not find `pool` / `authenticatePharmacy` in server.js. No changes made.'); process.exit(1); }
const i = src.indexOf(anchor);
if (i < 0 || src.indexOf(anchor, i + 1) >= 0) { console.error(`Could not find a single "${anchor}" line. No changes made.`); process.exit(1); }

const blocks = [
  ['createPushWorker', `
// Rider push notifications (FCM). Needs delivery migration 20261022000100 and FIREBASE_SERVICE_ACCOUNT_JSON; does nothing if either is missing.
const { createPushWorker } = require('./routes/pushWorker');
createPushWorker({ deliveryPool }).start();
`],
  ['createCatalogImageModule', `
// Catalog photos: public image URL for the customer app + chemist upload/list/remove in the companion. Needs neon/05_catalog_images.sql.
// Set PUBLIC_HUB_URL (e.g. https://your-hub.example.com) so stored photo links are always the public https address.
const { createCatalogImageModule } = require('./routes/catalogImageRoutes');
const catalogImages = createCatalogImageModule({ pool, authenticatePharmacy });
app.use('/api/catalog/image', catalogImages.publicRouter);
app.use('/api/companion/catalog-images', catalogImages.companionRouter);
`],
  ['createPayoutModule', `
// Chemist payouts (claim -> operator pays with a valid UTR -> chemist confirms) + the operator desk page at /admin/desk.
// Needs delivery migration 20261024000000_settlements.sql and DELIVERY_ADMIN_TOKEN (24+ characters) for the operator side.
const { createPayoutModule } = require('./routes/payoutRoutes');
const payouts = createPayoutModule({ dpool: deliveryPool || pool, authenticatePharmacy, io });
app.use('/api/companion/payouts', payouts.chemistRouter);
app.use('/api/admin/payouts', payouts.adminRouter);
app.use('/admin/desk', payouts.deskRouter);
`],
  ['createKycModule', `
// Rider KYC review (operator side): view documents, approve (rider becomes verified) / reject / suspend. Needs delivery migration 20261025000000_rider_kyc.sql.
const { createKycModule } = require('./routes/kycRoutes');
const riderKyc = createKycModule({ dpool: deliveryPool || pool });
app.use('/api/admin/kyc', riderKyc.adminRouter);
`],
];
let add = '', n = 0;
for (const [marker, code] of blocks) if (!src.includes(marker)) { add += L(code); n++; }
if (!n) { console.log('Already patched. Nothing to do.'); process.exit(0); }
src = src.slice(0, i + anchor.length) + eol + add.replace(/\s+$/, '') + eol + src.slice(i + anchor.length);
fs.writeFileSync(file, src);
console.log(`Patched ${file} (${n} block(s) added). Next: copy routes/pushWorker.js, catalogImageRoutes.js, payoutRoutes.js, kycRoutes.js, operatorDesk.js into your Hub's routes/ folder and run npm i firebase-admin.`);
