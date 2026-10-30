'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createPushWorker, buildMessage, loadServiceAccount } = require('../hub/routes/pushWorker');

const quiet = { log() {}, warn() {} };
const offer = (o = {}) => ({ id: 1, kind: 'OFFER', offerId: 'o1', deliveryId: 'd1', expiresAt: '2026-10-22T10:00:15Z', secondsLeft: 14, pharmacyName: 'Nowshera Pharmacy', earnings: 40, pickupKm: 2.04, tokens: ['t1'], ...o });
function pool(items) {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return /push_claim/.test(sql) ? { rows: [{ r: items }] } : { rows: [{ push_report: 1 }] }; } };
}

test('message: high priority, notification + data, ttl follows the offer, no customer data', () => {
  const m = buildMessage(offer(), 'tok');
  assert.strictEqual(m.android.priority, 'high');
  assert.strictEqual(m.android.ttl, 14000);
  assert.strictEqual(m.android.notification.channelId, 'offers');
  assert.strictEqual(m.notification.title, 'New order offer');
  assert.match(m.notification.body, /Nowshera Pharmacy · ₹40 · 2\.0 km away/);
  assert.strictEqual(m.data.type, 'OFFER'); assert.strictEqual(m.data.offerId, 'o1');
  assert.ok(Object.values(m.data).every((v) => typeof v === 'string'), 'FCM data values must be strings');
});
test('message: assigned order uses the jobs channel and a 5 minute ttl', () => {
  const m = buildMessage({ id: 2, kind: 'ASSIGNED', deliveryId: 'd2', pharmacyName: 'X', earnings: 30, tokens: ['t'] }, 'tok');
  assert.strictEqual(m.android.notification.channelId, 'jobs'); assert.strictEqual(m.android.ttl, 300000); assert.strictEqual(m.data.offerId, '');
});
test('service account: raw json, base64 and escaped newlines', () => {
  const j = { project_id: 'p', private_key: 'a\\nb' };
  assert.strictEqual(loadServiceAccount(JSON.stringify(j)).private_key, 'a\nb');
  assert.strictEqual(loadServiceAccount(Buffer.from(JSON.stringify(j)).toString('base64')).project_id, 'p');
  assert.strictEqual(loadServiceAccount(''), null);
});
test('off when Firebase is not configured: no queries, no crash', async () => {
  const p = pool([]); const w = createPushWorker({ deliveryPool: p, env: {}, log: quiet });
  assert.strictEqual(w.start()(), undefined); assert.deepStrictEqual(await w.tick(), { skipped: true }); assert.strictEqual(p.calls.length, 0);
});
test('off with PUSH_DISABLED=1 even if a messenger is supplied', () => {
  const w = createPushWorker({ deliveryPool: pool([]), messaging: {}, env: { PUSH_DISABLED: '1' }, log: quiet }); assert.strictEqual(w._init(), false);
});
test('sends to every phone, reports success and stamps tokens', async () => {
  const sent = []; const messaging = { sendEach: async (ms) => { sent.push(...ms); return { responses: ms.map(() => ({ success: true })) }; } };
  const p = pool([offer({ tokens: ['a', 'b'] })]); const w = createPushWorker({ deliveryPool: p, messaging, env: {}, log: quiet }); w._init();
  const r = await w.tick();
  assert.deepStrictEqual(r, { sent: 1, failed: 0 }); assert.deepStrictEqual(sent.map((m) => m.token), ['a', 'b']);
  const rep = JSON.parse(p.calls[1].params[0]); assert.deepStrictEqual(rep[0], { id: 1, ok: true, error: null, okTokens: ['a', 'b'], deadTokens: [] });
});
test('a dead token is reported for deletion; the push still counts as sent if another phone got it', async () => {
  const messaging = { sendEach: async () => ({ responses: [{ success: false, error: { code: 'messaging/registration-token-not-registered' } }, { success: true }] }) };
  const p = pool([offer({ tokens: ['dead', 'live'] })]); const w = createPushWorker({ deliveryPool: p, messaging, env: {}, log: quiet }); w._init();
  await w.tick(); const rep = JSON.parse(p.calls[1].params[0]);
  assert.strictEqual(rep[0].ok, true); assert.deepStrictEqual(rep[0].deadTokens, ['dead']); assert.deepStrictEqual(rep[0].okTokens, ['live']);
});
test('only dead tokens: closed (nothing left to retry); a transient error is left for retry', async () => {
  let mode = 'dead';
  const messaging = { sendEach: async () => ({ responses: [{ success: false, error: { code: mode === 'dead' ? 'messaging/invalid-registration-token' : 'messaging/internal-error' } }] }) };
  const p = pool([offer()]); const w = createPushWorker({ deliveryPool: p, messaging, env: {}, log: quiet }); w._init();
  await w.tick(); assert.strictEqual(JSON.parse(p.calls[1].params[0])[0].ok, true);
  mode = 'transient'; await w.tick(); const rep = JSON.parse(p.calls[3].params[0])[0];
  assert.strictEqual(rep.ok, false); assert.strictEqual(rep.error, 'messaging/internal-error'); assert.deepStrictEqual(rep.deadTokens, []);
});
test('a thrown FCM error fails that item only', async () => {
  const messaging = { sendEach: async (ms) => { if (ms[0].token === 'bad') throw new Error('network'); return { responses: [{ success: true }] }; } };
  const p = pool([offer({ id: 1, tokens: ['bad'] }), offer({ id: 2, tokens: ['good'] })]); const w = createPushWorker({ deliveryPool: p, messaging, env: {}, log: quiet }); w._init();
  const r = await w.tick(); assert.deepStrictEqual(r, { sent: 1, failed: 1 });
});
test('overlapping ticks never run twice at once; a database error does not throw', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const p = { query: async () => { await gate; return { rows: [{ r: [] }] }; } };
  const w = createPushWorker({ deliveryPool: p, messaging: {}, env: {}, log: quiet }); w._init();
  const a = w.tick(); const b = await w.tick(); assert.deepStrictEqual(b, { skipped: true }); release(); await a;
  const w2 = createPushWorker({ deliveryPool: { query: async () => { throw new Error('db down'); } }, messaging: {}, env: {}, log: quiet }); w2._init();
  assert.match((await w2.tick()).error, /db down/);
});

test('starts with the REAL firebase-admin library (generated key, no network): guards against API changes between versions', (t) => {
  let ok = true; try { require.resolve('firebase-admin/app'); } catch { ok = false; }
  if (!ok) return t.skip('firebase-admin is not installed');
  const crypto = require('crypto');
  const pk = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const sa = { type: 'service_account', project_id: 'demo-sehatwaadi', private_key: pk, client_email: 'fb@demo-sehatwaadi.iam.gserviceaccount.com' };
  const logs = [];
  const w = createPushWorker({ deliveryPool: { query: async () => ({ rows: [{ r: [] }] }) }, env: { FIREBASE_SERVICE_ACCOUNT_JSON: Buffer.from(JSON.stringify(sa)).toString('base64') }, log: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')) } });
  assert.strictEqual(w._init(), true, logs.join(' | '));
  assert.match(logs.join(' '), /Firebase ready for project demo-sehatwaadi/);
});
