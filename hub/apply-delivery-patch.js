// Adds the rider-delivery hook + route mount to YOUR server.js without touching anything else. Safe to run twice.
const fs = require('fs');
const file = process.argv[2] || 'server.js';
let src = fs.readFileSync(file, 'utf8');
const eol = src.includes('\r\n') ? '\r\n' : '\n';
const L = (t) => t.split('\n').join(eol);
let changed = 0;

// 1) accepted order -> dispatch to a rider (placed right before the ACCEPTED response, after your commission block)
const hookAnchor = "            return res.json({ status: 'ACCEPTED', pharmacyId: resolvedId });";
const hook = L(`            // Delivery: hand the accepted order to the nearest rider (idempotent; never blocks the acceptance).
            deliveryModule.dispatchForOrder(orderId, resolvedId).then((r) => { if (!r || r.ok === false) console.warn('[DELIVERY] dispatch:', r && r.error); }).catch((e) => console.warn('[DELIVERY] dispatch failed:', e.message));
`);
if (!src.includes('deliveryModule.dispatchForOrder')) {
  const i = src.indexOf(hookAnchor);
  if (i < 0 || src.indexOf(hookAnchor, i + 1) >= 0) { console.error('Could not find a single accept-order response line. No changes made.'); process.exit(1); }
  src = src.slice(0, i) + hook + src.slice(i); changed++;
}

// 2) mount the delivery routes + worker, just before the server starts listening
const mountAnchor = 'const PORT = process.env.PORT || 8080;';
const mount = L(`// ========================================================
// DELIVERY (riders): bridges accepted orders into the delivery database and exposes pharmacy/customer/admin endpoints.
// DELIVERY_DATABASE_URL = the Postgres holding the rider migrations (Supabase session-pooler string). Unset = same database as the Hub.
// ========================================================
const { createDeliveryModule } = require('./delivery/deliveryRoutes');
const { Pool: DeliveryPool } = require('pg');
const deliveryPool = process.env.DELIVERY_DATABASE_URL
    ? new DeliveryPool({ connectionString: process.env.DELIVERY_DATABASE_URL, ssl: process.env.DELIVERY_DB_SSL === '0' ? false : { rejectUnauthorized: false }, keepAlive: true, max: 5 })
    : null;
if (deliveryPool) deliveryPool.on('error', (err) => console.warn('[DELIVERY POOL]', err.message));
const deliveryModule = createDeliveryModule({ hubPool: pool, deliveryPool, authenticatePharmacy, optionalCustomer, io });
app.use('/api/delivery', deliveryModule.router);
deliveryModule.startWorker();

`);
if (!src.includes('createDeliveryModule')) {
  const j = src.indexOf(mountAnchor);
  if (j < 0) { console.error('Could not find the PORT line. No changes made.'); process.exit(1); }
  src = src.slice(0, j) + mount + src.slice(j); changed++;
}
// 3) public catalog (home-screen shelves) - added to servers patched by an earlier version of this script too
if (!src.includes('deliveryModule.catalogRouter')) {
  const m = "app.use('/api/delivery', deliveryModule.router);";
  const k = src.indexOf(m);
  if (k < 0) { console.error('Could not find the delivery mount line. No changes made.'); process.exit(1); }
  src = src.slice(0, k + m.length) + eol + "app.use('/api/catalog', deliveryModule.catalogRouter);" + src.slice(k + m.length); changed++;
}
// 4) one active order per customer: guard in front of the create-order handler
if (!src.includes('deliveryModule.activeOrderGuard')) {
  const route = "app.post('/api/orders/create', createOrderLimiter, optionalCustomer, async (req, res) => {";
  const r = src.indexOf(route);
  if (r < 0 || src.indexOf(route, r + 1) >= 0) { console.error('Could not find the create-order route line. No changes made.'); process.exit(1); }
  src = src.slice(0, r) + "app.post('/api/orders/create', createOrderLimiter, optionalCustomer, (req, res, next) => deliveryModule.activeOrderGuard(req, res, next), async (req, res) => {" + src.slice(r + route.length); changed++;
}
fs.writeFileSync(file, src);
console.log(changed ? `Patched ${file} (${changed} block(s) added).` : 'Already patched. Nothing to do.');
