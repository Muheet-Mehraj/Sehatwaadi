require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const cors = require('cors');

(function assertSafeAuthConfig() {
    const production = process.env.NODE_ENV === 'production';
    const secret = process.env.JWT_SECRET || '';
    if (production && process.env.OTP_MODE === 'mock') {
        console.error('FATAL: OTP_MODE=mock is set while NODE_ENV=production. Anyone could log in as any customer. Remove OTP_MODE.');
        process.exit(1);
    }
    if (production && secret.length < 32) {
        console.error('FATAL: JWT_SECRET must be set to a random string of at least 32 characters in production.');
        process.exit(1);
    }
    if (!production) {
        if (process.env.OTP_MODE === 'mock') console.warn('[AUTH] OTP_MODE=mock: every OTP is 123456. Never deploy like this.');
        if (!secret) console.warn('[AUTH] JWT_SECRET is not set: customer login cannot issue or verify sessions.');
    }
})();

const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // behind Render's proxy, req.ip must be the real client
const httpServer = createServer(app);

// Which websites/apps may call the Hub from a browser. Comma-separated, e.g.
// ALLOWED_ORIGINS=https://your-customer-app.pages.dev,http://localhost:4000,http://localhost:5173
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const corsOrigin = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true;
if (!ALLOWED_ORIGINS.length && process.env.NODE_ENV === 'production') {
    console.warn('[SECURITY] ALLOWED_ORIGINS is not set: the Hub accepts browser requests from ANY website. Set it.');
}
// Dev-only conveniences, all OFF unless explicitly enabled and never in production.
const DEV_MODE = process.env.NODE_ENV !== 'production';
const DEV_FALLBACK = DEV_MODE && process.env.ALLOW_DEV_PHARMACY_FALLBACK === '1';
const DEV_BROADCAST = DEV_MODE && process.env.ALLOW_DEV_BROADCAST === '1';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const keysMatch = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0 && b.length > 0 && crypto.timingSafeEqual(sha(a), sha(b));
const keyFrom = (req) => req.headers['x-pharmacy-key'] || (req.body && req.body.apiKey) || '';

// Small in-memory per-IP limiter (single instance).
function limiter({ windowMs, max }) {
    const hits = new Map();
    setInterval(() => {
        const cutoff = Date.now() - windowMs;
        for (const [k, v] of hits) if (v[v.length - 1] <= cutoff) hits.delete(k);
    }, Math.max(windowMs, 60000)).unref();
    return (req, res, next) => {
        const now = Date.now();
        const list = (hits.get(req.ip) || []).filter((t) => t > now - windowMs);
        list.push(now);
        hits.set(req.ip, list);
        if (list.length > max) return res.status(429).json({ error: 'Too many requests. Please slow down.' });
        next();
    };
}
const createOrderLimiter = limiter({ windowMs: 60 * 1000, max: 10 });   // each order can carry a 7MB image
const publicLimiter = limiter({ windowMs: 60 * 1000, max: 60 });

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "8mb" }));

const io = new Server(httpServer, {
    cors: { origin: corsOrigin, methods: ["GET", "POST"] }
});

// Added keepAlive + pool.on('error') so cloud Postgres idle disconnects NEVER crash Node!
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL_INSECURE === '1' ? { rejectUnauthorized: false } : { rejectUnauthorized: true },
    keepAlive: true,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
    console.warn('[PG POOL] Idle client connection closed by remote DB (auto-recovering):', err.message);
});

const customerAuthRoutes = require('./routes/customerAuthRoutes');
const { optionalCustomer } = require('./middleware/customerAuth');
app.use('/api/customer/auth', customerAuthRoutes(pool));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const RX_REQUIRED_CLASSES = new Set(["H", "H1", "X", "REVIEW"]);
const HEARTBEAT_FRESH_SECONDS = 120;
const MAX_LINE_QTY = 100;

// Track the most recently synced pharmacy ID so local dev POS frontend mismatches auto-resolve
let lastSyncedPharmacyId = null;

async function resolvePharmacyId(pharmacyId) {
    if (!pharmacyId) return DEV_FALLBACK ? lastSyncedPharmacyId : null;
    if (!UUID_RE.test(String(pharmacyId))) return null;
    const exact = await pool.query(`SELECT id FROM network_pharmacies WHERE id = $1`, [pharmacyId]);
    if (exact.rows.length > 0) return exact.rows[0].id;
    if (DEV_FALLBACK) {
        const fallback = await pool.query(`SELECT id FROM network_pharmacies ORDER BY last_heartbeat DESC NULLS LAST LIMIT 1`);
        if (fallback.rows.length > 0) return fallback.rows[0].id;
    }
    return null;
}

function normalizeLines(items) {
    if (!Array.isArray(items) || items.length === 0) return null;
    const merged = new Map();
    for (const raw of items) {
        const name = String(typeof raw === "string" ? raw : raw && raw.name || "").trim();
        const quantity = typeof raw === "string" ? 1 : raw && raw.quantity === undefined ? 1 : raw && raw.quantity;
        if (!name || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QTY) return null;
        const key = name.toLowerCase();
        const prev = merged.get(key);
        merged.set(key, { name: prev ? prev.name : name, quantity: (prev ? prev.quantity : 0) + quantity });
    }
    return [...merged.values()];
}

function toLines(items) {
    return (Array.isArray(items) ? items : []).map((i) =>
        typeof i === "string" ? { name: i, quantity: 1 } : i
    );
}

// How the Hub decides who may be offered an order.
//   MATCH_MODE=learned (default): no stock files. A pharmacy qualifies when it is online (fresh heartbeat), nearby, and has not
//     said "out of stock" for any item in the cart (pharmacy_item_blocks, filled by the companion app's release action).
//   MATCH_MODE=inventory: the old behaviour, which needs global_inventory rows from the POS sync.
const MATCH_MODE = process.env.MATCH_MODE === 'inventory' ? 'inventory' : 'learned';

async function findCandidates(lat, lng, radiusKm, lines) {
    const radiusMeters = (radiusKm > 0 ? radiusKm : 5) * 1000;
    const names = lines.map((l) => l.name.toLowerCase());
    const qtys = lines.map((l) => l.quantity);

    if (MATCH_MODE === 'learned') {
        const result = await pool.query(
            `
            SELECT
                p.id AS pharmacy_id,
                p.name AS pharmacy_name,
                ST_Distance(p.geog, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_meters
            FROM network_pharmacies p
            WHERE
                p.is_online = true
                AND p.last_heartbeat > NOW() - ($5::int * INTERVAL '1 second')
                AND p.geog IS NOT NULL
                AND ST_DWithin(p.geog, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
                AND NOT EXISTS (
                    SELECT 1 FROM pharmacy_item_blocks b
                    WHERE b.pharmacy_id = p.id AND b.blocked_until > NOW() AND b.item_key = ANY($4::text[])
                )
            ORDER BY distance_meters ASC
            `,
            [lng, lat, radiusMeters, names, HEARTBEAT_FRESH_SECONDS]
        );
        return result.rows;
    }

    const result = await pool.query(
        `
        SELECT
            p.id AS pharmacy_id,
            p.name AS pharmacy_name,
            ST_Distance(p.geog, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_meters
        FROM network_pharmacies p
        WHERE
            p.is_online = true
            AND p.last_heartbeat > NOW() - ($7::int * INTERVAL '1 second')
            AND p.geog IS NOT NULL
            AND ST_DWithin(p.geog, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
            AND (
                SELECT COUNT(*)
                FROM unnest($4::text[], $6::int[]) AS req(name, qty)
                WHERE EXISTS (
                    SELECT 1
                    FROM global_inventory i
                    JOIN global_medicines m ON m.id = i.medicine_id
                    WHERE i.pharmacy_id = p.id
                      AND LOWER(m.name) = req.name
                      AND i.quantity >= req.qty
                )
            ) = $5
        ORDER BY distance_meters ASC
        `,
        [lng, lat, radiusMeters, names, names.length, qtys, HEARTBEAT_FRESH_SECONDS]
    );
    return result.rows;
}

async function enrichLines(lines) {
    const names = lines.map((l) => l.name.toLowerCase());
    const res = await pool.query(
        `SELECT LOWER(name) AS lname, name, price, schedule_class FROM global_medicines WHERE LOWER(name) = ANY($1::text[])`,
        [names]
    );
    const byName = new Map(res.rows.map((r) => [r.lname, r]));
    return lines.map((l) => {
        const m = byName.get(l.name.toLowerCase());
        return {
            name: m ? m.name : l.name,
            quantity: l.quantity,
            price: m ? Number(m.price) || 0 : 0,
            schedule: m && m.schedule_class ? m.schedule_class : "OTC",
        };
    });
}

app.post('/api/orders/match', publicLimiter, async (req, res) => {
    const { lat, lng, radiusKm, items } = req.body;

    if (typeof lat !== "number" || typeof lng !== "number") {
        return res.status(400).json({ error: "lat and lng must be numbers." });
    }
    const lines = normalizeLines(items);
    if (!lines) {
        return res.status(400).json({ error: "items must be a non-empty array of medicine names (or {name, quantity} objects)." });
    }

    try {
        const rows = await findCandidates(lat, lng, typeof radiusKm === "number" ? radiusKm : 5, lines);

        res.json({
            matchCount: rows.length,
            pharmacies: rows.map((r) => ({
                pharmacyId: r.pharmacy_id,
                name: r.pharmacy_name,
                distanceKm: Math.round((r.distance_meters / 1000) * 100) / 100,
            })),
        });
    } catch (err) {
        console.error("Order matching failed:", err);
        res.status(500).json({ error: "Matching query failed." });
    }
});

app.get('/api/medicines/search', publicLimiter, async (req, res) => {
    const q = String(req.query.q || "").trim().slice(0, 100);
    const rxOnly = req.query.rx === '1';
    if (!q && !rxOnly) return res.json([]);

    try {
        const result = await pool.query(
            `SELECT id, name, price, schedule_class FROM global_medicines
             WHERE name ILIKE $1
               AND ($2::boolean = false OR UPPER(schedule_class) IN ('H', 'H1', 'X', 'REVIEW'))
             ORDER BY name ASC
             LIMIT 20`,
            [`%${q.replace(/[\\%_]/g, '\\$&')}%`, rxOnly]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Medicine search failed:", err);
        res.status(500).json({ error: "Search failed." });
    }
});

app.get('/api/orders/:id', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, status, cascade_index, current_pharmacy_id, items, created_at, updated_at
             FROM orders WHERE id = $1`,
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: "Order not found." });

        const order = result.rows[0];
        let pharmacyName = null;
        if (order.current_pharmacy_id && order.status === 'ACCEPTED') {
            const pharm = await pool.query(`SELECT name FROM network_pharmacies WHERE id = $1`, [order.current_pharmacy_id]);
            pharmacyName = pharm.rows[0]?.name || null;
        }

        res.json({ ...order, pharmacyName });
    } catch (err) {
        console.error("Order lookup failed:", err);
        res.status(500).json({ error: "Lookup failed." });
    }
});

// ========================================================
// CASCADE ENGINE (60s window in dev so you have plenty of time to click Accept)
// ========================================================
const CASCADE_TIMEOUT_MS = Number(process.env.CASCADE_TIMEOUT_SECONDS || 60) * 1000;
const CASCADE_RX_TIMEOUT_MS = Number(process.env.CASCADE_RX_TIMEOUT_SECONDS || 90) * 1000;
let companionModule;   // assigned near the bottom, after the delivery module exists
const activeCascadeTimers = new Map();
const orderDeadlines = new Map();

function clearCascadeTimer(orderId) {
    if (activeCascadeTimers.has(orderId)) clearTimeout(activeCascadeTimers.get(orderId));
    activeCascadeTimers.delete(orderId);
    orderDeadlines.delete(orderId);
}

function buildOrderPayload(order, rxStatus, timeoutSeconds, includeImage = true) {
    const lines = toLines(order.items);
    const total = Math.round(lines.reduce((s, l) => s + (Number(l.price) || 0) * l.quantity, 0) * 100) / 100;
    return {
        orderId: order.id,
        items: lines.map((l) => l.name),
        lines,
        total,
        requiresRx: rxStatus !== 'NOT_REQUIRED',
        timeoutSeconds,
        rxImage: includeImage ? (order.rx_image || null) : null,
        hasRxImage: Boolean(order.rx_image),
        rxStatus,
    };
}

async function sendToNextCandidate(orderId) {
    const orderRes = await pool.query(`SELECT * FROM orders WHERE id = $1`, [orderId]);
    const order = orderRes.rows[0];
    if (!order) return;

    const candidates = order.candidate_pharmacy_ids || [];
    const index = order.cascade_index;

    if (index >= candidates.length) {
        const done = await pool.query(
            `UPDATE orders SET status = 'UNFULFILLABLE', updated_at = NOW()
             WHERE id = $1 AND status IN ('MATCHING', 'SENT_TO_PHARMACY') RETURNING id`,
            [orderId]
        );
        if (done.rowCount > 0) {
            io.to(`order_${orderId}`).emit('order_unfulfillable', { orderId });
            console.log(`[CASCADE] Order ${orderId} exhausted all candidates -- unfulfillable.`);
        }
        return;
    }

    const pharmacyId = candidates[index];

    const sent = await pool.query(
        `UPDATE orders
         SET status = 'SENT_TO_PHARMACY',
             current_pharmacy_id = $1,
             rx_status = CASE WHEN rx_status = 'NOT_REQUIRED' THEN rx_status ELSE 'PENDING' END,
             updated_at = NOW()
         WHERE id = $2 AND status IN ('MATCHING', 'SENT_TO_PHARMACY')
         RETURNING rx_status`,
        [pharmacyId, orderId]
    );
    if (sent.rowCount === 0) return;

    const timeoutMs = sent.rows[0].rx_status !== 'NOT_REQUIRED' ? CASCADE_RX_TIMEOUT_MS : CASCADE_TIMEOUT_MS;
    // Persist the deadline BEFORE telling the pharmacy, so the app's first fetch already sees it, and so a Hub restart
    // cannot strand the order (the sweeper in companionRoutes.js reads it).
    await pool.query(
        `UPDATE orders SET offer_deadline = $1, picking_started_at = NULL, extension_used = false WHERE id = $2`,
        [new Date(Date.now() + timeoutMs), orderId]
    );

    const payload = buildOrderPayload(order, sent.rows[0].rx_status, timeoutMs / 1000);
    io.to(`pharmacy_${pharmacyId}`).emit('new_order', payload);
    // Also broadcast to all connected POS spokes in dev so a pharmacyId mismatch never hides an order
    if (DEV_BROADCAST) {
        io.emit('new_order', payload);
    }
    console.log(`[CASCADE] Order ${orderId} sent to pharmacy ${pharmacyId} (candidate ${index + 1}/${candidates.length}).`);

    armOfferTimer(orderId, pharmacyId, timeoutMs);
}

// (Re)arms the in-memory timeout for the pharmacy that currently holds the order. Called when an order is offered and
// again when the chemist opens it (the longer picking window) or asks for extra time.
function armOfferTimer(orderId, pharmacyId, timeoutMs) {
    if (activeCascadeTimers.has(orderId)) clearTimeout(activeCascadeTimers.get(orderId));
    orderDeadlines.set(orderId, Date.now() + timeoutMs);

    const timer = setTimeout(async () => {
        activeCascadeTimers.delete(orderId);
        orderDeadlines.delete(orderId);
        try {
            const advanced = await pool.query(
                `UPDATE orders SET cascade_index = cascade_index + 1, offer_deadline = NULL, updated_at = NOW()
                 WHERE id = $1 AND status = 'SENT_TO_PHARMACY' AND current_pharmacy_id = $2
                 RETURNING id`,
                [orderId, pharmacyId]
            );
            if (advanced.rowCount === 0) return;
            console.log(`[CASCADE] Pharmacy ${pharmacyId} timed out on order ${orderId}. Advancing.`);
            await companionModule.onTimeout(orderId, pharmacyId);
            await sendToNextCandidate(orderId);
        } catch (err) {
            console.error(`[CASCADE] Timeout handler failed for order ${orderId}:`, err.message);
        }
    }, timeoutMs);

    activeCascadeTimers.set(orderId, timer);
}

let hasCustomerIdColumn = false;
async function ordersHaveCustomerId() {
    if (hasCustomerIdColumn) return true;
    const r = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'customer_id' LIMIT 1`
    );
    hasCustomerIdColumn = r.rowCount > 0;
    return hasCustomerIdColumn;
}

app.post('/api/orders/create', createOrderLimiter, optionalCustomer, (req, res, next) => deliveryModule.activeOrderGuard(req, res, next), async (req, res) => {
    const { lat, lng, radiusKm, items, rxImage, requiresRx: clientRequiresRx } = req.body;

    if (typeof lat !== "number" || typeof lng !== "number") {
        return res.status(400).json({ error: "lat and lng must be numbers." });
    }
    const baseLines = normalizeLines(items);
    if (!baseLines) {
        return res.status(400).json({ error: "items must be a non-empty array of medicine names (or {name, quantity} objects)." });
    }

    try {
        const lines = await enrichLines(baseLines);

        const requiresRx = !!clientRequiresRx || lines.some((l) => RX_REQUIRED_CLASSES.has(String(l.schedule).toUpperCase()));
        if (requiresRx) {
            const validImage =
                typeof rxImage === "string" &&
                /^data:image\/(png|jpe?g|webp);base64,/.test(rxImage) &&
                rxImage.length <= 7 * 1024 * 1024;
            if (!validImage) {
                return res.status(400).json({ error: "This order includes a prescription-only item. Please attach a photo of your prescription." });
            }
        }

        const candidateRows = await findCandidates(lat, lng, radiusKm, lines);
        const candidates = candidateRows.map((r) => r.pharmacy_id);
        const rxStatus = requiresRx ? 'PENDING' : 'NOT_REQUIRED';

        let customerId = null;
        if (req.customer && (await ordersHaveCustomerId())) {
            const exists = await pool.query(`SELECT id FROM customers WHERE id = $1`, [req.customer.id]);
            if (exists.rowCount === 0) {
                return res.status(401).json({ error: 'Account not found. Please log in again.', code: 'invalid_token' });
            }
            customerId = exists.rows[0].id;
        }
        const customerLinked = customerId !== null;

        const params = [lat, lng, JSON.stringify(lines), candidates, requiresRx ? rxImage : null, rxStatus];
        if (customerLinked) params.push(customerId);
        const orderRes = await pool.query(
            `INSERT INTO orders (customer_lat, customer_lng, items, candidate_pharmacy_ids, status, rx_image, rx_status${customerLinked ? ', customer_id' : ''})
             VALUES ($1, $2, $3, $4, 'MATCHING', $5, $6${customerLinked ? ', $7' : ''})
             RETURNING id`,
            params
        );
        const orderId = orderRes.rows[0].id;

        if (candidates.length === 0) {
            await pool.query(`UPDATE orders SET status = 'UNFULFILLABLE', updated_at = NOW() WHERE id = $1`, [orderId]);
            return res.json({ orderId, status: 'UNFULFILLABLE', customerLinked, message: "No pharmacy nearby has your full order in stock." });
        }

        await sendToNextCandidate(orderId);
        res.json({ orderId, status: 'SENT_TO_PHARMACY', candidateCount: candidates.length, customerLinked });
    } catch (err) {
        console.error("Order creation failed:", err);
        res.status(500).json({ error: "Failed to create order." });
    }
});

async function authenticatePharmacy(pharmacyId, apiKey) {
    const resolvedId = await resolvePharmacyId(pharmacyId);
    if (!resolvedId) return { valid: false, resolvedId: null };
    const r = await pool.query(`SELECT id, api_key FROM network_pharmacies WHERE id = $1`, [resolvedId]);
    if (r.rows.length === 0) return { valid: false, resolvedId: null };
    // The key is ALWAYS required (the old code accepted any key outside production).
    if (keysMatch(r.rows[0].api_key, apiKey)) return { valid: true, resolvedId };
    return { valid: false, resolvedId: null };
}

// Polling fallback for the POS order banner. Requires the pharmacy key and never returns the image.
app.get('/api/pharmacy/:pharmacyId/pending-orders', async (req, res) => {
    try {
        const { valid, resolvedId } = await authenticatePharmacy(req.params.pharmacyId, keyFrom(req));
        if (!valid) return res.status(403).json({ ok: false, orders: [] });
        const pending = await pool.query(
            `SELECT * FROM orders WHERE status = 'SENT_TO_PHARMACY' AND current_pharmacy_id = $1 ORDER BY created_at DESC`,
            [resolvedId]
        );
        const orders = pending.rows.map((o) => {
            const deadline = o.offer_deadline ? new Date(o.offer_deadline).getTime() : orderDeadlines.get(o.id);
            const remaining = deadline ? Math.max(1, Math.floor((deadline - Date.now()) / 1000)) : 45;
            return buildOrderPayload(o, o.rx_status, remaining, false);
        });
        res.json({ ok: true, pharmacyId: resolvedId, orders });
    } catch (err) {
        console.error('Failed to fetch pending orders for pharmacy:', err.message);
        res.status(500).json({ ok: false, orders: [] });
    }
});

app.post('/api/orders/:id/verify-rx', async (req, res) => {
    const { id: orderId } = req.params;
    const { pharmacyId, decision } = req.body;
    const apiKey = keyFrom(req);

    if (!['verified', 'rejected'].includes(decision)) {
        return res.status(400).json({ error: "decision must be 'verified' or 'rejected'." });
    }

    try {
        const { valid, resolvedId } = await authenticatePharmacy(pharmacyId, apiKey);
        if (!valid) {
            return res.status(403).json({ error: "Invalid pharmacy credentials." });
        }

        const newStatus = decision === 'verified' ? 'VERIFIED' : 'REJECTED';
        const updated = await pool.query(
            `UPDATE orders SET rx_status = $1, updated_at = NOW()
             WHERE id = $2 AND status = 'SENT_TO_PHARMACY' AND current_pharmacy_id = $3 AND rx_status <> 'NOT_REQUIRED'
             RETURNING id`,
            [newStatus, orderId, resolvedId]
        );
        if (updated.rowCount === 0) {
            const exists = await pool.query(`SELECT 1 FROM orders WHERE id = $1`, [orderId]);
            if (exists.rowCount === 0) return res.status(404).json({ error: "Order not found." });
            return res.status(409).json({ error: "This order is not awaiting your prescription review." });
        }

        res.json({ rxStatus: newStatus });
    } catch (err) {
        console.error("Rx verification failed:", err);
        res.status(500).json({ error: "Failed to record verification." });
    }
});

app.post('/api/orders/:id/respond', async (req, res) => {
    const { id: orderId } = req.params;
    const { pharmacyId, action } = req.body;
    const apiKey = keyFrom(req);

    if (!['accept', 'reject'].includes(action)) {
        return res.status(400).json({ error: "action must be 'accept' or 'reject'." });
    }

    try {
        const { valid, resolvedId } = await authenticatePharmacy(pharmacyId, apiKey);
        if (!valid) {
            return res.status(403).json({ error: "Invalid pharmacy credentials." });
        }

        if (action === 'accept') {
            const claimed = await pool.query(
                `UPDATE orders SET status = 'ACCEPTED', updated_at = NOW()
                 WHERE id = $1 AND status = 'SENT_TO_PHARMACY' AND current_pharmacy_id = $2
                   AND rx_status IN ('NOT_REQUIRED', 'VERIFIED')
                 RETURNING id`,
                [orderId, resolvedId]
            );
            if (claimed.rowCount === 0) {
                const cur = await pool.query(`SELECT status, current_pharmacy_id, rx_status FROM orders WHERE id = $1`, [orderId]);
                const o = cur.rows[0];
                if (!o) return res.status(404).json({ error: "Order not found." });
                if (o.status === 'SENT_TO_PHARMACY' && o.current_pharmacy_id === resolvedId) {
                    return res.status(409).json({ error: "Verify the prescription before accepting this order." });
                }
                return res.status(409).json({ error: "This order is no longer awaiting your response." });
            }
            clearCascadeTimer(orderId);
            console.log(`[CASCADE] Pharmacy ${resolvedId} accepted order ${orderId}.`);
            // Freeze this pharmacy's commission rate on the order (see neon/03_pharmacy_commission.sql).
            // Never block or fail an accepted order over bookkeeping: log it and fix it up later.
            try {
                const c = await pool.query('SELECT status, rate_percent, commission_amount FROM accrue_order_commission($1)', [orderId]);
                const row = c.rows[0];
                if (row && row.status === 'NEEDS_RATE') console.warn(`[COMMISSION] Pharmacy ${resolvedId} has no commission rate set; order ${orderId} flagged NEEDS_RATE.`);
            } catch (commissionErr) {
                console.error(`[COMMISSION] Could not record commission for order ${orderId}:`, commissionErr.message);
            }
            // Delivery: hand the accepted order to the nearest rider (idempotent; never blocks the acceptance).
            deliveryModule.dispatchForOrder(orderId, resolvedId).then((r) => { if (!r || r.ok === false) console.warn('[DELIVERY] dispatch:', r && r.error); }).catch((e) => console.warn('[DELIVERY] dispatch failed:', e.message));
            return res.json({ status: 'ACCEPTED', pharmacyId: resolvedId });
        }

        const advanced = await pool.query(
            `UPDATE orders SET cascade_index = cascade_index + 1, updated_at = NOW()
             WHERE id = $1 AND status = 'SENT_TO_PHARMACY' AND current_pharmacy_id = $2
             RETURNING id`,
            [orderId, resolvedId]
        );
        if (advanced.rowCount === 0) {
            const exists = await pool.query(`SELECT 1 FROM orders WHERE id = $1`, [orderId]);
            if (exists.rowCount === 0) return res.status(404).json({ error: "Order not found." });
            return res.status(409).json({ error: "This order is no longer awaiting your response." });
        }
        clearCascadeTimer(orderId);
        await sendToNextCandidate(orderId);
        res.json({ status: 'REJECTED_ADVANCING' });
    } catch (err) {
        console.error("Order response failed:", err);
        res.status(500).json({ error: "Failed to process response." });
    }
});

app.post('/api/sync/inventory', async (req, res) => {
    const { pharmacyId, items } = req.body;
    const apiKey = req.headers['x-pharmacy-key'];

    if (!pharmacyId || !apiKey) {
        return res.status(401).json({ error: "Missing authentication credentials." });
    }
    if (!UUID_RE.test(String(pharmacyId))) return res.status(403).json({ error: "Invalid Pharmacy ID or API Key." });
    if (Array.isArray(items) && items.length > 20000) return res.status(413).json({ error: "Too many items in one sync." });

    const client = await pool.connect();

    try {
        const authCheck = await client.query(`SELECT id, api_key FROM network_pharmacies WHERE id = $1`, [pharmacyId]);

        if (authCheck.rows.length === 0 || !keysMatch(authCheck.rows[0].api_key, apiKey)) {
            return res.status(403).json({ error: "Invalid Pharmacy ID or API Key." });
        }

        lastSyncedPharmacyId = pharmacyId;

        await client.query('BEGIN');

        if (Array.isArray(items) && items.length > 0) {
            for (const item of items) {
                if (!item || typeof item.name !== "string" || !item.name.trim()) {
                    continue;
                }

                const cleanName = item.name.trim();
                const cleanQuantity = Number.isInteger(item.quantity) && item.quantity >= 0 && item.quantity <= 1000000 ? item.quantity : 0;
                const cleanPrice = Number.isFinite(item.price) && item.price >= 0 ? item.price : 0.0;
                const cleanSchedule = ["OTC", "H", "H1", "X", "Device", "REVIEW"].find((s) => s.toLowerCase() === String(item.schedule || "").trim().toLowerCase()) || null;

                const medRes = await client.query(
                    `INSERT INTO global_medicines (name, price, schedule_class)
                     VALUES ($1, $2, COALESCE($3::text, 'REVIEW'))
                     ON CONFLICT (LOWER(name)) DO UPDATE SET
                         name = EXCLUDED.name,
                         price = CASE WHEN EXCLUDED.price > 0 THEN EXCLUDED.price ELSE global_medicines.price END,
                         schedule_class = stricter_schedule(global_medicines.schedule_class, $3::text)
                     RETURNING id`,
                    [cleanName, cleanPrice, cleanSchedule]
                );
                const medicineId = medRes.rows[0].id;

                await client.query(
                    `INSERT INTO global_inventory (pharmacy_id, medicine_id, quantity, last_synced_at)
                     VALUES ($1, $2, $3, NOW())
                     ON CONFLICT (pharmacy_id, medicine_id)
                     DO UPDATE SET quantity = EXCLUDED.quantity, last_synced_at = NOW()`,
                    [pharmacyId, medicineId, cleanQuantity]
                );
            }
        }

        await client.query(
            `UPDATE network_pharmacies SET last_heartbeat = NOW(), is_online = true WHERE id = $1`,
            [pharmacyId]
        );

        await client.query('COMMIT');

        console.log(`[✓] Synced ${items ? items.length : 0} items for pharmacy ${pharmacyId}`);
        res.json({ success: true, message: "Inventory synced successfully." });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error("Sync error:", error);
        res.status(500).json({ error: "Sync failed" });
    } finally {
        client.release();
    }
});

// ========================================================
// WEBSOCKETS: Persistent Connections
// ========================================================
io.on('connection', (socket) => {
    socket.on('register_spoke', async (data) => {
        const { pharmacyId, apiKey } = data || {};

        try {
            const { valid, resolvedId } = await authenticatePharmacy(pharmacyId, apiKey);

            if (!valid || !resolvedId) {
                console.warn(`[📡] Rejected registration: invalid credentials for ${pharmacyId}.`);
                return socket.disconnect();
            }

            socket.join(`pharmacy_${resolvedId}`);
            if (pharmacyId && pharmacyId !== resolvedId) {
                socket.join(`pharmacy_${pharmacyId}`);
            }
            console.log(`[🔌] Pharmacy ${resolvedId} (spoke: ${pharmacyId}) connected via WebSocket.`);

            const pending = await pool.query(
                `SELECT * FROM orders WHERE status = 'SENT_TO_PHARMACY' AND current_pharmacy_id = $1`,
                [resolvedId]
            );
            for (const o of pending.rows) {
                const deadline = o.offer_deadline ? new Date(o.offer_deadline).getTime() : orderDeadlines.get(o.id);
                const remaining = deadline ? Math.floor((deadline - Date.now()) / 1000) : 45;
                if (remaining > 0) socket.emit('new_order', buildOrderPayload(o, o.rx_status, remaining));
            }
        } catch (err) {
            console.error(`[📡] Registration check failed:`, err.message);
            socket.disconnect();
        }
    });

    socket.on('disconnect', () => {
        console.log(`[x] Client disconnected: ${socket.id}`);
    });
});

// ========================================================
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
app.use('/api/catalog', deliveryModule.catalogRouter);
deliveryModule.startWorker();

// Rider push notifications (FCM). Needs delivery migration 20261022000100 and FIREBASE_SERVICE_ACCOUNT_JSON; does nothing if either is missing.
const { createPushWorker } = require('./routes/pushWorker');
createPushWorker({ deliveryPool }).start();

// Catalog photos: public image URL for the customer app + chemist upload/list/remove in the companion. Needs neon/05_catalog_images.sql.
// Set PUBLIC_HUB_URL (e.g. https://your-hub.example.com) so stored photo links are always the public https address.
const { createCatalogImageModule } = require('./routes/catalogImageRoutes');
const catalogImages = createCatalogImageModule({ pool, authenticatePharmacy });
app.use('/api/catalog/image', catalogImages.publicRouter);
app.use('/api/companion/catalog-images', catalogImages.companionRouter);

// Chemist payouts (claim -> operator pays with a valid UTR -> chemist confirms) + the operator desk page at /admin/desk.
// Needs delivery migration 20261024000000_settlements.sql and DELIVERY_ADMIN_TOKEN (24+ characters) for the operator side.
const { createPayoutModule } = require('./routes/payoutRoutes');
const payouts = createPayoutModule({ dpool: deliveryPool || pool, authenticatePharmacy, io });
app.use('/api/companion/payouts', payouts.chemistRouter);
app.use('/api/admin/payouts', payouts.adminRouter);
app.use('/admin/desk', payouts.deskRouter);


// ========================================================
// COMPANION (chemist PC app): heartbeat, tick-to-pick, release with missing items, dispatch, shelf, settlements.
// Needs neon/04_companion.sql. Declared as `const` after the cascade functions, which call companionModule.onTimeout lazily.
// ========================================================
const { createCompanionModule } = require('./routes/companionRoutes');
companionModule = createCompanionModule({
    pool, dpool: deliveryPool || pool, authenticatePharmacy, deliveryModule, io,
    clearCascadeTimer, armOfferTimer, sendToNextCandidate, buildOrderPayload, toLines,
});
app.use('/api/companion', companionModule.router);
companionModule.startSweeper();

const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => {
    console.log(`SehatWaadi Cloud Hub active on http://localhost:${PORT}`);
});