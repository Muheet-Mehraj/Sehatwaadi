// Chemist payouts (SehatWaadi pays the pharmacy what it is owed, minus commission). Needs delivery migration 20261024000000_settlements.sql.
//
//   chemistRouter   /api/companion/payouts   pharmacy id + x-pharmacy-key
//     GET /                    what is waiting, the open claim, history
//     POST /request            claim everything currently unsettled
//     POST /:id/withdraw       take a claim back before it is paid
//     POST /:id/confirm        "I received it"  -> settled
//     POST /:id/dispute {note} "I did not receive it"
//   adminRouter     /api/admin/payouts       x-admin-token (= DELIVERY_ADMIN_TOKEN, the operator)
//     GET /?status=            open claims (or one status)
//     POST /:id/pay {ref,note} record the payment (valid 12-digit reference, never reused)
//     POST /:id/cancel {note}  cancel an unpaid / disputed claim
//   deskRouter      /admin/desk              the operator's page (enter the admin token; pay chemists, verify rider deposits)
// The money rules live in the database (payout_* functions); this file only authenticates and passes through.
'use strict';
const express = require('express');
const crypto = require('crypto');
const { deskHtml } = require('./operatorDesk');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS = new Set(['REQUESTED', 'PAID', 'DISPUTED', 'CONFIRMED', 'CANCELLED']);
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const MESSAGES = {
  settlement_already_open: 'You already have a settlement in progress. Finish it first.',
  nothing_to_settle: 'There is nothing to settle yet.',
  invalid_state: 'That settlement has already moved on. Refresh and look again.',
  not_found: 'Settlement not found.',
  note_required: 'Please say what is wrong (a few words).',
  invalid_reference: 'Enter the 12-digit UPI reference (UTR) from the payment.',
  duplicate_reference: 'That payment reference has already been used.',
};

function createPayoutModule({ dpool, authenticatePharmacy, io = null, env = process.env, log = console }) {
  const call = async (fn, sig, params = []) => (await dpool.query(`SELECT public.${fn}(${sig}) AS r`, params)).rows[0].r;
  const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { log.error('[payouts]', e.message); res.status(500).json({ ok: false, error: 'server' }); } };
  const STATUS_FOR = { not_authorized: 403, not_found: 404, invalid_reference: 400, note_required: 400 };   // everything else a rule refused is a 409 (state conflict)
  const send = (res, r) => {
    if (r && r.ok) return res.json(r);
    const code = (r && r.error) || 'server';
    res.status(STATUS_FOR[code] || 409).json({ ok: false, error: code, message: MESSAGES[code] || 'Could not complete that.' });
  };
  const id = (req, res) => { if (!UUID_RE.test(req.params.id)) { res.status(400).json({ ok: false, error: 'bad_id' }); return null; } return req.params.id; };
  const notify = async (settlementId, event) => {   // tell the chemist's open companion to refresh (best effort)
    try {
      if (!io) return;
      const { rows } = await dpool.query('SELECT pharmacy_id FROM public.pharmacy_settlements WHERE id = $1', [settlementId]);
      if (rows[0]) io.to(`pharmacy_${rows[0].pharmacy_id}`).emit('payout_updated', { settlementId, event });
    } catch (e) { log.warn('[payouts] notify', e.message); }
  };

  // ---- chemist ----
  const chemistRouter = express.Router();
  chemistRouter.use(express.json({ limit: '10kb' }));
  chemistRouter.use(wrap(async (req, res, next) => {
    const pid = req.headers['x-pharmacy-id'] || req.query.pharmacyId || (req.body && req.body.pharmacyId);
    const key = req.headers['x-pharmacy-key'] || '';
    const { valid, resolvedId } = await authenticatePharmacy(pid, key);
    if (!valid) return res.status(403).json({ ok: false, error: 'not_authorized' });
    req.pharmacyId = resolvedId; next();
  }));
  chemistRouter.get('/', wrap(async (req, res) => send(res, await call('payout_summary', '$1::uuid', [req.pharmacyId]))));
  chemistRouter.post('/request', wrap(async (req, res) => {
    const r = await call('payout_request', '$1::uuid', [req.pharmacyId]);
    if (r && r.ok) log.log(`[payouts] pharmacy ${req.pharmacyId} claimed ₹${r.amount} for ${r.orders} orders (settlement ${r.settlementId})`);
    send(res, r);
  }));
  chemistRouter.post('/:id/withdraw', wrap(async (req, res) => { const sid = id(req, res); if (sid) send(res, await call('payout_withdraw', '$1::uuid,$2::uuid', [req.pharmacyId, sid])); }));
  chemistRouter.post('/:id/confirm', wrap(async (req, res) => { const sid = id(req, res); if (sid) send(res, await call('payout_confirm', '$1::uuid,$2::uuid', [req.pharmacyId, sid])); }));
  chemistRouter.post('/:id/dispute', wrap(async (req, res) => {
    const sid = id(req, res); if (!sid) return;
    const r = await call('payout_dispute', '$1::uuid,$2::uuid,$3', [req.pharmacyId, sid, String((req.body && req.body.note) || '')]);
    if (r && r.ok) log.warn(`[payouts] DISPUTE by pharmacy ${req.pharmacyId} on settlement ${sid}: ${String(req.body.note).slice(0, 120)}`);
    send(res, r);
  }));

  // ---- operator ----
  const adminRouter = express.Router();
  adminRouter.use(express.json({ limit: '10kb' }));
  adminRouter.use((req, res, next) => {
    const t = env.DELIVERY_ADMIN_TOKEN || '';
    if (t.length < 24) return res.status(503).json({ ok: false, error: 'admin_disabled' });
    if (!same(req.headers['x-admin-token'] || '', t)) return res.status(403).json({ ok: false, error: 'forbidden' });
    next();
  });
  adminRouter.get('/', wrap(async (req, res) => {
    const st = req.query.status ? String(req.query.status).toUpperCase() : null;
    if (st && !STATUS.has(st)) return res.status(400).json({ ok: false, error: 'bad_status' });
    send(res, await call('admin_payout_list', '$1', [st]));
  }));
  adminRouter.post('/:id/pay', wrap(async (req, res) => {
    const sid = id(req, res); if (!sid) return;
    const r = await call('admin_payout_pay', '$1::uuid,$2,$3,$4', [sid, String((req.body && req.body.ref) || ''), 'admin', req.body && req.body.note ? String(req.body.note) : null]);
    if (r && r.ok) { log.log(`[payouts] settlement ${sid} marked PAID`); notify(sid, 'paid'); }
    send(res, r);
  }));
  adminRouter.post('/:id/cancel', wrap(async (req, res) => {
    const sid = id(req, res); if (!sid) return;
    const r = await call('admin_payout_cancel', '$1::uuid,$2,$3', [sid, req.body && req.body.note ? String(req.body.note) : null, 'admin']);
    if (r && r.ok) notify(sid, 'cancelled');
    send(res, r);
  }));

  // ---- the operator's page (static; every action goes through the token-protected API above) ----
  const deskRouter = express.Router();
  deskRouter.get('/', (req, res) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.set({
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    res.send(deskHtml(nonce));
  });

  return { chemistRouter, adminRouter, deskRouter };
}
module.exports = { createPayoutModule, MESSAGES };
