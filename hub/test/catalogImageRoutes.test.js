// Runs the catalog-photo routes against a REAL Postgres (the SQL is part of what is being tested).
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres npm test      (skipped when it is not set)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { createCatalogImageModule } = require('../hub/routes/catalogImageRoutes');

const URL_ = process.env.TEST_DATABASE_URL;
const skip = !URL_ && 'set TEST_DATABASE_URL to run the catalog image tests';
const PH = '11111111-1111-4111-8111-111111111111';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 '), Buffer.alloc(300, 2)]);

test('catalog images', { skip }, async (t) => {
  const { Pool } = require('pg');
  const admin = new Pool({ connectionString: URL_ });
  await admin.query('DROP DATABASE IF EXISTS sw_img_test WITH (FORCE)'); await admin.query('CREATE DATABASE sw_img_test');
  const u = new URL(URL_); u.pathname = '/sw_img_test';
  const pool = new Pool({ connectionString: u.toString() });
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query('CREATE TABLE global_medicines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, price numeric)');
  const mig = fs.readFileSync(path.join(__dirname, '../neon/05_catalog_images.sql'), 'utf8');
  await pool.query(mig); await pool.query(mig);   // twice: safe to re-run
  const med = async (name) => (await pool.query('INSERT INTO global_medicines (name, price) VALUES ($1, 10) RETURNING id', [name])).rows[0].id;
  const A = await med('Bolax Tablet 10'), B = await med('Dolo 650 Tablet 15'), C = await med('100% Pure_Honey');

  const mod = createCatalogImageModule({ pool, env: { PUBLIC_HUB_URL: 'https://hub.example.com/' }, log: { log() {}, error() {}, warn() {} },
    authenticatePharmacy: async (id, key) => (id === PH && key === 'good' ? { valid: true, resolvedId: PH } : { valid: false, resolvedId: null }) });
  const app = express(); app.use('/api/catalog/image', mod.publicRouter); app.use('/api/companion/catalog-images', mod.companionRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  t.after(async () => { srv.close(); await pool.end(); await admin.query('DROP DATABASE IF EXISTS sw_img_test WITH (FORCE)'); await admin.end(); });
  const H = { 'x-pharmacy-id': PH, 'x-pharmacy-key': 'good' };
  const put = (id, body, h = H, type = 'image/webp') => fetch(`${base}/api/companion/catalog-images/${id}`, { method: 'PUT', headers: { ...h, 'content-type': type }, body });

  await t.test('chemist routes need the pharmacy key', async () => {
    assert.strictEqual((await fetch(`${base}/api/companion/catalog-images`)).status, 403);
    assert.strictEqual((await put(A, JPEG, { 'x-pharmacy-id': PH, 'x-pharmacy-key': 'bad' })).status, 403);
    assert.strictEqual((await pool.query('SELECT count(*)::int n FROM medicine_images')).rows[0].n, 0);
  });
  await t.test('upload stores the photo and points image_url at a public, versioned https link', async () => {
    const r = await put(A, JPEG, H, 'image/jpeg'); const j = await r.json();
    assert.strictEqual(r.status, 200); assert.match(j.imageUrl, new RegExp(`^https://hub\\.example\\.com/api/catalog/image/${A}\\?v=[0-9a-f]{10}$`));
    assert.strictEqual((await pool.query('SELECT image_url FROM global_medicines WHERE id=$1', [A])).rows[0].image_url, j.imageUrl);
    assert.strictEqual((await pool.query('SELECT uploaded_by FROM medicine_images WHERE medicine_id=$1', [A])).rows[0].uploaded_by, PH);
  });
  await t.test('the image is public, typed from its bytes, cached for a year, and answers 304 when unchanged', async () => {
    const r = await fetch(`${base}/api/catalog/image/${A}?v=x`);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get('content-type'), 'image/jpeg');
    assert.match(r.headers.get('cache-control'), /max-age=31536000, immutable/); assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(JPEG));
    const again = await fetch(`${base}/api/catalog/image/${A}`, { headers: { 'if-none-match': r.headers.get('etag') } });
    assert.strictEqual(again.status, 304);
  });
  await t.test('PNG and WebP are accepted; the header the client sends does not matter, the bytes do', async () => {
    assert.strictEqual((await put(B, PNG, H, 'application/octet-stream')).status, 200);
    assert.strictEqual((await fetch(`${base}/api/catalog/image/${B}`)).headers.get('content-type'), 'image/png');
    assert.strictEqual((await put(C, WEBP)).status, 200);
    assert.strictEqual((await fetch(`${base}/api/catalog/image/${C}`)).headers.get('content-type'), 'image/webp');
  });
  await t.test('replacing a photo changes the link (so phones refetch)', async () => {
    const before = (await pool.query('SELECT image_url FROM global_medicines WHERE id=$1', [B])).rows[0].image_url;
    const j = await (await put(B, Buffer.concat([JPEG, Buffer.from('x')]), H, 'image/jpeg')).json();
    assert.notStrictEqual(j.imageUrl, before); assert.strictEqual((await pool.query('SELECT count(*)::int n FROM medicine_images WHERE medicine_id=$1', [B])).rows[0].n, 1);
  });
  await t.test('rejects non-images, empty bodies, oversize photos, unknown medicines and bad ids', async () => {
    const fake = await put(A, Buffer.from('<html>not an image at all</html>'), H, 'image/jpeg'); assert.strictEqual(fake.status, 415);
    assert.strictEqual((await put(A, Buffer.alloc(0))).status, 400);
    const big = await put(A, Buffer.concat([JPEG, Buffer.alloc(160 * 1024)]), H, 'image/jpeg'); assert.strictEqual(big.status, 413); assert.strictEqual((await big.json()).error, 'image_too_large');
    assert.strictEqual((await put('99999999-9999-4999-8999-999999999999', JPEG, H, 'image/jpeg')).status, 404);
    assert.strictEqual((await put('not-a-uuid', JPEG)).status, 400);
    assert.strictEqual((await fetch(`${base}/api/catalog/image/not-a-uuid`)).status, 404);
    assert.strictEqual((await fetch(`${base}/api/catalog/image/99999999-9999-4999-8999-999999999999`)).status, 404);
  });
  await t.test('list: search, only-missing filter and progress counts (wildcards in the search are literal)', async () => {
    const D = await med('Paracip 500');
    const all = await (await fetch(`${base}/api/companion/catalog-images?missing=1`, { headers: H })).json();
    assert.deepStrictEqual(all.items.map((x) => x.name), ['Paracip 500']); assert.strictEqual(all.total, 4); assert.strictEqual(all.withImage, 3);
    const s1 = await (await fetch(`${base}/api/companion/catalog-images?q=dolo`, { headers: H })).json(); assert.deepStrictEqual(s1.items.map((x) => x.hasImage), [true]);
    const s2 = await (await fetch(`${base}/api/companion/catalog-images?q=${encodeURIComponent('100%')}`, { headers: H })).json(); assert.deepStrictEqual(s2.items.map((x) => x.name), ['100% Pure_Honey']);
    const s3 = await (await fetch(`${base}/api/companion/catalog-images?q=${encodeURIComponent('%')}&missing=1`, { headers: H })).json(); assert.strictEqual(s3.items.length, 0);
    assert.ok(D);
  });
  await t.test('delete removes the photo and the link, but never a hand-set external link', async () => {
    assert.strictEqual((await fetch(`${base}/api/companion/catalog-images/${A}`, { method: 'DELETE', headers: H })).status, 200);
    assert.strictEqual((await fetch(`${base}/api/catalog/image/${A}`)).status, 404);
    assert.strictEqual((await pool.query('SELECT image_url FROM global_medicines WHERE id=$1', [A])).rows[0].image_url, null);
    await pool.query("UPDATE global_medicines SET image_url='https://cdn.example.com/x.jpg' WHERE id=$1", [A]);
    await fetch(`${base}/api/companion/catalog-images/${A}`, { method: 'DELETE', headers: H });
    assert.strictEqual((await pool.query('SELECT image_url FROM global_medicines WHERE id=$1', [A])).rows[0].image_url, 'https://cdn.example.com/x.jpg');
  });
  await t.test('the database itself refuses a bad row (size cap, type check)', async () => {
    await assert.rejects(pool.query("INSERT INTO medicine_images VALUES ($1,'image/gif',$2,'x',null)", [A, Buffer.alloc(10)]));
    await assert.rejects(pool.query("INSERT INTO medicine_images VALUES ($1,'image/png',$2,'x',null)", [A, Buffer.alloc(200000)]));
  });
});
