// Exercises the companion routes against a scripted stand-in for Postgres. It checks the rules (who may dispatch, what is
// recorded, what is cascaded), not the SQL itself, which needs a real database.
const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { createCompanionModule } = require("../hub/routes/companionRoutes");

const PH = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222";
const OID = "33333333-3333-4333-8333-333333333333";
const baseOrder = () => ({ id: OID, status: "SENT_TO_PHARMACY", current_pharmacy_id: PH, rx_status: "NOT_REQUIRED", picking_started_at: new Date(), extension_used: false,
    offer_deadline: new Date(Date.now() + 120000), items: [{ name: "Augmentin 625", quantity: 1, price: 200 }, { name: "Dolo 650", quantity: 2, price: 30 }] });

function harness({ order = baseOrder(), claimRows = 1, dispatchResult = { ok: true } } = {}) {
  const calls = { sql: [], cascade: [], cleared: [], dispatched: [], armed: [], emitted: [] };
  const pool = { async query(sql, params) {
    calls.sql.push({ sql, params });
    if (/SELECT \* FROM orders WHERE id/.test(sql)) return { rows: order ? [order] : [], rowCount: order ? 1 : 0 };
    if (/SET status = 'ACCEPTED'/.test(sql)) return { rows: claimRows ? [{ id: OID }] : [], rowCount: claimRows };
    if (/accrue_order_commission/.test(sql)) return { rows: [{ status: "ACCRUED" }], rowCount: 1 };
    if (/picking_started_at = COALESCE/.test(sql)) return order ? { rows: [order], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (/SET offer_deadline = offer_deadline \+/.test(sql)) return order && !order.extension_used ? { rows: [{ ...order, extension_used: true }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (/SELECT extension_used/.test(sql)) return { rows: order ? [order] : [], rowCount: order ? 1 : 0 };
    if (/SET cascade_index/.test(sql)) return { rows: [{ id: OID }], rowCount: 1 };
    if (/SET status = 'REJECTED'/.test(sql)) return { rows: [{ id: OID }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  const mod = createCompanionModule({
    pool, dpool: pool, io: { to: (room) => ({ emit: (ev, p) => calls.emitted.push({ room, ev, p }) }) },
    authenticatePharmacy: async (id, key) => (key === "good" && id === PH ? { valid: true, resolvedId: PH } : { valid: false, resolvedId: null }),
    deliveryModule: { dispatchForOrder: async (id, ph) => { calls.dispatched.push([id, ph]); return dispatchResult; } },
    clearCascadeTimer: (id) => calls.cleared.push(id), armOfferTimer: (...a) => calls.armed.push(a),
    sendToNextCandidate: async (id) => calls.cascade.push(id), toLines: (i) => i,
    buildOrderPayload: (o, rx, secs) => ({ orderId: o.id, lines: o.items, rxStatus: rx, timeoutSeconds: secs }),
    log: { log() {}, warn() {}, error() {} },
  });
  const app = express(); app.use(express.json()); app.use("/api/companion", mod.router);
  return new Promise((resolve) => { const srv = app.listen(0, () => resolve({ calls, srv, base: `http://127.0.0.1:${srv.address().port}/api/companion` })); });
}
const post = (h, path, body, key = "good") => fetch(h.base + path, { method: "POST", headers: { "content-type": "application/json", "x-pharmacy-key": key }, body: JSON.stringify({ pharmacyId: PH, ...body }) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("a wrong key is refused before anything runs", async () => {
  const h = await harness();
  const r = await post(h, "/heartbeat", {}, "bad");
  assert.equal(r.status, 403); assert.equal(h.calls.sql.length, 0); (h.srv.closeAllConnections(), h.srv.close());
});

test("heartbeat while paused keeps the beat but takes the shop offline", async () => {
  const h = await harness();
  const r = await post(h, "/heartbeat", { paused: true });
  assert.equal(r.status, 200);
  const upd = h.calls.sql.find((c) => /UPDATE network_pharmacies/.test(c.sql));
  assert.deepEqual(upd.params, [PH, false]); (h.srv.closeAllConnections(), h.srv.close());
});

test("dispatch is refused until every line is in the packed list", async () => {
  const h = await harness();
  const r = await post(h, "/orders/" + OID + "/dispatch", { packed: ["augmentin 625"] });
  assert.equal(r.status, 400); assert.equal(r.body.error, "not_all_items_packed"); assert.deepEqual(r.body.notPacked, ["Dolo 650"]);
  assert.equal(h.calls.dispatched.length, 0); (h.srv.closeAllConnections(), h.srv.close());
});

test("dispatch needs the order to be opened (picking started) first", async () => {
  const o = baseOrder(); o.picking_started_at = null;
  const h = await harness({ order: o });
  const r = await post(h, "/orders/" + OID + "/dispatch", { packed: ["Augmentin 625", "Dolo 650"] });
  assert.equal(r.status, 409); assert.equal(r.body.error, "not_picking"); (h.srv.closeAllConnections(), h.srv.close());
});

test("a prescription order cannot be dispatched before verification", async () => {
  const o = baseOrder(); o.rx_status = "PENDING";
  const h = await harness({ order: o });
  const r = await post(h, "/orders/" + OID + "/dispatch", { packed: ["Augmentin 625", "Dolo 650"] });
  assert.equal(r.status, 409); assert.equal(r.body.error, "rx_not_verified"); (h.srv.closeAllConnections(), h.srv.close());
});

test("dispatch of an order held by another pharmacy says ORDER_REASSIGNED", async () => {
  const o = baseOrder(); o.current_pharmacy_id = OTHER;
  const h = await harness({ order: o });
  const r = await post(h, "/orders/" + OID + "/dispatch", { packed: ["Augmentin 625", "Dolo 650"] });
  assert.equal(r.status, 409); assert.equal(r.body.code, "ORDER_REASSIGNED"); assert.equal(h.calls.dispatched.length, 0); (h.srv.closeAllConnections(), h.srv.close());
});

test("losing the race at the database (timeout won) never calls the rider system", async () => {
  const h = await harness({ claimRows: 0 });
  const r = await post(h, "/orders/" + OID + "/dispatch", { packed: ["Augmentin 625", "Dolo 650"] });
  assert.equal(r.status, 409); assert.equal(r.body.code, "ORDER_REASSIGNED");
  assert.equal(h.calls.dispatched.length, 0); assert.equal(h.calls.cleared.length, 0); (h.srv.closeAllConnections(), h.srv.close());
});

test("a good dispatch accepts, freezes commission, clears stale blocks and sends the rider", async () => {
  const h = await harness();
  const r = await post(h, "/orders/" + OID + "/dispatch", { packed: ["augmentin 625", " DOLO 650 "] });
  assert.equal(r.status, 200); assert.equal(r.body.status, "ACCEPTED");
  assert.deepEqual(h.calls.dispatched, [[OID, PH]]); assert.deepEqual(h.calls.cleared, [OID]);
  assert.ok(h.calls.sql.some((c) => /accrue_order_commission/.test(c.sql)));
  const del = h.calls.sql.find((c) => /DELETE FROM pharmacy_item_blocks/.test(c.sql));
  assert.deepEqual(del.params[1], ["augmentin 625", "dolo 650"]); (h.srv.closeAllConnections(), h.srv.close());
});

test("an accepted order survives a failed rider hand-off and tells the app to retry", async () => {
  const h = await harness({ dispatchResult: { ok: false, error: "no_rider_table" } });
  const r = await post(h, "/orders/" + OID + "/dispatch", { packed: ["Augmentin 625", "Dolo 650"] });
  assert.equal(r.status, 200); assert.equal(r.body.dispatch.ok, false); (h.srv.closeAllConnections(), h.srv.close());
});

test("out of stock must name an item from the order", async () => {
  const h = await harness();
  assert.equal((await post(h, "/orders/" + OID + "/release", { reason: "OUT_OF_STOCK", missingItems: [] })).body.error, "missing_items_required");
  assert.equal((await post(h, "/orders/" + OID + "/release", { reason: "OUT_OF_STOCK", missingItems: ["Something else"] })).body.error, "missing_items_required");
  assert.equal(h.calls.cascade.length, 0); (h.srv.closeAllConnections(), h.srv.close());
});

test("out of stock records the block, logs it and cascades to the next pharmacy", async () => {
  const h = await harness();
  const r = await post(h, "/orders/" + OID + "/release", { reason: "OUT_OF_STOCK", missingItems: ["dolo 650"] });
  assert.equal(r.status, 200); assert.deepEqual(r.body.blocked, ["Dolo 650"]);
  assert.deepEqual(h.calls.cascade, [OID]);
  assert.ok(h.calls.sql.some((c) => /INSERT INTO pharmacy_item_blocks/.test(c.sql) && c.params[1] === "dolo 650"));
  assert.ok(h.calls.sql.some((c) => /INSERT INTO order_release_log/.test(c.sql))); (h.srv.closeAllConnections(), h.srv.close());
});

test("a busy release cascades but never blocks items", async () => {
  const h = await harness();
  const r = await post(h, "/orders/" + OID + "/release", { reason: "BUSY" });
  assert.equal(r.status, 200); assert.deepEqual(h.calls.cascade, [OID]);
  assert.ok(!h.calls.sql.some((c) => /INSERT INTO pharmacy_item_blocks/.test(c.sql))); (h.srv.closeAllConnections(), h.srv.close());
});

test("an invalid prescription ends the order instead of passing it on", async () => {
  const h = await harness();
  const r = await post(h, "/orders/" + OID + "/release", { reason: "RX_INVALID" });
  assert.equal(r.status, 200); assert.equal(r.body.status, "REJECTED");
  assert.equal(h.calls.cascade.length, 0);
  assert.ok(h.calls.emitted.some((e) => e.ev === "order_rejected")); (h.srv.closeAllConnections(), h.srv.close());
});

test("extra time can be used once", async () => {
  const h = await harness();
  const first = await post(h, "/orders/" + OID + "/extend", {});
  assert.equal(first.status, 200); assert.equal(h.calls.armed.length, 1); (h.srv.closeAllConnections(), h.srv.close());

  const used = baseOrder(); used.extension_used = true;
  const h2 = await harness({ order: used });
  const second = await post(h2, "/orders/" + OID + "/extend", {});
  assert.equal(second.status, 409); assert.equal(second.body.error, "extension_used"); assert.equal(h2.calls.armed.length, 0); (h2.srv.closeAllConnections(), h2.srv.close());
});

test("opening an order starts the picking clock and re-arms the timer", async () => {
  const h = await harness();
  const r = await post(h, "/orders/" + OID + "/start-picking", {});
  assert.equal(r.status, 200); assert.equal(h.calls.armed.length, 1);
  assert.equal(h.calls.armed[0][0], OID); assert.equal(h.calls.armed[0][1], PH); (h.srv.closeAllConnections(), h.srv.close());
});
