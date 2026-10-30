// Rider push notifications. Drains public.push_outbox (delivery DB) and sends each push through Firebase Cloud Messaging.
// This is the ONLY place that talks to Firebase. If it is not configured the Hub runs exactly as before (riders still get offers in-app).
//
// Env:
//   FIREBASE_SERVICE_ACCOUNT_JSON   the Firebase service-account key, as raw JSON or base64 of that JSON  (Render: paste into an env var)
//   PUSH_TICK_MS                    how often to look for new pushes, default 1500 (an offer lasts 15 s, so keep this small)
//   PUSH_DISABLED=1                 turn it off without removing the code
'use strict';

function loadServiceAccount(raw) {
  if (!raw) return null;
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const j = JSON.parse(text);
  if (j.private_key) j.private_key = j.private_key.replace(/\\n/g, '\n');
  return j;
}

const DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

// One FCM message for one phone. HIGH priority + a notification block is what makes Android show it (with sound) even when the app is
// closed or swiped away. The `data` block lets the app open straight onto the offer. TTL = the time the offer has left, so FCM never
// delivers an offer that already ended.
function buildMessage(item, token) {
  const money = Number(item.earnings) > 0 ? ` · ₹${Math.round(Number(item.earnings))}` : '';
  const km = Number(item.pickupKm) > 0 ? ` · ${Number(item.pickupKm).toFixed(1)} km away` : '';
  const isOffer = item.kind === 'OFFER';
  const title = isOffer ? 'New order offer' : 'New order assigned';
  const body = `${item.pharmacyName || 'Pharmacy'}${money}${isOffer ? km : ''}`;
  const ttlMs = isOffer ? Math.max(5, Math.min(60, Number(item.secondsLeft) || 15)) * 1000 : 5 * 60 * 1000;
  return {
    token,
    notification: { title, body },
    data: {
      type: item.kind, deliveryId: String(item.deliveryId || ''), offerId: String(item.offerId || ''),
      expiresAt: String(item.expiresAt || ''), title, body,
    },
    android: {
      priority: 'high', ttl: ttlMs,
      collapseKey: isOffer ? 'offer' : 'assigned',            // a newer offer replaces an older one on the phone
      notification: { channelId: isOffer ? 'offers' : 'jobs', tag: isOffer ? 'offer' : 'assigned', priority: 'max', visibility: 'public', defaultSound: true, defaultVibrateTimings: true },
    },
  };
}

function createPushWorker({ deliveryPool, messaging = null, env = process.env, log = console }) {
  let timer = null, busy = false, enabled = false;

  function init() {
    if (env.PUSH_DISABLED === '1') { log.log('[PUSH] disabled by PUSH_DISABLED=1'); return false; }
    if (!deliveryPool) { log.log('[PUSH] no delivery database, push off'); return false; }
    if (messaging) { enabled = true; return true; }
    try {
      const account = loadServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON);
      if (!account) { log.log('[PUSH] FIREBASE_SERVICE_ACCOUNT_JSON not set: push is off (riders still get offers while the app is open)'); return false; }
      // modular API (firebase-admin v11+; the old `admin.credential` namespace is gone in v14)
      const { initializeApp, cert, getApps, getApp } = require('firebase-admin/app');
      const { getMessaging } = require('firebase-admin/messaging');
      const app = getApps().length ? getApp() : initializeApp({ credential: cert(account) });
      messaging = getMessaging(app); enabled = true; log.log('[PUSH] Firebase ready for project', account.project_id);
      return true;
    } catch (e) { log.warn('[PUSH] could not start Firebase:', e.message); return false; }
  }

  // One pass: claim -> send -> report. Returns a small summary (used by tests).
  async function tick() {
    if (!enabled || busy) return { skipped: true };
    busy = true;
    try {
      const { rows } = await deliveryPool.query('select public.push_claim(50) as r');
      const items = rows[0] && rows[0].r || [];
      if (!items.length) return { sent: 0 };
      const results = [];
      for (const item of items) {
        const deadTokens = [], okTokens = []; let lastError = null;
        const messages = item.tokens.map((t) => buildMessage(item, t));
        let responses;
        try { responses = (await messaging.sendEach(messages)).responses; }
        catch (e) { results.push({ id: item.id, ok: false, error: e.message }); continue; }
        responses.forEach((r, i) => {
          if (r.success) okTokens.push(item.tokens[i]);
          else { lastError = (r.error && (r.error.code || r.error.message)) || 'send_failed'; if (DEAD.has(r.error && r.error.code)) deadTokens.push(item.tokens[i]); }
        });
        // success if at least one phone got it; failure only if every phone failed for a reason other than "token is dead"
        const ok = okTokens.length > 0 || (deadTokens.length === item.tokens.length);
        results.push({ id: item.id, ok, error: ok ? null : lastError, okTokens, deadTokens });
      }
      await deliveryPool.query('select public.push_report($1::jsonb)', [JSON.stringify(results)]);
      return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
    } catch (e) { log.warn('[PUSH] tick failed:', e.message); return { error: e.message }; }
    finally { busy = false; }
  }

  function start() {
    if (timer || !init()) return () => {};
    const ms = Math.max(500, Number(env.PUSH_TICK_MS || 1500));
    timer = setInterval(() => { tick(); }, ms); timer.unref && timer.unref();
    return () => { clearInterval(timer); timer = null; };
  }
  return { start, tick, _init: init };
}

module.exports = { createPushWorker, buildMessage, loadServiceAccount };
