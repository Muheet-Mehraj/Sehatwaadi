// Rider KYC review for the operator. Needs delivery migration 20261025000000_rider_kyc.sql and DELIVERY_ADMIN_TOKEN (24+ chars).
//   adminRouter  /api/admin/kyc   x-admin-token
//     GET  /?status=SUBMITTED|APPROVED|REJECTED      riders in that state (default: waiting for review)
//     GET  /:rider                                   the details + list of documents
//     GET  /:rider/doc/:kind                         one picture (served with the stored, byte-checked type; never cached)
//     POST /:rider/decide {decision:'APPROVE'|'REJECT', retake:[kinds], reason}
//     POST /:rider/suspend {reason}   POST /:rider/reinstate
// The rules (what counts as valid, who becomes VERIFIED) live in the database; this file only authenticates and passes through.
'use strict';
const express = require('express');
const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(['SELFIE', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'PAN', 'DL_FRONT']);
const STATUS = new Set(['SUBMITTED', 'APPROVED', 'REJECTED']);
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const MESSAGES = {
  not_found: 'No KYC found for that rider.',
  invalid_state: 'That case has already moved on. Refresh and look again.',
  reason_required: 'Please write the reason (a few words) - the rider will see it.',
  rider_suspended: 'This rider is suspended. Reinstate first, then approve.',
  dl_expired: "The rider's driving licence has expired.",
  invalid_document: 'Unknown document.',
  invalid_decision: 'Decision must be APPROVE or REJECT.',
};

function createKycModule({ dpool, env = process.env, log = console }) {
  const call = async (fn, sig, params = []) => (await dpool.query(`SELECT public.${fn}(${sig}) AS r`, params)).rows[0].r;
  const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { log.error('[kyc]', e.message); res.status(500).json({ ok: false, error: 'server' }); } };
  const send = (res, r) => {
    if (r && r.ok) return res.json(r);
    const code = (r && r.error) || 'server';
    res.status({ not_found: 404, reason_required: 400, invalid_document: 400, invalid_decision: 400, not_authorized: 403 }[code] || 409).json({ ok: false, error: code, message: MESSAGES[code] || 'Could not complete that.' });
  };
  const rid = (req, res) => { if (!UUID_RE.test(req.params.id)) { res.status(400).json({ ok: false, error: 'bad_id' }); return null; } return req.params.id; };

  const adminRouter = express.Router();
  adminRouter.use(express.json({ limit: '10kb' }));
  adminRouter.use((req, res, next) => {
    const t = env.DELIVERY_ADMIN_TOKEN || '';
    if (t.length < 24) return res.status(503).json({ ok: false, error: 'admin_disabled' });
    if (!same(req.headers['x-admin-token'] || '', t)) return res.status(403).json({ ok: false, error: 'forbidden' });
    next();
  });
  adminRouter.get('/', wrap(async (req, res) => {
    const st = req.query.status ? String(req.query.status).toUpperCase() : 'SUBMITTED';
    if (!STATUS.has(st)) return res.status(400).json({ ok: false, error: 'bad_status' });
    send(res, await call('admin_kyc_list', '$1', [st]));
  }));
  adminRouter.get('/:id', wrap(async (req, res) => { const id = rid(req, res); if (id) send(res, await call('admin_kyc_get', '$1::uuid', [id])); }));
  adminRouter.get('/:id/doc/:kind', wrap(async (req, res) => {
    const id = rid(req, res); if (!id) return;
    if (!KINDS.has(req.params.kind)) return res.status(400).json({ ok: false, error: 'invalid_document' });
    const { rows } = await dpool.query('SELECT content_type, bytes FROM public.rider_kyc_docs WHERE rider_id = $1 AND kind = $2', [id, req.params.kind]);
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'not_found' });
    res.set({ 'Content-Type': rows[0].content_type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
              'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline', 'Referrer-Policy': 'no-referrer' });
    res.send(rows[0].bytes);
    log.log(`[kyc] operator viewed ${req.params.kind} of rider ${id}`);
  }));
  adminRouter.post('/:id/decide', wrap(async (req, res) => {
    const id = rid(req, res); if (!id) return;
    const b = req.body || {}; const retake = Array.isArray(b.retake) ? b.retake.map(String).filter((k) => KINDS.has(k)) : [];
    const r = await call('admin_kyc_decide', '$1::uuid,$2,$3::text[],$4,$5', [id, String(b.decision || '').toUpperCase(), retake, b.reason ? String(b.reason).slice(0, 300) : null, 'admin']);
    if (r && r.ok) log.log(`[kyc] rider ${id} ${r.status}`);
    send(res, r);
  }));
  adminRouter.post('/:id/suspend', wrap(async (req, res) => {
    const id = rid(req, res); if (!id) return;
    const r = await call('admin_kyc_suspend', '$1::uuid,$2,$3', [id, String((req.body && req.body.reason) || '').slice(0, 300), 'admin']);
    if (r && r.ok) log.warn(`[kyc] rider ${id} SUSPENDED`);
    send(res, r);
  }));
  adminRouter.post('/:id/reinstate', wrap(async (req, res) => { const id = rid(req, res); if (id) send(res, await call('admin_kyc_reinstate', '$1::uuid,$2', [id, 'admin'])); }));
  return { adminRouter };
}
module.exports = { createKycModule, MESSAGES };
