// Routes only: who may call what, status codes, that pictures are served safely. The rules themselves (valid PAN/licence, who becomes
// VERIFIED, suspension...) are tested against real Postgres in database/supabase/tests/kyc.mjs.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createKycModule } = require('../hub/routes/kycRoutes');

const RID = '11111111-1111-4111-8111-111111111111', TOKEN = 'k'.repeat(32);
const quiet = { log() {}, warn() {}, error() {} };

async function harness({ answers = {}, doc = { content_type: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]) }, env = { DELIVERY_ADMIN_TOKEN: TOKEN } } = {}) {
  const calls = [];
  const dpool = { async query(sql, params) {
    calls.push({ sql, params });
    if (/FROM public\.rider_kyc_docs/.test(sql)) return { rows: doc ? [doc] : [] };
    const fn = (sql.match(/public\.(\w+)\(/) || [])[1];
    return { rows: [{ r: answers[fn] ?? { ok: true } }] };
  } };
  const app = express(); app.use('/api/admin/kyc', createKycModule({ dpool, env, log: quiet }).adminRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const adm = (method, path, body, token = TOKEN) => fetch(`${base}/api/admin/kyc${path}`, { method, headers: { 'content-type': 'application/json', 'x-admin-token': token }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
  return { calls, srv, adm };
}

test('everything needs the admin token; a missing/short token disables the API', async () => {
  const h = await harness();
  for (const [m, p] of [['GET', '/'], ['GET', `/${RID}`], ['GET', `/${RID}/doc/SELFIE`], ['POST', `/${RID}/decide`], ['POST', `/${RID}/suspend`], ['POST', `/${RID}/reinstate`]])
    assert.strictEqual((await h.adm(m, p, m === 'GET' ? null : {}, 'wrong')).status, 403, m + p);
  assert.strictEqual(h.calls.length, 0, 'nothing reached the database');
  h.srv.close();
  const off = await harness({ env: { DELIVERY_ADMIN_TOKEN: 'short' } });
  assert.strictEqual((await off.adm('GET', '/', null, 'short')).status, 503); off.srv.close();
});
test('list defaults to SUBMITTED, accepts known statuses only', async () => {
  const h = await harness({ answers: { admin_kyc_list: { ok: true, items: [{ riderId: RID }] } } });
  const r = await (await h.adm('GET', '/')).json(); assert.strictEqual(r.items.length, 1);
  assert.deepStrictEqual(h.calls[0].params, ['SUBMITTED']);
  assert.strictEqual((await h.adm('GET', '/?status=DROP')).status, 400);
  assert.strictEqual((await h.adm('GET', '/?status=rejected')).status, 200); assert.deepStrictEqual(h.calls[1].params, ['REJECTED']);
  h.srv.close();
});
test('ids and document kinds are validated before touching the database', async () => {
  const h = await harness();
  assert.strictEqual((await h.adm('GET', '/not-a-uuid')).status, 400);
  assert.strictEqual((await h.adm('GET', `/${RID}/doc/PASSPORT`)).status, 400);
  assert.strictEqual((await h.adm('GET', `/${RID}/doc/..%2F..%2Fx`)).status, 400);
  assert.strictEqual(h.calls.length, 0); h.srv.close();
});
test('a picture is served with the stored type and hardening headers, never cached', async () => {
  const h = await harness();
  const r = await h.adm('GET', `/${RID}/doc/PAN`);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get('content-type'), 'image/jpeg');
  assert.match(r.headers.get('cache-control'), /no-store/); assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  assert.strictEqual((await r.arrayBuffer()).byteLength, 6); h.srv.close();
  const none = await harness({ doc: null }); assert.strictEqual((await none.adm('GET', `/${RID}/doc/PAN`)).status, 404); none.srv.close();
});
test('decide passes the decision, only known retake kinds, and a trimmed reason; the database answer decides the status code', async () => {
  const h = await harness({ answers: { admin_kyc_decide: { ok: true, status: 'REJECTED' } } });
  const r = await h.adm('POST', `/${RID}/decide`, { decision: 'reject', retake: ['PAN', 'EVIL', 'SELFIE'], reason: 'blurry' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(h.calls[0].params, [RID, 'REJECT', ['PAN', 'SELFIE'], 'blurry', 'admin']); h.srv.close();
  for (const [code, status] of [['reason_required', 400], ['not_found', 404], ['invalid_state', 409], ['rider_suspended', 409], ['dl_expired', 409]]) {
    const x = await harness({ answers: { admin_kyc_decide: { ok: false, error: code } } });
    const res = await x.adm('POST', `/${RID}/decide`, { decision: 'APPROVE' }); const j = await res.json();
    assert.strictEqual(res.status, status, code); assert.ok(j.message, 'has a human message'); x.srv.close();
  }
});
test('suspend and reinstate pass through', async () => {
  const h = await harness();
  assert.strictEqual((await h.adm('POST', `/${RID}/suspend`, { reason: 'licence expired' })).status, 200);
  assert.deepStrictEqual(h.calls[0].params, [RID, 'licence expired', 'admin']);
  assert.strictEqual((await h.adm('POST', `/${RID}/reinstate`, {})).status, 200); h.srv.close();
});
