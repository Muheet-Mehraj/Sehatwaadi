// Hub routes for the PC companion app (the chemist's order terminal). Mount in server.js, see INTEGRATION.md.
//
// The chemist's flow is  OFFERED -> PICKING -> dispatch.   The order stays SENT_TO_PHARMACY (so the customer app and the
// cascade engine need no new status) until the chemist has ticked every line and presses Dispatch, which is the moment the
// order becomes ACCEPTED, the commission rate is frozen, and the rider is assigned.
//
// Pharmacy authentication is the existing one: pharmacy id + x-pharmacy-key.
const express = require("express");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const key = (s) => String(s || "").trim().toLowerCase();

function createCompanionModule({
    pool, dpool, authenticatePharmacy, deliveryModule, io,
    clearCascadeTimer, armOfferTimer, sendToNextCandidate, buildOrderPayload, toLines,
    env = process.env, log = console,
}) {
    const PICK_SECONDS = Number(env.PICK_SECONDS || 300);          // preparation time once the chemist opens the order
    const EXTEND_SECONDS = Number(env.PICK_EXTEND_SECONDS || 120); // the one-time "+2 min"
    const BLOCK_HOURS = Number(env.BLOCK_HOURS || 24);             // how long a learned "out of stock" hides an item
    const GRACE_MS = 2000;                                          // a tap that lands this close to the deadline still counts

    const router = express.Router();
    const wrap = (fn) => async (req, res) => {
        try { await fn(req, res); } catch (e) { log.error("[companion]", e.message); res.status(500).json({ ok: false, error: "server" }); }
    };

    // Resolves the pharmacy from the id + key the app sends. Sets req.pharmacyId.
    const auth = async (req, res, next) => {
        const id = (req.body && req.body.pharmacyId) || req.query.pharmacyId || req.headers["x-pharmacy-id"];
        const apiKey = req.headers["x-pharmacy-key"] || (req.body && req.body.apiKey) || "";
        try {
            const { valid, resolvedId } = await authenticatePharmacy(id, apiKey);
            if (!valid) return res.status(403).json({ ok: false, error: "not_authorized" });
            req.pharmacyId = resolvedId;
            next();
        } catch (e) { log.error("[companion] auth", e.message); res.status(500).json({ ok: false, error: "server" }); }
    };
    router.use(auth);

    const bad = (res, status, error, extra = {}) => res.status(status).json({ ok: false, error, ...extra });
    const gone = (res) => bad(res, 409, "order_not_yours", { code: "ORDER_REASSIGNED", message: "This order timed out or was reassigned to another pharmacy." });
    const remainingSeconds = (o) => (o.offer_deadline ? Math.max(0, Math.ceil((new Date(o.offer_deadline).getTime() - Date.now()) / 1000)) : 45);
    const view = (o, includeImage) => ({
        ...buildOrderPayload(o, o.rx_status, remainingSeconds(o), includeImage),
        pickingStarted: Boolean(o.picking_started_at),
        extensionUsed: Boolean(o.extension_used),
        createdAt: o.created_at,
    });

    async function ownOrder(req, res, id) {
        if (!UUID_RE.test(String(id))) { bad(res, 400, "invalid_order_id"); return null; }
        const o = (await pool.query(`SELECT * FROM orders WHERE id = $1`, [id])).rows[0];
        if (!o || String(o.current_pharmacy_id) !== String(req.pharmacyId)) { gone(res); return null; }
        return o;
    }

    // ---- presence: the app calls this every ~30 s. paused=true keeps the heartbeat but takes the shop out of matching.
    router.post("/heartbeat", wrap(async (req, res) => {
        const paused = req.body && req.body.paused === true;
        await pool.query(`UPDATE network_pharmacies SET last_heartbeat = NOW(), is_online = $2 WHERE id = $1`, [req.pharmacyId, !paused]);
        res.json({ ok: true, paused, serverTime: new Date().toISOString() });
    }));

    // ---- orders waiting for this chemist (also what the app polls if the socket drops)
    router.get("/orders", wrap(async (req, res) => {
        const rows = (await pool.query(`SELECT * FROM orders WHERE status = 'SENT_TO_PHARMACY' AND current_pharmacy_id = $1 ORDER BY created_at`, [req.pharmacyId])).rows;
        res.json({ ok: true, orders: rows.map((o) => view(o, false)) });
    }));

    // full order including the prescription image (large, so fetched only when the chemist opens the order)
    router.get("/orders/:id", wrap(async (req, res) => {
        const o = await ownOrder(req, res, req.params.id); if (!o) return;
        if (o.status !== "SENT_TO_PHARMACY") return gone(res);
        res.json({ ok: true, order: view(o, true) });
    }));

    // ---- OFFERED -> PICKING: starts the preparation clock (once; repeated calls keep the same deadline)
    router.post("/orders/:id/start-picking", wrap(async (req, res) => {
        const r = await pool.query(
            `UPDATE orders
                SET offer_deadline = CASE WHEN picking_started_at IS NULL THEN NOW() + ($3::int * INTERVAL '1 second') ELSE offer_deadline END,
                    picking_started_at = COALESCE(picking_started_at, NOW()),
                    updated_at = NOW()
              WHERE id = $1 AND status = 'SENT_TO_PHARMACY' AND current_pharmacy_id = $2
                AND (offer_deadline IS NULL OR offer_deadline > NOW() - ($4::int * INTERVAL '1 millisecond'))
          RETURNING *`, [req.params.id, req.pharmacyId, PICK_SECONDS, GRACE_MS]);
        if (!r.rowCount) { if (!UUID_RE.test(req.params.id)) return bad(res, 400, "invalid_order_id"); return gone(res); }
        const o = r.rows[0];
        armOfferTimer(o.id, req.pharmacyId, Math.max(1000, new Date(o.offer_deadline).getTime() - Date.now()));
        res.json({ ok: true, order: view(o, false) });
    }));

    // ---- one-time extension of the preparation time
    router.post("/orders/:id/extend", wrap(async (req, res) => {
        const r = await pool.query(
            `UPDATE orders SET offer_deadline = offer_deadline + ($3::int * INTERVAL '1 second'), extension_used = true, updated_at = NOW()
              WHERE id = $1 AND status = 'SENT_TO_PHARMACY' AND current_pharmacy_id = $2
                AND picking_started_at IS NOT NULL AND extension_used = false AND offer_deadline > NOW()
          RETURNING *`, [req.params.id, req.pharmacyId, EXTEND_SECONDS]);
        if (!r.rowCount) {
            const o = UUID_RE.test(req.params.id) ? (await pool.query(`SELECT extension_used, current_pharmacy_id, status FROM orders WHERE id = $1`, [req.params.id])).rows[0] : null;
            if (o && String(o.current_pharmacy_id) === String(req.pharmacyId) && o.status === "SENT_TO_PHARMACY" && o.extension_used) return bad(res, 409, "extension_used", { message: "The extra time was already used." });
            return gone(res);
        }
        const o = r.rows[0];
        armOfferTimer(o.id, req.pharmacyId, Math.max(1000, new Date(o.offer_deadline).getTime() - Date.now()));
        res.json({ ok: true, order: view(o, false) });
    }));

    // ---- hand the order back: OUT_OF_STOCK (with the missing items), BUSY, or RX_INVALID.
    //      Only OUT_OF_STOCK feeds learned availability, so a busy or lazy "no" never poisons the stock memory.
    router.post("/orders/:id/release", wrap(async (req, res) => {
        const reason = String((req.body && req.body.reason) || "");
        if (!["OUT_OF_STOCK", "BUSY", "RX_INVALID"].includes(reason)) return bad(res, 400, "invalid_reason");
        const o = await ownOrder(req, res, req.params.id); if (!o) return;
        if (o.status !== "SENT_TO_PHARMACY") return gone(res);

        const lines = toLines(o.items);
        const byKey = new Map(lines.map((l) => [key(l.name), l.name]));
        let missing = [];
        if (reason === "OUT_OF_STOCK") {
            const asked = Array.isArray(req.body.missingItems) ? req.body.missingItems : [];
            missing = [...new Set(asked.map(key))].filter((k) => byKey.has(k));
            if (!missing.length) return bad(res, 400, "missing_items_required", { message: "Say which item is out of stock." });
        }

        if (reason === "RX_INVALID") {
            // An invalid prescription ends the order: it would be just as invalid at the next pharmacy.
            const done = await pool.query(
                `UPDATE orders SET status = 'REJECTED', rx_status = 'REJECTED', offer_deadline = NULL, updated_at = NOW()
                  WHERE id = $1 AND status = 'SENT_TO_PHARMACY' AND current_pharmacy_id = $2 RETURNING id`, [o.id, req.pharmacyId]);
            if (!done.rowCount) return gone(res);
            clearCascadeTimer(o.id);
            await pool.query(`INSERT INTO order_release_log (order_id, pharmacy_id, reason) VALUES ($1, $2, $3)`, [o.id, req.pharmacyId, reason]);
            io.to(`order_${o.id}`).emit("order_rejected", { orderId: o.id, reason });
            return res.json({ ok: true, status: "REJECTED" });
        }

        const advanced = await pool.query(
            `UPDATE orders SET cascade_index = cascade_index + 1, offer_deadline = NULL, updated_at = NOW()
              WHERE id = $1 AND status = 'SENT_TO_PHARMACY' AND current_pharmacy_id = $2 RETURNING id`, [o.id, req.pharmacyId]);
        if (!advanced.rowCount) return gone(res);
        clearCascadeTimer(o.id);

        await pool.query(`INSERT INTO order_release_log (order_id, pharmacy_id, reason, missing_items) VALUES ($1, $2, $3, $4)`,
            [o.id, req.pharmacyId, reason, missing.length ? JSON.stringify(missing.map((k) => byKey.get(k))) : null]);
        for (const k of missing) {
            await pool.query(
                `INSERT INTO pharmacy_item_blocks (pharmacy_id, item_key, item_name, reason, source, order_id, blocked_until)
                 VALUES ($1, $2, $3, 'OUT_OF_STOCK', 'ORDER', $4, NOW() + ($5::int * INTERVAL '1 hour'))
                 ON CONFLICT (pharmacy_id, item_key) DO UPDATE SET blocked_until = EXCLUDED.blocked_until, order_id = EXCLUDED.order_id, source = 'ORDER'`,
                [req.pharmacyId, k, byKey.get(k), o.id, BLOCK_HOURS]);
        }
        await sendToNextCandidate(o.id);
        res.json({ ok: true, status: "RELEASED", blocked: missing.map((k) => byKey.get(k)) });
    }));

    // ---- PICKING -> dispatch. The Hub checks that every line is in the packed list, that the prescription (if any) was
    //      verified and that the order is still this pharmacy's. Whoever reaches the database first wins; the loser gets ORDER_REASSIGNED.
    router.post("/orders/:id/dispatch", wrap(async (req, res) => {
        const o = await ownOrder(req, res, req.params.id); if (!o) return;
        if (o.status !== "SENT_TO_PHARMACY") return gone(res);
        if (!o.picking_started_at) return bad(res, 409, "not_picking", { message: "Open the order and tick the items first." });
        if (!["NOT_REQUIRED", "VERIFIED"].includes(o.rx_status)) return bad(res, 409, "rx_not_verified", { message: "Verify the prescription before dispatching." });

        const lines = toLines(o.items);
        const packed = new Set((Array.isArray(req.body.packed) ? req.body.packed : []).map(key));
        const notPacked = lines.filter((l) => !packed.has(key(l.name))).map((l) => l.name);
        if (notPacked.length) return bad(res, 400, "not_all_items_packed", { notPacked });

        const claimed = await pool.query(
            `UPDATE orders SET status = 'ACCEPTED', packed_at = NOW(), packed_items = $3::jsonb, offer_deadline = NULL, updated_at = NOW()
              WHERE id = $1 AND status = 'SENT_TO_PHARMACY' AND current_pharmacy_id = $2
                AND rx_status IN ('NOT_REQUIRED', 'VERIFIED')
                AND (offer_deadline IS NULL OR offer_deadline > NOW() - ($4::int * INTERVAL '1 millisecond'))
          RETURNING id`, [o.id, req.pharmacyId, JSON.stringify(lines.map((l) => ({ name: l.name, quantity: l.quantity }))), GRACE_MS]);
        if (!claimed.rowCount) return gone(res);
        clearCascadeTimer(o.id);
        log.log(`[CASCADE] Pharmacy ${req.pharmacyId} packed and dispatched order ${o.id}.`);

        try {   // freeze this pharmacy's commission rate on the order; never fail the dispatch over bookkeeping
            const c = await pool.query("SELECT status FROM accrue_order_commission($1)", [o.id]);
            if (c.rows[0] && c.rows[0].status === "NEEDS_RATE") log.warn(`[COMMISSION] Pharmacy ${req.pharmacyId} has no commission rate set; order ${o.id} flagged NEEDS_RATE.`);
        } catch (e) { log.error(`[COMMISSION] Could not record commission for order ${o.id}:`, e.message); }

        // he has the items, so any learned "out of stock" for them is stale
        await pool.query(`DELETE FROM pharmacy_item_blocks WHERE pharmacy_id = $1 AND item_key = ANY($2::text[])`, [req.pharmacyId, lines.map((l) => key(l.name))]).catch(() => {});

        let dispatch;
        try { dispatch = await deliveryModule.dispatchForOrder(o.id, req.pharmacyId); } catch (e) { dispatch = { ok: false, error: e.message }; }
        // ACCEPTED is committed either way. If the rider hand-off failed the app shows a retry, which calls POST /api/delivery/dispatch.
        res.json({ ok: true, status: "ACCEPTED", dispatch });
    }));

    // ---- virtual shelf: items hidden for this pharmacy, and the manual toggle
    router.get("/blocks", wrap(async (req, res) => {
        const rows = (await pool.query(
            `SELECT item_key, item_name, reason, source, blocked_until, created_at FROM pharmacy_item_blocks
              WHERE pharmacy_id = $1 AND blocked_until > NOW() ORDER BY created_at DESC`, [req.pharmacyId])).rows;
        res.json({ ok: true, blocks: rows });
    }));
    router.post("/blocks/restock", wrap(async (req, res) => {
        const k = key(req.body && req.body.itemKey);
        if (!k) return bad(res, 400, "invalid_item");
        const r = await pool.query(`DELETE FROM pharmacy_item_blocks WHERE pharmacy_id = $1 AND item_key = $2`, [req.pharmacyId, k]);
        res.json({ ok: true, removed: r.rowCount });
    }));
    router.post("/blocks/block", wrap(async (req, res) => {
        const name = String((req.body && req.body.name) || "").trim().slice(0, 200);
        if (!name) return bad(res, 400, "invalid_item");
        await pool.query(
            `INSERT INTO pharmacy_item_blocks (pharmacy_id, item_key, item_name, reason, source, blocked_until)
             VALUES ($1, $2, $3, 'OUT_OF_STOCK', 'MANUAL', NOW() + INTERVAL '10 years')
             ON CONFLICT (pharmacy_id, item_key) DO UPDATE SET blocked_until = EXCLUDED.blocked_until, source = 'MANUAL'`, [req.pharmacyId, key(name), name]);
        res.json({ ok: true });
    }));

    // ---- per-order settlement lines (finished orders only). The figures are the Hub's; the app only displays them.
    router.get("/settlements", wrap(async (req, res) => {
        const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
        const rows = (await dpool.query(
            `SELECT d.id, d.order_id, d.status, d.payment_mode, d.order_subtotal, d.delivery_fee, d.platform_commission, d.pharmacy_net_amount,
                    d.created_at, d.updated_at
               FROM public.deliveries d
              WHERE d.pharmacy_id = $1 AND d.status IN ('DELIVERED', 'RETURNED') AND d.updated_at > NOW() - ($2::int * INTERVAL '1 day')
              ORDER BY d.updated_at DESC LIMIT 500`, [req.pharmacyId, days])).rows;
        res.json({ ok: true, days, settlements: rows });
    }));

    // ---- called by the cascade timer and by the sweeper when a pharmacy ran out of time
    async function onTimeout(orderId, pharmacyId) {
        try { await pool.query(`INSERT INTO order_release_log (order_id, pharmacy_id, reason) VALUES ($1, $2, 'TIMEOUT')`, [orderId, pharmacyId]); } catch (e) { log.warn("[companion] timeout log", e.message); }
        io.to(`pharmacy_${pharmacyId}`).emit("order_withdrawn", { orderId, reason: "TIMEOUT" });
    }

    // Restart-proof timeout: any order whose persisted deadline has passed is advanced, even if the in-memory timer was lost.
    async function sweep() {
        const rows = (await pool.query(
            `SELECT id, current_pharmacy_id FROM orders WHERE status = 'SENT_TO_PHARMACY' AND offer_deadline IS NOT NULL
                AND offer_deadline < NOW() - INTERVAL '3 seconds' LIMIT 50`)).rows;
        for (const r of rows) {
            const adv = await pool.query(
                `UPDATE orders SET cascade_index = cascade_index + 1, offer_deadline = NULL, updated_at = NOW()
                  WHERE id = $1 AND status = 'SENT_TO_PHARMACY' AND current_pharmacy_id = $2 AND offer_deadline < NOW() - INTERVAL '3 seconds' RETURNING id`,
                [r.id, r.current_pharmacy_id]);
            if (!adv.rowCount) continue;
            clearCascadeTimer(r.id);
            await onTimeout(r.id, r.current_pharmacy_id);
            await sendToNextCandidate(r.id);
        }
    }
    let timer = null;
    const startSweeper = (ms = Number(env.SWEEP_MS || 10000)) => {
        if (!timer) { timer = setInterval(() => sweep().catch((e) => log.warn("[companion] sweep", e.message)), ms); timer.unref && timer.unref(); }
        return () => { clearInterval(timer); timer = null; };
    };

    return { router, sweep, startSweeper, onTimeout };
}

module.exports = { createCompanionModule };
