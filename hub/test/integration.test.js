// The whole Hub side together, against REAL Postgres: the merged delivery module (catalog + offer dispatch), catalog photos and the chemist payout
// flow, mounted exactly as apply-hub-additions.js mounts them. Skipped unless TEST_DATABASE_URL is set (the repo layout provides database/ and hub/).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const URL_ = process.env.TEST_DATABASE_URL;
const root = path.join(__dirname, '..', '..'); // repo root
const have = fs.existsSync(path.join(root, 'hub', 'hub', 'delivery', 'deliveryRoutes.js')) && fs.existsSync(path.join(root, 'database', 'supabase', 'tests', '01_hub_tables.sql'));
const skip = (!URL_ && 'set TEST_DATABASE_URL to run the integration test') || (!have && 'database/ folder not found');

test('merged Hub: catalog + photos + payouts together', { skip }, async (t) => {
  const { Pool } = require('pg');
  const express = require('express');
  const { createDeliveryModule } = require(path.join(root, 'hub', 'hub', 'delivery', 'deliveryRoutes.js'));
  const { createCatalogImageModule } = require('../hub/routes/catalogImageRoutes');
  const { createPayoutModule } = require('../hub/routes/payoutRoutes');
  const { createKycModule } = require('../hub/routes/kycRoutes');
  const read = (f) => fs.readFileSync(f, 'utf8');
  const admin = new Pool({ connectionString: URL_ });
  const mk = async (name) => { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${name}`); const u = new URL(URL_); u.pathname = '/' + name; return new Pool({ connectionString: u.toString() }); };
  const delivery = await mk('sw_int_delivery'), hub = await mk('sw_int_hub');
  const sup = path.join(root, 'database', 'supabase');
  const run = async (pool, file) => { const c = await pool.connect(); try { await c.query('SET search_path TO "$user", public, extensions'); await c.query(read(file)); } finally { c.release(); } };
  const migs = fs.readdirSync(path.join(sup, 'migrations')).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(sup, 'migrations', f));
  for (const f of [path.join(sup, 'tests/00_supabase_stubs.sql'), path.join(sup, 'tests/01_hub_tables.sql'), ...migs]) await run(delivery, f);
  await hub.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await hub.query(`CREATE TABLE orders (id uuid primary key default gen_random_uuid(), customer_lat double precision, customer_lng double precision, items jsonb, status text,
    current_pharmacy_id uuid, rx_status text, payment_mode text, subtotal numeric, customer_id uuid, contact_name text, contact_phone text, delivery_address text, delivery_landmark text,
    created_at timestamptz default now(), updated_at timestamptz default now())`);
  await hub.query(`CREATE TABLE global_medicines (id uuid primary key default gen_random_uuid(), name text not null, price numeric not null default 0, schedule_class text)`);
  await hub.query(read(path.join(__dirname, '..', 'neon', '05_catalog_images.sql')));
  const bolax = (await hub.query(`INSERT INTO global_medicines (name, price) VALUES ('Bolax Tablet 10', 6.24) RETURNING id`)).rows[0].id;

  const P1 = crypto.randomUUID(), KEY = 'key-one-secret', ADMIN = 'admin-token-for-tests-0123456789';
  await delivery.query(`INSERT INTO pharmacies (id, name, api_key, lat, lng, address, phone) VALUES ($1,'Nowshera Pharmacy',$2,34.0805,74.7905,'Nowshera, Srinagar','+911112223334')`, [P1, KEY]);
  const authenticatePharmacy = async (id, key) => ({ valid: id === P1 && key === KEY, resolvedId: id });
  const quiet = { log() {}, warn() {}, error() {} };
  const emitted = [], io = { to: (room) => ({ emit: (ev, p) => emitted.push({ room, ev, p }) }) };
  const dmod = createDeliveryModule({ hubPool: hub, deliveryPool: delivery, io, authenticatePharmacy, optionalCustomer: (req, _r, next) => next(), log: quiet, env: { DELIVERY_ADMIN_TOKEN: ADMIN } });
  const images = createCatalogImageModule({ pool: hub, authenticatePharmacy, env: { PUBLIC_HUB_URL: 'https://hub.example.com' }, log: quiet });
  const payouts = createPayoutModule({ dpool: delivery, authenticatePharmacy, io, env: { DELIVERY_ADMIN_TOKEN: ADMIN }, log: quiet });
  const kycMod = createKycModule({ dpool: delivery, env: { DELIVERY_ADMIN_TOKEN: ADMIN }, log: quiet });
  const app = express(); app.use(express.json());
  app.use('/api/admin/kyc', kycMod.adminRouter);
  app.use('/api/delivery', dmod.router); app.use('/api/catalog', dmod.catalogRouter);
  app.use('/api/catalog/image', images.publicRouter); app.use('/api/companion/catalog-images', images.companionRouter);
  app.use('/api/companion/payouts', payouts.chemistRouter); app.use('/api/admin/payouts', payouts.adminRouter); app.use('/admin/desk', payouts.deskRouter);
  const server = http.createServer(app); await new Promise((r) => server.listen(0, r));
  const B = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await delivery.end(); await hub.end(); await admin.query('DROP DATABASE IF EXISTS sw_int_delivery WITH (FORCE)'); await admin.query('DROP DATABASE IF EXISTS sw_int_hub WITH (FORCE)'); await admin.end(); });
  const CH = { 'x-pharmacy-id': P1, 'x-pharmacy-key': KEY, 'content-type': 'application/json' }, AD = { 'x-admin-token': ADMIN, 'content-type': 'application/json' };
  const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });

  await t.test('catalog: the customer app endpoints answer, and a chemist photo flows through to them', async () => {
    const home = await j(await fetch(`${B}/api/catalog/home`));
    assert.strictEqual(home.status, 200);
    const before = await j(await fetch(`${B}/api/catalog/medicine/${bolax}`)); assert.strictEqual(before.status, 200);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 9)]);
    const up = await j(await fetch(`${B}/api/companion/catalog-images/${bolax}`, { method: 'PUT', headers: { ...CH, 'content-type': 'image/jpeg' }, body: jpeg }));
    assert.strictEqual(up.status, 200); assert.match(up.body.imageUrl, /^https:\/\/hub\.example\.com\/api\/catalog\/image\//);
    const after = await j(await fetch(`${B}/api/catalog/medicine/${bolax}`));
    assert.ok(JSON.stringify(after.body).includes(up.body.imageUrl), 'the customer app now receives the photo link');
    const img = await fetch(`${B}${new URL(up.body.imageUrl).pathname}`); assert.strictEqual(img.status, 200); assert.strictEqual(img.headers.get('content-type'), 'image/jpeg');
  });

  await t.test('rider cash deposit refuses a made-up reference through the real database function', async () => {
    const rid = crypto.randomUUID(); await delivery.query(`INSERT INTO auth.users (id, phone) VALUES ($1,'919811112222')`, [rid]);
    await delivery.query(`INSERT INTO riders (id, full_name, phone, vehicle_type, verification_status, cash_in_hand) VALUES ($1,'Test Rider','919811112222','SCOOTER','VERIFIED',500)`, [rid]);
    const c = await delivery.connect();
    try {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE authenticated'); await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: rid, role: 'authenticated' })]);
      const bad = (await c.query(`SELECT public.settle_rider_cash(100, 'UPIREF000001') AS r`)).rows[0].r;
      const fake = (await c.query(`SELECT public.settle_rider_cash(100, '123456789012') AS r`)).rows[0].r;
      const good = (await c.query(`SELECT public.settle_rider_cash(100, '482910557301') AS r`)).rows[0].r;
      await c.query('ROLLBACK');
      assert.strictEqual(bad.error, 'invalid_reference'); assert.strictEqual(fake.error, 'invalid_reference'); assert.strictEqual(good.ok, true);
    } finally { c.release(); }
  });

  await t.test('operator lists a rider deposit and the desk page is reachable', async () => {
    const list = await j(await fetch(`${B}/api/delivery/admin/settlements`, { headers: AD })); assert.strictEqual(list.status, 200); assert.ok(Array.isArray(list.body.settlements));
    assert.strictEqual((await fetch(`${B}/api/delivery/admin/settlements`)).status, 403);
    const desk = await fetch(`${B}/admin/desk`); assert.strictEqual(desk.status, 200); assert.match(await desk.text(), /operator desk/);
  });

  await t.test('chemist payout end to end over HTTP: claim -> pay -> confirm -> zero', async () => {
    const mkDelivered = async (net) => {
      const oid = crypto.randomUUID();
      await delivery.query(`INSERT INTO orders (id, customer_lat, customer_lng, items, status, current_pharmacy_id, rx_status, payment_mode, subtotal, contact_name, contact_phone, delivery_address, delivery_landmark)
        VALUES ($1,34.09,74.80,'[{"name":"X","quantity":1}]','ACCEPTED',$2,'VERIFIED','CASH',760,'Aaliya','+919000011111','Flat 1','Opp. Park')`, [oid, P1]);
      const r = (await delivery.query(`SELECT public.dispatch_order($1::uuid) AS r`, [oid])).rows[0].r;
      await delivery.query(`UPDATE deliveries SET status='DELIVERED', rider_id=(SELECT id FROM riders LIMIT 1), pharmacy_net_amount=$2, delivered_at=now() WHERE id=$1`, [r.deliveryId, net]);
    };
    await mkDelivered(684); await mkDelivered(300.5);
    assert.strictEqual((await j(await fetch(`${B}/api/companion/payouts`, { headers: { ...CH, 'x-pharmacy-key': 'wrong' } }))).status, 403);
    const s0 = await j(await fetch(`${B}/api/companion/payouts`, { headers: CH })); assert.strictEqual(Number(s0.body.unsettled.amount), 984.5); assert.strictEqual(s0.body.unsettled.orders, 2);
    const rq = await j(await fetch(`${B}/api/companion/payouts/request`, { method: 'POST', headers: CH, body: '{}' })); assert.strictEqual(rq.status, 200);
    assert.strictEqual((await j(await fetch(`${B}/api/companion/payouts/request`, { method: 'POST', headers: CH, body: '{}' }))).status, 409);
    const id = rq.body.settlementId;
    assert.strictEqual((await j(await fetch(`${B}/api/companion/payouts/${id}/confirm`, { method: 'POST', headers: CH, body: '{}' }))).status, 409, 'cannot confirm before it is paid');
    assert.strictEqual((await j(await fetch(`${B}/api/admin/payouts/${id}/pay`, { method: 'POST', headers: AD, body: JSON.stringify({ ref: '123456789012' }) }))).status, 400, 'made-up reference refused');
    assert.strictEqual((await j(await fetch(`${B}/api/admin/payouts`, { headers: CH }))).status, 403, 'a chemist key is not an operator token');
    const list = await j(await fetch(`${B}/api/admin/payouts`, { headers: AD })); assert.strictEqual(list.body.settlements[0].pharmacyName, 'Nowshera Pharmacy');
    assert.strictEqual((await j(await fetch(`${B}/api/admin/payouts/${id}/pay`, { method: 'POST', headers: AD, body: JSON.stringify({ ref: '507291847362' }) }))).status, 200);
    await new Promise((r) => setTimeout(r, 30)); assert.ok(emitted.some((e) => e.ev === 'payout_updated' && e.room === `pharmacy_${P1}`), 'the chemist\'s companion is told');
    const paid = await j(await fetch(`${B}/api/companion/payouts`, { headers: CH })); assert.strictEqual(paid.body.open.status, 'PAID'); assert.strictEqual(paid.body.open.paidRef, '507291847362');
    assert.strictEqual((await j(await fetch(`${B}/api/companion/payouts/${id}/confirm`, { method: 'POST', headers: CH, body: '{}' }))).status, 200);
    const done = await j(await fetch(`${B}/api/companion/payouts`, { headers: CH }));
    assert.strictEqual(done.body.open, null); assert.strictEqual(Number(done.body.unsettled.amount), 0); assert.strictEqual(done.body.history[0].status, 'CONFIRMED'); assert.strictEqual(Number(done.body.history[0].amount), 984.5);
  });

  await t.test('rider KYC: operator sees the pictures, rejects, approves; the old shortcut is refused; the desk page can show pictures', async () => {
    const uid = crypto.randomUUID(); await delivery.query(`INSERT INTO auth.users (id, phone) VALUES ($1,'919833300001')`, [uid]);
    await delivery.query(`INSERT INTO riders (id, full_name, phone, vehicle_type, vehicle_number) VALUES ($1,'Kamran Rider','919833300001','SCOOTER','JK01AB1234')`, [uid]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 5)]);
    const rider = async (fn, ...a) => { const c = await delivery.connect(); try { await c.query('BEGIN'); await c.query('SET LOCAL ROLE authenticated'); await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); const r = (await c.query(`SELECT public.${fn} AS r`, a)).rows[0].r; await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } };
    for (const k of ['SELFIE', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'PAN', 'DL_FRONT']) assert.strictEqual((await rider(`kyc_upload_doc('${k}','image/jpeg','${jpeg.toString('base64')}')`)).ok, true);
    const s = await rider("kyc_submit('1995-04-12','4821','ABCPE5555F','JK01 2019 5550001','2032-01-31')"); assert.strictEqual(s.ok, true, JSON.stringify(s));
    const noTok = await fetch(`${B}/api/admin/kyc`); assert.strictEqual(noTok.status, 403);
    const q = await j(await fetch(`${B}/api/admin/kyc`, { headers: AD })); assert.ok(q.body.items.some((x) => x.riderId === uid));
    const doc = await fetch(`${B}/api/admin/kyc/${uid}/doc/PAN`, { headers: AD }); assert.strictEqual(doc.status, 200); assert.strictEqual(doc.headers.get('content-type'), 'image/jpeg');
    assert.deepStrictEqual(Buffer.from(await doc.arrayBuffer()), jpeg, 'the exact bytes the rider uploaded');
    const shortcut = await j(await fetch(`${B}/api/delivery/admin/riders/${uid}/verification`, { method: 'POST', headers: AD, body: JSON.stringify({ status: 'VERIFIED' }) }));
    assert.strictEqual(shortcut.status, 409); assert.strictEqual(shortcut.body.error, 'kyc_required');
    const rej = await j(await fetch(`${B}/api/admin/kyc/${uid}/decide`, { method: 'POST', headers: AD, body: JSON.stringify({ decision: 'REJECT', retake: ['PAN'], reason: 'PAN is blurry' }) })); assert.strictEqual(rej.status, 200);
    assert.strictEqual((await j(await fetch(`${B}/api/admin/kyc/${uid}/decide`, { method: 'POST', headers: AD, body: JSON.stringify({ decision: 'APPROVE' }) }))).status, 409, 'not submitted any more');
    assert.strictEqual((await rider("kyc_upload_doc('PAN','image/jpeg','" + jpeg.toString('base64') + "')")).ok, true);
    assert.strictEqual((await rider("kyc_submit('1995-04-12','4821','ABCPE5555F','JK01 2019 5550001','2032-01-31')")).ok, true);
    assert.strictEqual((await j(await fetch(`${B}/api/admin/kyc/${uid}/decide`, { method: 'POST', headers: AD, body: JSON.stringify({ decision: 'APPROVE' }) }))).status, 200);
    assert.strictEqual((await delivery.query(`SELECT verification_status FROM riders WHERE id=$1`, [uid])).rows[0].verification_status, 'VERIFIED');
    const sus = await j(await fetch(`${B}/api/admin/kyc/${uid}/suspend`, { method: 'POST', headers: AD, body: JSON.stringify({ reason: 'licence expired' }) })); assert.strictEqual(sus.status, 200);
    assert.strictEqual((await j(await fetch(`${B}/api/admin/kyc/${uid}/reinstate`, { method: 'POST', headers: AD, body: '{}' }))).status, 200);
    const desk = await fetch(`${B}/admin/desk`); assert.match(desk.headers.get('content-security-policy'), /img-src blob:/); assert.match(await desk.text(), /Rider documents to review/);
  });

  await t.test('the chemist delivery list still loads with the offer-dispatch columns (merged routes)', async () => {
    const r = await j(await fetch(`${B}/api/delivery/pharmacy/${P1}`, { headers: CH })); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.ok, true);
  });
});
