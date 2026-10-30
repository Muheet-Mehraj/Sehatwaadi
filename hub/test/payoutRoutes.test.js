// Routes only: who may call what, the status codes, and that the database's answer is passed through. The money rules themselves
// (frozen amounts, one claim at a time, valid references, confirm-only-after-paid ...) are tested against real Postgres in
// database/supabase/tests/settlements.mjs.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createPayoutModule } = require('../hub/routes/payoutRoutes');

const PH = '11111111-1111-4111-8111-111111111111', SID = '33333333-3333-4333-8333-333333333333', TOKEN = 'a'.repeat(32);
const quiet = { log() {}, warn() {}, error() {} };

async function harness({ answers = {}, env = { DELIVERY_ADMIN_TOKEN: TOKEN } } = {}) {
  const calls = [], emitted = [];
  const dpool = { async query(sql, params) {
    calls.push({ sql, params });
    const fn = (sql.match(/public\.(\w+)\(/) || [])[1];
    if (/SELECT pharmacy_id FROM public\.pharmacy_settlements/.test(sql)) return { rows: [{ pharmacy_id: PH }] };
    return { rows: [{ r: answers[fn] ?? { ok: true } }] };
  } };
  const mod = createPayoutModule({ dpool, io: { to: (room) => ({ emit: (ev, p) => emitted.push({ room, ev, p }) }) }, env, log: quiet,
    authenticatePharmacy: async (id, key) => (id === PH && key === 'good' ? { valid: true, resolvedId: PH } : { valid: false, resolvedId: null }) });
  const app = express(); app.use('/api/companion/payouts', mod.chemistRouter); app.use('/api/admin/payouts', mod.adminRouter); app.use('/admin/desk', mod.deskRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const chem = (method, path, body, key = 'good') => fetch(`${base}/api/companion/payouts${path}`, { method, headers: { 'content-type': 'application/json', 'x-pharmacy-id': PH, 'x-pharmacy-key': key }, body: body ? JSON.stringify(body) : undefined });
  const adm = (method, path, body, token = TOKEN) => fetch(`${base}/api/admin/payouts${path}`, { method, headers: { 'content-type': 'application/json', 'x-admin-token': token }, body: body ? JSON.stringify(body) : undefined });
  return { calls, emitted, srv, base, chem, adm };
}

test('chemist routes need the pharmacy key', async () => {
  const h = await harness();
  assert.strictEqual((await h.chem('GET', '/', null, 'bad')).status, 403);
  assert.strictEqual((await h.chem('POST', '/request', {}, 'bad')).status, 403);
  assert.strictEqual(h.calls.length, 0, 'nothing reached the database');
  h.srv.close();
});
test('summary and claim pass through to the database for THIS pharmacy only', async () => {
  const h = await harness({ answers: { payout_summary: { ok: true, unsettled: { amount: 684, orders: 1 }, open: null, history: [] }, payout_request: { ok: true, settlementId: SID, amount: 684, orders: 1 } } });
  const s = await (await h.chem('GET', '/')).json(); assert.strictEqual(s.unsettled.amount, 684);
  const r = await h.chem('POST', '/request', {}); assert.strictEqual(r.status, 200);
  assert.ok(h.calls.every((c) => c.params[0] === PH), 'the pharmacy id comes from the key, never from the request body');
  h.srv.close();
});
test('the pharmacy id in the body cannot override the one the key belongs to', async () => {
  const h = await harness();
  await h.chem('POST', '/request', { pharmacyId: '99999999-9999-4999-8999-999999999999' });
  assert.strictEqual(h.calls[0].params[0], PH); h.srv.close();
});
test('rule refusals map to useful status codes and messages', async () => {
  const h = await harness({ answers: { payout_request: { ok: false, error: 'settlement_already_open' }, payout_confirm: { ok: false, error: 'invalid_state' }, payout_dispute: { ok: false, error: 'note_required' }, payout_withdraw: { ok: false, error: 'not_found' } } });
  const a = await h.chem('POST', '/request', {}); assert.strictEqual(a.status, 409); assert.match((await a.json()).message, /already have a settlement/);
  assert.strictEqual((await h.chem('POST', `/${SID}/confirm`, {})).status, 409);
  assert.strictEqual((await h.chem('POST', `/${SID}/dispute`, { note: '' })).status, 400);
  assert.strictEqual((await h.chem('POST', `/${SID}/withdraw`, {})).status, 404);
  assert.strictEqual((await h.chem('POST', '/not-a-uuid/confirm', {})).status, 400);
  h.srv.close();
});
test('confirm and dispute send the right arguments', async () => {
  const h = await harness();
  await h.chem('POST', `/${SID}/confirm`, {}); await h.chem('POST', `/${SID}/dispute`, { note: 'not in my account' });
  assert.deepStrictEqual(h.calls[0].params, [PH, SID]); assert.deepStrictEqual(h.calls[1].params, [PH, SID, 'not in my account']); h.srv.close();
});
test('operator routes need the admin token; they are off when no token is configured', async () => {
  const h = await harness();
  assert.strictEqual((await h.adm('GET', '/', null, 'wrong')).status, 403);
  assert.strictEqual((await fetch(`${h.base}/api/admin/payouts`)).status, 403);
  assert.strictEqual((await h.adm('POST', `/${SID}/pay`, { ref: '507291847362' }, 'x')).status, 403);
  assert.strictEqual(h.calls.length, 0); h.srv.close();
  const off = await harness({ env: {} }); assert.strictEqual((await off.adm('GET', '/')).status, 503); off.srv.close();
  const weak = await harness({ env: { DELIVERY_ADMIN_TOKEN: 'short' } }); assert.strictEqual((await weak.adm('GET', '/')).status, 503); weak.srv.close();
});
test('the pharmacy key cannot be used on operator routes', async () => {
  const h = await harness();
  assert.strictEqual((await fetch(`${h.base}/api/admin/payouts`, { headers: { 'x-pharmacy-id': PH, 'x-pharmacy-key': 'good' } })).status, 403); h.srv.close();
});
test('paying: reference goes to the database, the chemist\'s companion is told, bad references are 400', async () => {
  const h = await harness({ answers: { admin_payout_pay: { ok: true } } });
  const ok = await h.adm('POST', `/${SID}/pay`, { ref: '507291847362', note: 'UPI' }); assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(h.calls[0].params, [SID, '507291847362', 'admin', 'UPI']);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(h.emitted, [{ room: `pharmacy_${PH}`, ev: 'payout_updated', p: { settlementId: SID, event: 'paid' } }]);
  h.srv.close();
  const bad = await harness({ answers: { admin_payout_pay: { ok: false, error: 'invalid_reference' } } });
  const r = await bad.adm('POST', `/${SID}/pay`, { ref: '123456789012' }); assert.strictEqual(r.status, 400); assert.match((await r.json()).message, /12-digit/);
  assert.strictEqual(bad.emitted.length, 0, 'no notification when nothing was paid'); bad.srv.close();
  const dup = await harness({ answers: { admin_payout_pay: { ok: false, error: 'duplicate_reference' } } }); assert.strictEqual((await dup.adm('POST', `/${SID}/pay`, { ref: '507291847362' })).status, 409); dup.srv.close();
});
test('listing validates the status filter', async () => {
  const h = await harness({ answers: { admin_payout_list: { ok: true, settlements: [] } } });
  assert.strictEqual((await h.adm('GET', '/?status=bogus')).status, 400);
  assert.strictEqual((await h.adm('GET', '/?status=disputed')).status, 200); assert.deepStrictEqual(h.calls[0].params, ['DISPUTED']); h.srv.close();
});
test('the operator desk page is served with a strict policy and no secrets', async () => {
  const h = await harness();
  const r = await fetch(`${h.base}/admin/desk`); const html = await r.text();
  assert.strictEqual(r.status, 200); assert.match(r.headers.get('content-security-policy'), /default-src 'none'; script-src 'nonce-/); assert.strictEqual(r.headers.get('x-frame-options'), 'DENY'); assert.match(r.headers.get('cache-control'), /no-store/);
  const nonce = /nonce-([^']+)'/.exec(r.headers.get('content-security-policy'))[1]; assert.ok(html.includes(`nonce="${nonce}"`));
  assert.ok(!html.includes(TOKEN)); assert.ok(!/innerHTML/.test(html), 'user text is only ever inserted with textContent');
  assert.notStrictEqual(nonce, /nonce-([^']+)'/.exec((await fetch(`${h.base}/admin/desk`)).headers.get('content-security-policy'))[1], 'a fresh nonce per request');
  h.srv.close();
});
