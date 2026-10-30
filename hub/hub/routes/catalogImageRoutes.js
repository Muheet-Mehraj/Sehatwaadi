// Catalog photos. Two routers:
//   publicRouter    GET /:id                      the image itself (public, cached for a year; the URL carries a version stamp)
//   companionRouter GET /  PUT /:id  DELETE /:id  chemist-only (pharmacy id + x-pharmacy-key): list what lacks a photo, upload, remove
// Needs neon/05_catalog_images.sql. The chemist looks at the medicine in his hand and the photo on screen: uploading IS his verification.
'use strict';
const express = require('express');
const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 150 * 1024;
const IMAGE_PATH = '/api/catalog/image/';

// Trust the bytes, not the header the client sent.
function sniff(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

function createCatalogImageModule({ pool, authenticatePharmacy, env = process.env, log = console }) {
  const wrap = (fn) => async (req, res, next) => { try { await fn(req, res, next); } catch (e) { log.error('[catalog-images]', e.message); res.status(500).json({ ok: false, error: 'server' }); } };
  const publicBase = (req) => (env.PUBLIC_HUB_URL ? String(env.PUBLIC_HUB_URL).replace(/\/+$/, '') : `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`);

  // ---- public ----
  const publicRouter = express.Router();
  publicRouter.get('/:id', wrap(async (req, res) => {
    const id = req.params.id.replace(/\.(jpe?g|png|webp)$/i, '');
    if (!UUID_RE.test(id)) return res.status(404).end();
    const { rows } = await pool.query('SELECT content_type, bytes, sha256 FROM medicine_images WHERE medicine_id = $1', [id]);
    if (!rows.length) return res.status(404).end();
    const etag = `"${rows[0].sha256}"`;
    res.set({ ETag: etag, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Type': rows[0].content_type });
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.send(rows[0].bytes);
  }));

  // ---- chemist ----
  const companionRouter = express.Router();
  companionRouter.use(wrap(async (req, res, next) => {
    const id = req.headers['x-pharmacy-id'] || req.query.pharmacyId;
    const key = req.headers['x-pharmacy-key'] || '';
    const { valid, resolvedId } = await authenticatePharmacy(id, key);
    if (!valid) return res.status(403).json({ ok: false, error: 'not_authorized' });
    req.pharmacyId = resolvedId; next();
  }));

  // ?q=text  ?missing=1 (only medicines without a photo)  ?limit=40
  companionRouter.get('/', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 40));
    const missing = req.query.missing === '1' || req.query.missing === 'true';
    const { rows } = await pool.query(
      `SELECT m.id, m.name, m.image_url, (mi.medicine_id IS NOT NULL) AS has_image
         FROM global_medicines m LEFT JOIN medicine_images mi ON mi.medicine_id = m.id
        WHERE ($1 = '' OR m.name ILIKE $2) AND (NOT $3::boolean OR mi.medicine_id IS NULL)
        ORDER BY m.name LIMIT $4`, [q, `%${likeEscape(q)}%`, missing, limit]);
    const stats = (await pool.query('SELECT count(*)::int AS total, count(mi.medicine_id)::int AS with_image FROM global_medicines m LEFT JOIN medicine_images mi ON mi.medicine_id = m.id')).rows[0];
    res.json({ ok: true, total: stats.total, withImage: stats.with_image, items: rows.map((r) => ({ id: r.id, name: r.name, hasImage: r.has_image, imageUrl: r.image_url || null })) });
  }));

  companionRouter.put('/:id', express.raw({ type: () => true, limit: MAX_BYTES + 1024 }), wrap(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ ok: false, error: 'empty_image' });
    if (buf.length > MAX_BYTES) return res.status(413).json({ ok: false, error: 'image_too_large', message: 'The photo is too large (max 150 KB).' });
    const type = sniff(buf);
    if (!type) return res.status(415).json({ ok: false, error: 'unsupported_image', message: 'Send a JPEG, PNG or WebP photo.' });
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const med = await client.query('SELECT id FROM global_medicines WHERE id = $1', [req.params.id]);
      if (!med.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, error: 'medicine_not_found' }); }
      await client.query(
        `INSERT INTO medicine_images (medicine_id, content_type, bytes, sha256, uploaded_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (medicine_id) DO UPDATE SET content_type = EXCLUDED.content_type, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
        [req.params.id, type, buf, sha, req.pharmacyId]);
      const url = `${publicBase(req)}${IMAGE_PATH}${req.params.id}?v=${sha.slice(0, 10)}`;   // new bytes -> new URL -> every phone refetches
      await client.query('UPDATE global_medicines SET image_url = $2 WHERE id = $1', [req.params.id, url]);
      await client.query('COMMIT');
      res.json({ ok: true, imageUrl: url, bytes: buf.length });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  }));

  companionRouter.delete('/:id', wrap(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: 'bad_id' });
    await pool.query('DELETE FROM medicine_images WHERE medicine_id = $1', [req.params.id]);
    await pool.query('UPDATE global_medicines SET image_url = NULL WHERE id = $1 AND image_url LIKE $2', [req.params.id, `%${IMAGE_PATH}%`]);   // never wipes a link someone set by hand
    res.json({ ok: true });
  }));

  // body-parser errors (too big, aborted) -> JSON the app can show
  // eslint-disable-next-line no-unused-vars
  companionRouter.use((err, req, res, next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) return res.status(413).json({ ok: false, error: 'image_too_large', message: 'The photo is too large (max 150 KB).' });
    log.error('[catalog-images]', err && err.message); res.status(400).json({ ok: false, error: 'bad_request' });
  });

  return { publicRouter, companionRouter, sniff, MAX_BYTES };
}
module.exports = { createCatalogImageModule, sniff, MAX_BYTES };
