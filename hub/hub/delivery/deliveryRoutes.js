// Hub <-> delivery database bridge. Mount in hub/server.js (see INTEGRATION.md).
//
// The delivery database is the Postgres that holds the rider/delivery migrations (your Supabase project, or the same Neon DB).
// The Hub connects to it as a privileged role (postgres / service role) so the functions treat it as the "service key".
// Pharmacies authenticate with their existing x-pharmacy-key; customers with the existing customer session.
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = ["DISPATCHED", "ACCEPTED", "ARRIVED_AT_PHARMACY", "PICKED_UP", "RETURNING_TO_PHARMACY"];
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length > 0 && crypto.timingSafeEqual(sha(a), sha(b));

function createDeliveryModule({ hubPool, deliveryPool, authenticatePharmacy, getCustomerId, optionalCustomer, io, log = console, env = process.env }) {
  const sameDb = !deliveryPool || deliveryPool === hubPool;
  const dpool = deliveryPool || hubPool;
  const call = async (fn, sig, params = []) => (await dpool.query(`SELECT public.${fn}(${sig}) AS r`, params)).rows[0].r;
  const statusMap = (() => { try { return JSON.parse(env.DELIVERY_ORDER_STATUS_MAP || ""); } catch { return { PICKED_UP: "OUT_FOR_DELIVERY", DELIVERED: "DELIVERED", RETURNED: "RETURNED" }; } })();

  // ---------- order bridge: Hub order (Neon) -> delivery database ----------
  let orderCols = null;
  async function deliveryOrderColumns() {
    if (!orderCols) orderCols = new Set((await dpool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='orders'`)).rows.map((r) => r.column_name));
    return orderCols;
  }
  async function copyOrder(row) {
    if (sameDb) return;
    const cols = await deliveryOrderColumns();
    const keys = Object.keys(row).filter((k) => cols.has(k) && row[k] !== undefined);
    const vals = keys.map((k) => (row[k] !== null && typeof row[k] === "object" && !(row[k] instanceof Date) ? JSON.stringify(row[k]) : row[k]));
    const sets = keys.filter((k) => k !== "id").map((k) => `"${k}" = EXCLUDED."${k}"`).join(", ");
    await dpool.query(`INSERT INTO public.orders (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) ON CONFLICT (id) DO UPDATE SET ${sets}`, vals);
  }

  // ---- order enrichment: the Hub's orders carry items + coordinates only, so the total and the customer's contact details are derived here ----
  const parseItems = (v) => { try { const x = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(x) ? x : []; } catch { return []; } };
  const itemsTotal = (items) => {
    let t = 0;
    for (const i of items) { const price = Number(i && (i.price ?? i.unit_price ?? i.selling_price)), q = Number(i && (i.quantity ?? i.qty ?? 1)); if (!Number.isFinite(price) || !Number.isFinite(q)) return null; t += price * q; }
    return items.length && t > 0 ? Math.round(t * 100) / 100 : null;
  };
  const pick = (a, keys) => keys.map((k) => a && a[k]).find((v) => typeof v === "string" && v.trim()) || null;
  async function customerContact(o) {
    if (!o.customer_id) return {};
    try {
      const c = (await hubPool.query(`SELECT name, phone, addresses FROM customers WHERE id = $1`, [o.customer_id])).rows[0];
      if (!c) return {};
      let list = c.addresses; try { if (typeof list === "string") list = JSON.parse(list); } catch { list = []; }
      list = Array.isArray(list) ? list : [];
      const near = (a) => a && Math.abs(Number(a.lat ?? a.latitude) - o.customer_lat) < 1e-4 && Math.abs(Number(a.lng ?? a.longitude ?? a.lon) - o.customer_lng) < 1e-4;
      const a = list.find(near) || list.find((x) => x && x.isDefault) || list[0];
      const text = typeof a === "string" ? a : a ? [pick(a, ["house", "flat", "line1", "address", "street"]), pick(a, ["line2", "area", "locality"]), pick(a, ["city", "pincode"])].filter(Boolean).join(", ") || pick(a, ["label", "name"]) : null;
      return { contact_name: c.name || null, contact_phone: c.phone || null, delivery_address: text || null, delivery_landmark: a && typeof a === "object" ? pick(a, ["landmark"]) : null };
    } catch (e) { log.warn("[delivery] customer lookup failed:", e.message); return {}; }   // never block a dispatch over contact details
  }

  // The customer app sends the address text / landmark for THIS order (saved in the Hub database). Created on first use.
  let infoReady = null;
  const ensureInfoTable = () => (infoReady ||= hubPool.query(`CREATE TABLE IF NOT EXISTS order_delivery_info (order_id uuid PRIMARY KEY, address text, landmark text, updated_at timestamptz DEFAULT now())`).catch((e) => { infoReady = null; throw e; }));
  async function orderInfo(orderId) {
    try { await ensureInfoTable(); return (await hubPool.query(`SELECT address, landmark FROM order_delivery_info WHERE order_id = $1`, [orderId])).rows[0] || {}; }
    catch (e) { log.warn("[delivery] order info unavailable:", e.message); return {}; }
  }

  async function dispatchForOrder(orderId, pharmacyId) {
    if (!UUID_RE.test(String(orderId))) return { ok: false, error: "invalid_order_id" };
    const o = (await hubPool.query(`SELECT * FROM orders WHERE id = $1`, [orderId])).rows[0];
    if (!o) return { ok: false, error: "order_not_found" };
    if (pharmacyId && String(o.current_pharmacy_id) !== String(pharmacyId)) return { ok: false, error: "not_authorized" };
    if (o.status !== "ACCEPTED") return { ok: false, error: "order_not_accepted" };
    const items = parseItems(o.items);
    const stated = [o.subtotal, o.grand_total, o.total_amount, o.order_total].map(Number).find((n) => Number.isFinite(n) && n >= 0);
    const sub = stated ?? itemsTotal(items);
    if (sub == null) return { ok: false, error: "order_amount_missing" };
    const mode = o.payment_mode || env.DELIVERY_DEFAULT_PAYMENT_MODE || "CASH";   // the customer app has no online payment yet: cash on delivery
    const [contact, info] = await Promise.all([customerContact(o), orderInfo(o.id)]);
    await copyOrder({ ...o, items, subtotal: sub, payment_mode: mode, pharmacy_id: o.pharmacy_id || o.current_pharmacy_id, ...contact,
      delivery_address: info.address || contact.delivery_address || null, delivery_landmark: info.landmark || contact.delivery_landmark || null });
    return call("dispatch_order", "$1::uuid,$2::numeric,$3,$4::uuid", [orderId, sub, mode, o.current_pharmacy_id]);
  }


  // ---------- one active order per customer (Rapido style) ----------
  // A customer can place a new order only when the previous one is delivered, cancelled, failed, or has expired.
  const ACTIVE_ORDER = ["MATCHING", "SENT_TO_PHARMACY", "ACCEPTED", "OUT_FOR_DELIVERY"];
  const DONE_DELIVERY = ["DELIVERED", "RETURNED", "CANCELLED"];
  const CANCELLABLE_DELIVERY = ["DISPATCHED", "ACCEPTED", "ARRIVED_AT_PHARMACY"];   // anything later means the rider already has the medicines
  const ACTIVE_HOURS = Math.max(1, Math.round(Number(env.ACTIVE_ORDER_MAX_HOURS) || 3));   // a stuck order never locks a customer out for good
  const customerIdOf = (req) => (getCustomerId ? getCustomerId(req) : req.customer && (req.customer.id || req.customer.customerId));

  async function latestDelivery(orderId) {
    try { return (await dpool.query(`SELECT id, status FROM public.deliveries WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, [orderId])).rows[0] || null; }
    catch { return null; }   // no delivery information: fall back to the order's own status
  }
  async function findActiveOrder(customerId) {
    const rows = (await hubPool.query(
      `SELECT id, status, created_at FROM orders WHERE customer_id = $1 AND status = ANY($2::text[]) AND created_at > now() - make_interval(hours => $3) ORDER BY created_at DESC LIMIT 5`,
      [customerId, ACTIVE_ORDER, ACTIVE_HOURS])).rows;
    for (const o of rows) {
      const d = await latestDelivery(o.id);
      if (d && DONE_DELIVERY.includes(d.status)) continue;   // finished (or cancelled by the pharmacy) even if the Hub's order status lags behind
      return { id: o.id, status: o.status, deliveryStatus: d ? d.status : null, createdAt: o.created_at };
    }
    return null;
  }
  // Mounted in front of POST /api/orders/create (see apply-delivery-patch.js).
  async function activeOrderGuard(req, res, next) {
    const cid = customerIdOf(req);
    if (!cid) return next();
    try {
      const a = await findActiveOrder(cid);
      if (!a) return next();
      return res.status(409).json({ ok: false, code: "ACTIVE_ORDER", orderId: a.id, status: a.status, error: "You have an ongoing order. Please wait for it to be completed before placing a new one." });
    } catch (e) { log.warn("[delivery] active-order check failed:", e.message); return next(); }   // never block ordering because the check itself failed
  }

  const router = express.Router();
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { log.error("[delivery]", e.message); res.status(500).json({ ok: false, error: "server" }); } };
  const failStatus = { not_authorized: 403, order_not_found: 404, delivery_not_found: 404, invalid_order_id: 400 };
  const send = (res, r) => res.status(r && r.ok === false ? failStatus[r.error] || 409 : 200).json(r);

  // ---------- pharmacy side (x-pharmacy-key) ----------
  async function pharmacyOwnsDelivery(req, res) {
    const { deliveryId } = req.params;
    if (!UUID_RE.test(deliveryId)) { res.status(400).json({ ok: false, error: "invalid_id" }); return null; }
    const d = (await dpool.query(`SELECT id, pharmacy_id, order_id FROM public.deliveries WHERE id = $1`, [deliveryId])).rows[0];
    if (!d) { res.status(404).json({ ok: false, error: "delivery_not_found" }); return null; }
    const key = req.headers["x-pharmacy-key"] || (req.body && req.body.apiKey) || "";
    const { valid, resolvedId } = await authenticatePharmacy(d.pharmacy_id, key);
    if (!valid || String(resolvedId) !== String(d.pharmacy_id)) { res.status(403).json({ ok: false, error: "not_authorized" }); return null; }
    return d;
  }

  router.post("/dispatch", wrap(async (req, res) => {
    const { pharmacyId, orderId } = req.body || {};
    const { valid, resolvedId } = await authenticatePharmacy(pharmacyId, req.headers["x-pharmacy-key"] || req.body.apiKey || "");
    if (!valid) return res.status(403).json({ ok: false, error: "not_authorized" });
    send(res, await dispatchForOrder(orderId, resolvedId));
  }));

  router.get("/pharmacy/:pharmacyId", wrap(async (req, res) => {
    const { valid, resolvedId } = await authenticatePharmacy(req.params.pharmacyId, req.headers["x-pharmacy-key"] || "");
    if (!valid) return res.status(403).json({ ok: false, deliveries: [] });
    const listSql = (extra) =>
      `SELECT d.id, d.order_id, d.status, d.rider_id, d.order_subtotal, d.delivery_fee, d.platform_commission, d.pharmacy_net_amount,
              d.issue_type, d.issue_notes, d.issue_reported_at, d.payment_mode${extra},
              CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object('id', r.id, 'full_name', r.full_name, 'phone', r.phone,
                   'vehicle_number', r.vehicle_number, 'last_lat', r.last_lat, 'last_lng', r.last_lng) END AS riders
         FROM public.deliveries d LEFT JOIN public.riders r ON r.id = d.rider_id
        WHERE d.pharmacy_id = $1 AND d.status = ANY($2::text[]) ORDER BY d.created_at DESC`;
    // OFFER dispatch: also say where the rider search is (how many riders are being asked right now, and whether every round found nobody).
    // Falls back to the original query if the offer-dispatch migration has not been applied yet, so deploying the Hub first can never break this list.
    let rows;
    try {
      rows = (await dpool.query(listSql(`, d.dispatch_round, d.dispatch_exhausted_at,
              (SELECT count(*)::int FROM public.delivery_offers o WHERE o.delivery_id = d.id AND o.status = 'OFFERED' AND o.expires_at > now()) AS live_offers`), [resolvedId, LIVE])).rows;
    } catch (e) {
      if (e.code !== "42703" && e.code !== "42P01") throw e;
      rows = (await dpool.query(listSql(""), [resolvedId, LIVE])).rows;
    }
    res.json({ ok: true, deliveries: rows });
  }));

  router.get("/:deliveryId/pickup-qr", wrap(async (req, res) => { const d = await pharmacyOwnsDelivery(req, res); if (d) send(res, await call("get_pickup_qr", "$1::uuid", [d.id])); }));
  router.get("/:deliveryId/return-qr", wrap(async (req, res) => { const d = await pharmacyOwnsDelivery(req, res); if (d) send(res, await call("get_return_qr", "$1::uuid", [d.id])); }));
  router.post("/:deliveryId/reassign", wrap(async (req, res) => { const d = await pharmacyOwnsDelivery(req, res); if (d) send(res, await call("reassign_delivery", "$1::uuid,$2", [d.id, String(req.body.reason || "REASSIGNED_BY_PHARMACY").slice(0, 80)])); }));
  router.post("/:deliveryId/return", wrap(async (req, res) => { const d = await pharmacyOwnsDelivery(req, res); if (d) send(res, await call("initiate_return", "$1::uuid,$2", [d.id, String(req.body.reason || "CUSTOMER_UNREACHABLE").slice(0, 80)])); }));
  router.post("/:deliveryId/cancel", wrap(async (req, res) => { const d = await pharmacyOwnsDelivery(req, res); if (d) send(res, await call("cancel_delivery", "$1::uuid,$2", [d.id, String(req.body.reason || "CANCELLED_BY_PHARMACY").slice(0, 80)])); }));

  // ---------- customer side (existing customer session) ----------
  const customerOnly = [optionalCustomer || ((req, res, next) => next())];
  async function customerOrder(req, res) {
    const cid = getCustomerId ? getCustomerId(req) : req.customer && (req.customer.id || req.customer.customerId);
    if (!cid) { res.status(401).json({ ok: false, error: "not_authenticated" }); return null; }
    if (!UUID_RE.test(req.params.orderId)) { res.status(400).json({ ok: false, error: "invalid_id" }); return null; }
    const o = (await hubPool.query(`SELECT id, customer_id FROM orders WHERE id = $1`, [req.params.orderId])).rows[0];
    if (!o || String(o.customer_id) !== String(cid)) { res.status(404).json({ ok: false, error: "order_not_found" }); return null; }
    return o;
  }
  router.get("/by-order/:orderId", customerOnly, wrap(async (req, res) => {
    const o = await customerOrder(req, res); if (!o) return;
    const d = (await dpool.query(
      `SELECT d.status, d.dropoff_lat, d.dropoff_lng, r.full_name, r.vehicle_type, r.last_lat, r.last_lng, r.last_seen_at
         FROM public.deliveries d LEFT JOIN public.riders r ON r.id = d.rider_id WHERE d.order_id = $1 ORDER BY d.created_at DESC LIMIT 1`, [o.id])).rows[0];
    if (!d) return res.json({ ok: true, delivery: null });
    const live = d.status === "PICKED_UP";
    res.json({ ok: true, delivery: { status: d.status, rider: d.full_name ? { firstName: String(d.full_name).split(" ")[0], vehicleType: d.vehicle_type,
      lat: live ? d.last_lat : null, lng: live ? d.last_lng : null, updatedAt: live ? d.last_seen_at : null } : null } });
  }));
  router.post("/by-order/:orderId/address", customerOnly, wrap(async (req, res) => {
    const o = await customerOrder(req, res); if (!o) return;
    const clean = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200) : "") || null;
    const b = req.body || {};
    const address = [clean(b.label), clean(b.line)].filter(Boolean).join(" - ") || null, landmark = clean(b.landmark);
    if (!address && !landmark) return res.status(400).json({ ok: false, error: "empty_address" });
    await ensureInfoTable();
    await hubPool.query(`INSERT INTO order_delivery_info (order_id, address, landmark) VALUES ($1,$2,$3) ON CONFLICT (order_id) DO UPDATE SET address = EXCLUDED.address, landmark = EXCLUDED.landmark, updated_at = now()`, [o.id, address, landmark]);
    res.json({ ok: true });
  }));
  router.get("/my-active-order", customerOnly, wrap(async (req, res) => {
    const cid = customerIdOf(req);
    if (!cid) return res.status(401).json({ ok: false, error: "not_authenticated" });
    res.set("Cache-Control", "no-store").json({ ok: true, order: await findActiveOrder(cid) });
  }));
  // The customer may cancel until the rider has picked the order up.
  router.post("/by-order/:orderId/cancel", customerOnly, wrap(async (req, res) => {
    const o = await customerOrder(req, res); if (!o) return;
    const cur = (await hubPool.query(`SELECT status FROM orders WHERE id = $1`, [o.id])).rows[0];
    if (!cur || cur.status !== "ACCEPTED") return res.status(409).json({ ok: false, code: "NOT_CANCELLABLE", error: "This order can't be cancelled now." });
    const d = await latestDelivery(o.id);
    if (d) {
      if (DONE_DELIVERY.includes(d.status)) return res.status(409).json({ ok: false, code: "NOT_CANCELLABLE", error: "This order can't be cancelled now." });
      if (!CANCELLABLE_DELIVERY.includes(d.status)) return res.status(409).json({ ok: false, code: "TOO_LATE", error: "Your rider has already picked up your order, so it can't be cancelled." });
      const r = await call("cancel_delivery", "$1::uuid,$2", [d.id, "CUSTOMER_CANCELLED"]);
      if (r && r.ok === false) return res.status(409).json({ ok: false, code: "NOT_CANCELLABLE", error: "This order can't be cancelled now." });
    }
    await hubPool.query(`UPDATE orders SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1 AND status = 'ACCEPTED'`, [o.id]);
    res.json({ ok: true });
  }));
  router.get("/by-order/:orderId/otp", customerOnly, wrap(async (req, res) => {
    const o = await customerOrder(req, res); if (!o) return;
    const d = (await dpool.query(`SELECT status FROM public.deliveries WHERE order_id = $1 AND status IN ('ACCEPTED','ARRIVED_AT_PHARMACY','PICKED_UP') LIMIT 1`, [o.id])).rows[0];
    if (!d) return res.status(409).json({ ok: false, error: "no_active_delivery" });
    send(res, await call("get_delivery_otp", "$1::uuid", [o.id]));
  }));


  // ---------- public catalog (home screen shelves) ----------
  const CATEGORIES = [
    { key: "pain-fever", name: "Pain & Fever", icon: "🌡️", color: "#FFE9E3", keywords: ["paracetamol", "crocin", "dolo", "ibuprofen", "diclofenac", "combiflam", "aspirin", "calpol"] },
    { key: "cold-cough", name: "Cold & Cough", icon: "🤧", color: "#E7F1FF", keywords: ["cough", "cold", "cetirizine", "levocet", "vicks", "benadryl", "sinarest", "chlorpheniramine", "allegra"] },
    { key: "digestive", name: "Digestive Care", icon: "🍃", color: "#E9F7EC", keywords: ["antacid", "pantoprazole", "omeprazole", "digene", "eno", "gelusil", "ors", "domperidone", "loperamide", "pudin"] },
    { key: "vitamins", name: "Vitamins", icon: "🌿", color: "#FFF6D9", keywords: ["vitamin", "limcee", "calcium", "zinc", "multivit", "becosules", "shelcal", "iron", "omega"] },
    { key: "skin", name: "Skin & Hair", icon: "🧴", color: "#FDE8F3", keywords: ["cream", "ointment", "lotion", "soap", "shampoo", "betadine", "clotrimazole", "calamine", "moisturi"] },
    { key: "first-aid", name: "First Aid", icon: "🩹", color: "#FFECEC", keywords: ["bandage", "dettol", "cotton", "gauze", "plaster", "antiseptic", "savlon", "band-aid", "crepe"] },
    { key: "diabetes", name: "Diabetes Care", icon: "🩸", color: "#EAEAFE", keywords: ["metformin", "glucometer", "glucose", "insulin", "glimepiride", "test strip", "diabet"] },
    { key: "devices", name: "Health Devices", icon: "🩺", color: "#E3F6F8", keywords: ["thermometer", "oximeter", "nebuli", "bp monitor", "blood pressure", "steam", "mask", "sanitizer"] },
    { key: "baby", name: "Baby & Mom", icon: "🍼", color: "#FFF0E0", keywords: ["baby", "gripe", "diaper", "cerelac", "lactogen", "pregnan", "folic"] },
    { key: "herbal", name: "Kashmiri Herbal", icon: "🏔️", color: "#EFF7E4", keywords: ["himalaya", "dabur", "herbal", "ayurved", "honey", "saffron", "kesar", "chyawan", "ashwagandha", "tulsi", "giloy"] },
  ];
  const SHELF = Math.min(60, Number(env.CATALOG_SHELF_SIZE) || 24);   // items per category on the home screen
  let hasImage = null;
  const cache = new Map();
  const cached = async (key, ttlMs, fn) => { const hit = cache.get(key); if (hit && Date.now() - hit.t < ttlMs) return hit.v; const v = await fn(); cache.set(key, { t: Date.now(), v }); return v; };
  async function imageColumn() {
    if (hasImage === null) hasImage = (await hubPool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'global_medicines' AND column_name = 'image_url' LIMIT 1`)).rowCount > 0;
    return hasImage;
  }
  const like = (k) => `%${String(k).replace(/[\\%_]/g, "\\$&")}%`;
  async function shelf(keywords, limit) {
    const img = (await imageColumn()) ? "image_url" : "NULL::text AS image_url";
    return (await hubPool.query(`SELECT id, name, price, schedule_class, ${img} FROM global_medicines WHERE name ILIKE ANY($1::text[]) ORDER BY name ASC LIMIT $2`, [keywords.map(like), limit])).rows;
  }
  const catalog = express.Router();
  catalog.get("/home", wrap(async (req, res) => {
    const out = await cached("home", 60000, async () => {
      const img = (await imageColumn()) ? "image_url" : "NULL::text AS image_url";
      const essentials = (await hubPool.query(`SELECT id, name, price, schedule_class, ${img} FROM global_medicines WHERE UPPER(COALESCE(schedule_class,'OTC')) NOT IN ('H','H1','X') ORDER BY name ASC LIMIT ${SHELF}`)).rows;
      const categories = [];
      for (const c of CATEGORIES) categories.push({ key: c.key, name: c.name, icon: c.icon, color: c.color, items: await shelf(c.keywords, SHELF) });
      return { ok: true, essentials, categories };
    });
    res.set("Cache-Control", "public, max-age=30").json(out);
  }));
  catalog.get("/category/:key", wrap(async (req, res) => {
    const c = CATEGORIES.find((x) => x.key === req.params.key);
    if (!c) return res.status(404).json({ ok: false, error: "unknown_category" });
    const out = await cached(`cat:${c.key}`, 60000, async () => ({ ok: true, category: { key: c.key, name: c.name, icon: c.icon, color: c.color }, items: await shelf(c.keywords, 40) }));
    res.set("Cache-Control", "public, max-age=30").json(out);
  }));


  // ---------- product details + strict substitutes ----------
  // Substitutes are shown ONLY when: both medicines are in OUR catalog, the salts AND strengths are identical, a source and a
  // verification date are recorded, both have a pack size, and the substitute is genuinely cheaper per unit. Prices are always OUR catalog prices.
  let detailTables = null;
  const ensureDetailTables = () => (detailTables ||= hubPool.query(`
    CREATE TABLE IF NOT EXISTS medicine_details (
      medicine_id uuid PRIMARY KEY, manufacturer text, unit_count int CHECK (unit_count > 0), unit_label text DEFAULT 'Units',
      mrp numeric CHECK (mrp >= 0), composition jsonb NOT NULL DEFAULT '[]', images jsonb NOT NULL DEFAULT '[]',
      highlights jsonb NOT NULL DEFAULT '[]', ingredients jsonb NOT NULL DEFAULT '[]', key_uses jsonb NOT NULL DEFAULT '[]',
      how_to_use jsonb NOT NULL DEFAULT '[]', safety jsonb NOT NULL DEFAULT '[]', storage text, regulatory_status text,
      content_source text, updated_at timestamptz DEFAULT now());
    CREATE TABLE IF NOT EXISTS medicine_substitutes (
      medicine_id uuid NOT NULL, substitute_id uuid NOT NULL, source_url text NOT NULL, verified_on date NOT NULL, verified_by text NOT NULL,
      PRIMARY KEY (medicine_id, substitute_id), CHECK (medicine_id <> substitute_id));`).catch((e) => { detailTables = null; throw e; }));

  const STRENGTH_RE = /^(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml|iu|%)$/i;
  const saltKey = (c) => {
    const m = STRENGTH_RE.exec(String((c && c.strength) || "").trim());
    const salt = String((c && c.salt) || "").toLowerCase().replace(/\s+/g, " ").trim();
    return salt && m ? `${salt}|${Number(m[1])}${m[2].toLowerCase()}` : null;
  };
  const sameComposition = (a, b) => {
    const ka = (Array.isArray(a) ? a : []).map(saltKey), kb = (Array.isArray(b) ? b : []).map(saltKey);
    if (!ka.length || ka.length !== kb.length || ka.includes(null) || kb.includes(null)) return false;   // unknown strength = no match
    const sb = [...kb].sort(); return [...ka].sort().every((k, i) => k === sb[i]);
  };
  const httpsImages = (imgs, fallback) => {
    const list = (Array.isArray(imgs) ? imgs : []).map((i) => (typeof i === "string" ? { url: i } : i)).filter((i) => i && typeof i.url === "string" && /^https:\/\//i.test(i.url)).slice(0, 6)
      .map((i) => ({ url: i.url, caption: typeof i.caption === "string" ? i.caption.slice(0, 60) : null }));
    return list.length ? list : (fallback && /^https:\/\//i.test(fallback) ? [{ url: fallback, caption: null }] : []);
  };
  const perUnit = (price, units) => (Number(price) > 0 && Number(units) > 0 ? Math.round((Number(price) / Number(units)) * 100) / 100 : null);
  const shape = (m, d) => {
    const price = Number(m.price) || 0, mrp = d && d.mrp != null ? Number(d.mrp) : null;
    return { id: m.id, name: m.name, price, mrp: mrp && mrp > price ? mrp : null, discountPercent: mrp && mrp > price ? Math.round((1 - price / mrp) * 100) : 0,
      scheduleClass: m.schedule_class || null, manufacturer: (d && d.manufacturer) || null, unitCount: (d && d.unit_count) || null, unitLabel: (d && d.unit_label) || "Units",
      pricePerUnit: perUnit(price, d && d.unit_count), composition: (d && d.composition) || [], images: httpsImages(d && d.images, m.image_url),
      highlights: (d && d.highlights) || [], ingredients: (d && d.ingredients) || [], keyUses: (d && d.key_uses) || [], howToUse: (d && d.how_to_use) || [],
      safety: (d && d.safety) || [], storage: (d && d.storage) || null, regulatoryStatus: (d && d.regulatory_status) || null, contentSource: (d && d.content_source) || null };
  };
  async function loadMedicine(id) {
    const img = (await imageColumn()) ? "image_url" : "NULL::text AS image_url";
    const m = (await hubPool.query(`SELECT id, name, price, schedule_class, ${img} FROM global_medicines WHERE id = $1`, [id])).rows[0];
    if (!m) return null;
    const d = (await hubPool.query(`SELECT * FROM medicine_details WHERE medicine_id = $1`, [id])).rows[0] || null;
    return { m, d };
  }
  async function bestSubstitute(orig) {
    const base = shape(orig.m, orig.d);
    if (!base.pricePerUnit || !base.composition.length) return null;
    const rows = (await hubPool.query(`SELECT substitute_id, source_url, verified_on, verified_by FROM medicine_substitutes WHERE medicine_id = $1 AND source_url <> '' AND verified_by <> ''`, [orig.m.id])).rows;
    let best = null;
    for (const r of rows) {
      const sub = await loadMedicine(r.substitute_id); if (!sub) continue;
      const s = shape(sub.m, sub.d);
      if (!sameComposition(base.composition, s.composition) || !s.pricePerUnit) continue;   // exact salts + strengths
      const rawBase = base.price / base.unitCount, rawSub = s.price / s.unitCount;
      if (!(rawSub < rawBase)) continue;                                                      // and truly cheaper per unit
      const savingsPercent = Math.floor(((rawBase - rawSub) / rawBase) * 1000) / 10;
      if (!best || savingsPercent > best.savingsPercent) best = { ...s, matchPercent: 100, savingsPercent, verification: { sourceUrl: r.source_url, verifiedOn: r.verified_on, verifiedBy: r.verified_by } };
    }
    return best;
  }
  catalog.get("/medicine/:id", wrap(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, error: "invalid_id" });
    await ensureDetailTables();
    const orig = await loadMedicine(req.params.id);
    if (!orig) return res.status(404).json({ ok: false, error: "medicine_not_found" });
    const medicine = shape(orig.m, orig.d);
    const substitute = await bestSubstitute(orig);
    // "More in <category>": same keyword shelf, never a made-up "customers also bought"
    const lower = String(orig.m.name).toLowerCase();
    const cat = CATEGORIES.find((c) => c.keywords.some((k) => lower.includes(k)));
    let related = [];
    if (cat) {
      related = (await shelf(cat.keywords, 8)).filter((r) => r.id !== orig.m.id).slice(0, 6);
      const flagged = new Set((await hubPool.query(`SELECT DISTINCT medicine_id FROM medicine_substitutes WHERE medicine_id = ANY($1::uuid[])`, [related.map((r) => r.id)])).rows.map((r) => String(r.medicine_id)));
      related = related.map((r) => ({ id: r.id, name: r.name, price: Number(r.price) || 0, schedule_class: r.schedule_class, image_url: r.image_url, hasSubstitute: flagged.has(String(r.id)) }));
    }
    res.set("Cache-Control", "no-store").json({ ok: true, medicine, substitute, related, relatedTitle: cat ? `More in ${cat.name}` : null });
  }));

  // ---------- operator / platform side (x-admin-token) ----------
  const admin = express.Router();
  admin.use((req, res, next) => {
    const t = env.DELIVERY_ADMIN_TOKEN || "";
    if (t.length < 24) return res.status(503).json({ ok: false, error: "admin_disabled" });
    if (!same(String(req.headers["x-admin-token"] || ""), t)) return res.status(403).json({ ok: false, error: "forbidden" });
    next();
  });
  admin.get("/riders", wrap(async (req, res) => {
    const st = ["PENDING", "VERIFIED", "SUSPENDED"].includes(req.query.status) ? req.query.status : "PENDING";
    res.json({ ok: true, riders: (await dpool.query(`SELECT id, full_name, phone, vehicle_type, vehicle_number, verification_status, status, created_at FROM public.riders WHERE verification_status = $1 ORDER BY created_at`, [st])).rows });
  }));
  admin.post("/riders/:id/verification", wrap(async (req, res) => {
    const st = req.body && req.body.status;
    if (!UUID_RE.test(req.params.id) || !["VERIFIED", "SUSPENDED", "PENDING"].includes(st)) return res.status(400).json({ ok: false, error: "invalid_request" });
    if (st === "VERIFIED") {   // a NEW rider only becomes verified through the KYC review (operator desk). Reinstating a suspended rider is still allowed here.
      try {
        const g = (await dpool.query(`SELECT r.verification_status AS vs, public.cfg('kyc_required', 'true') = 'true' AS need,
            EXISTS (SELECT 1 FROM public.rider_kyc k WHERE k.rider_id = r.id AND k.status = 'APPROVED') AS approved FROM public.riders r WHERE r.id = $1`, [req.params.id])).rows[0];
        if (g && g.vs === "PENDING" && g.need && !g.approved) return res.status(409).json({ ok: false, error: "kyc_required", message: "This rider has not had their documents approved. Review them in the operator desk (/admin/desk)." });
      } catch (e) { if (e.code !== "42P01") throw e; }   // 42P01: the KYC migration is not installed yet -> the old behaviour
    }
    const r = await dpool.query(`UPDATE public.riders SET verification_status = $2, status = CASE WHEN $2 = 'VERIFIED' THEN status ELSE 'OFFLINE' END WHERE id = $1`, [req.params.id, st]);
    res.status(r.rowCount ? 200 : 404).json({ ok: r.rowCount > 0 });
  }));
  admin.get("/dispatch/stuck", wrap(async (req, res) => send(res, await call("admin_dispatch_stuck", ""))));   // orders every offer round failed for (OFFER mode)
  admin.post("/payments/confirm", wrap(async (req, res) => send(res, await call("confirm_delivery_payment", "$1::uuid,$2", [req.body.deliveryId, String(req.body.ref || "")]))));
  admin.get("/settlements", wrap(async (req, res) => res.json({ ok: true, settlements: (await dpool.query(`SELECT s.*, r.full_name, r.phone FROM public.cash_settlements s JOIN public.riders r ON r.id = s.rider_id WHERE s.status = 'PENDING' ORDER BY s.created_at`)).rows })));
  admin.post("/settlements/:id/confirm", wrap(async (req, res) => send(res, await call("confirm_cash_settlement", "$1::uuid,$2", [req.params.id, "admin"]))));
  admin.post("/settlements/:id/reject", wrap(async (req, res) => send(res, await call("reject_cash_settlement", "$1::uuid,$2", [req.params.id, req.body.note || null]))));
  admin.post("/returns/:deliveryId/close", wrap(async (req, res) => send(res, await call("admin_close_return", "$1::uuid,$2", [req.params.deliveryId, String(req.body.reason || "closed by operator")]))));
  router.use("/admin", admin);

  // ---------- background worker: queue drain, stale riders offline, order status mirror ----------
  const seen = new Map(); const alerted = new Set();
  async function tick() {
    const out = { tick: await call("dispatch_tick", "").catch((e) => ({ ok: false, error: e.message })) };
    if (!sameDb) {
      const rows = (await dpool.query(`SELECT id, order_id, status, pharmacy_id FROM public.deliveries WHERE updated_at > now() - interval '15 minutes'`).catch(() => ({ rows: [] }))).rows;
      for (const d of rows) {
        const want = statusMap[d.status];
        if (!want || seen.get(d.id) === d.status) continue;
        try {
          await hubPool.query(`UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1 AND status <> $2`, [d.order_id, want]);
          seen.set(d.id, d.status);
          if (io) io.to(`pharmacy_${d.pharmacy_id}`).emit("delivery_update", { deliveryId: d.id, orderId: d.order_id, status: d.status });
        } catch (e) { log.warn("[delivery] order status mirror failed:", e.message); seen.set(d.id, d.status); }
      }
    }
    // OFFER mode: tell the chemist (socket) and the operator (log + /admin/dispatch/stuck) once when every round found no rider. Harmless if the migration is not applied yet.
    const stuck = await call("admin_dispatch_stuck", "").catch(() => null);
    if (stuck && stuck.ok && Array.isArray(stuck.stuck)) {
      const live = new Set();
      for (const s of stuck.stuck) {
        live.add(s.deliveryId); if (alerted.has(s.deliveryId)) continue; alerted.add(s.deliveryId);
        log.warn(`[delivery] no rider found for delivery ${s.deliveryId} (order ${s.orderId}) after every dispatch round; waiting ${s.minutesWaiting} min`);
        if (io) io.to(`pharmacy_${s.pharmacyId}`).emit("dispatch_stuck", { deliveryId: s.deliveryId, orderId: s.orderId, waitingSince: s.waitingSince });
      }
      for (const id of [...alerted]) if (!live.has(id)) alerted.delete(id);
      out.stuck = stuck.stuck.length;
    }
    return out;
  }
  let timer = null;
  const startWorker = (ms = Number(env.DELIVERY_TICK_MS || 20000)) => { if (!timer) { timer = setInterval(() => tick().catch(() => {}), ms); timer.unref && timer.unref(); } return () => { clearInterval(timer); timer = null; }; };

  return { router, catalogRouter: catalog, activeOrderGuard, dispatchForOrder, tick, startWorker, makeDeliveryPool: () => new Pool({ connectionString: env.DELIVERY_DATABASE_URL, ssl: env.DELIVERY_DB_SSL === "0" ? false : { rejectUnauthorized: false }, max: 5 }) };
}
module.exports = { createDeliveryModule };
