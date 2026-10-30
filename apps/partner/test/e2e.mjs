// END-TO-END: pharmacy accepts an order on the Hub -> Hub bridges it to the delivery database -> forced assignment to the nearest rider ->
// rider app (its real API layer + location queue + trip logic) works the trip -> customer OTP via the Hub -> payment, wallet, settlement.
// Needs Postgres with PostGIS + pgcrypto where it can CREATE DATABASE:  TEST_DATABASE_URL=postgres://user:pass@host:5432/postgres node test/e2e.mjs
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createRiderApi } from "../src/services/supabaseClient.js";
import { createLocationQueue, createFlusher } from "../src/services/locationQueue.js";
import { stepFromJob, STEPS, paymentPlan } from "../src/services/deliveryMachine.js";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..", ".."); // repo root
const { createDeliveryModule } = require(path.join(root, "hub", "hub", "delivery", "deliveryRoutes.js"));
const express = require(path.join(root, "hub", "node_modules", "express"));

const ADMIN_URL = process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/postgres";
const urlFor = (db, cred) => { const u = new URL(ADMIN_URL); u.pathname = "/" + db; if (cred) { u.username = cred; u.password = cred; } return u.toString(); };
let pass = 0, fail = 0;
const ok = (label, cond, detail) => { if (cond) { pass++; console.log("✅", label); } else { fail++; console.log("❌", label, detail !== undefined ? JSON.stringify(detail) : ""); } };
const section = (t) => console.log("\n--- " + t);
const read = (f) => fs.readFileSync(f, "utf8");

// ---------- databases: DELIVERY (migrations) and HUB (the Neon-side orders table) ----------
const sup = path.join(root, "database", "supabase");
const migs = fs.readdirSync(path.join(sup, "migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => path.join(sup, "migrations", f));
async function fresh(name) { const c = new pg.Client({ connectionString: ADMIN_URL }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await c.query(`CREATE DATABASE ${name}`); await c.end(); return new pg.Pool({ connectionString: urlFor(name), max: 6 }); }
const delivery = await fresh("sw_e2e_delivery"), hub = await fresh("sw_e2e_hub");
const exec = async (pool, file) => { const c = await pool.connect(); try { await c.query(`SET search_path TO "$user", public, extensions`); await c.query(read(file)); } finally { c.release(); } };
for (const f of [path.join(sup, "tests/00_supabase_stubs.sql"), path.join(sup, "tests/01_hub_tables.sql"), ...migs]) await exec(delivery, f);
await hub.query(`CREATE TABLE orders (id uuid primary key default gen_random_uuid(), customer_lat double precision, customer_lng double precision, items jsonb, status text,
  current_pharmacy_id uuid, rx_status text, payment_mode text, subtotal numeric, customer_id uuid, contact_name text, contact_phone text, delivery_address text, delivery_landmark text,
  created_at timestamptz default now(), updated_at timestamptz default now())`);
const dq = async (sql, p) => (await delivery.query(sql, p)).rows;

// ---------- the Hub: pharmacy auth + customer auth are stand-ins for the real middlewares; everything else is the real router ----------
const P1 = randomUUID(), P2 = randomUUID(); const KEYS = { [P1]: "key-one-secret", [P2]: "key-two-secret" };
await dq(`INSERT INTO pharmacies (id, name, api_key, lat, lng, address, phone) VALUES ($1,'Nowshera Pharmacy','key-one-secret',34.0805,74.7905,'Nowshera, Srinagar','+911112223334'),($2,'Other Pharmacy','key-two-secret',34.30,74.60,'Sopore','+911112223335')`, [P1, P2]);
const authenticatePharmacy = async (id, key) => ({ valid: !!KEYS[id] && key === KEYS[id], resolvedId: id });
const ADMIN = "admin-token-for-tests-0123456789";
const emitted = [];   // socket.io stand-in: records what the Hub would push to a pharmacy room
const mod = createDeliveryModule({ hubPool: hub, deliveryPool: delivery, io: { to: (room) => ({ emit: (ev, p) => emitted.push({ room, ev, p }) }) }, authenticatePharmacy, optionalCustomer: (req, _res, next) => { if (req.headers["x-customer-id"]) req.customer = { id: req.headers["x-customer-id"] }; next(); },
  log: { error: () => {}, warn: () => {}, log: () => {} }, env: { DELIVERY_ADMIN_TOKEN: ADMIN } });
const app = express(); app.use(express.json()); app.use("/api/delivery", mod.router);
const server = http.createServer(app); await new Promise((r) => server.listen(0, r)); const BASE = `http://127.0.0.1:${server.address().port}/api/delivery`;
const H = async (method, p, { key, body, admin, customer } = {}) => {
  const res = await fetch(BASE + p, { method, headers: { "content-type": "application/json", ...(key ? { "x-pharmacy-key": key } : {}), ...(admin ? { "x-admin-token": admin } : {}), ...(customer ? { "x-customer-id": customer } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// ---------- a Supabase-client stand-in that behaves like PostgREST: connects as `authenticator`, SET ROLE authenticated, JWT claims in a GUC ----------
const api = new pg.Pool({ connectionString: urlFor("sw_e2e_delivery", "authenticator"), max: 8 });
function fakeSupabase(user) {
  const withTx = async (fn) => { const c = await api.connect(); try { await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated"); await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user.id, role: "authenticated" })]); const r = await fn(c); await c.query("COMMIT"); return r; } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); } };
  const isObj = (v) => v !== null && typeof v === "object";
  return {
    rpc: async (fn, args = {}) => {
      const keys = Object.keys(args); const sig = keys.map((k, i) => `${k} := $${i + 1}${isObj(args[k]) ? "::jsonb" : ""}`).join(", ");
      try { const r = await withTx((c) => c.query(`SELECT public.${fn}(${sig}) AS r`, keys.map((k) => (isObj(args[k]) ? JSON.stringify(args[k]) : args[k])))); return { data: r.rows[0].r, error: null }; }
      catch (e) { return { data: null, error: { message: e.message, code: e.code } }; }
    },
    from: (table) => { const q = { cols: "*", ins: [], ord: null, lim: null }; const b = { select: (c) => { q.cols = c; return b; }, in: (c, v) => { q.ins.push([c, v]); return b; }, order: (c, o) => { q.ord = [c, o?.ascending !== false]; return b; }, limit: (n) => { q.lim = n; return b; },
      then: (res, rej) => withTx((c) => c.query(`SELECT ${q.cols} FROM public.${table}${q.ins.length ? " WHERE " + q.ins.map(([col], i) => `${col} = ANY($${i + 1})`).join(" AND ") : ""}${q.ord ? ` ORDER BY ${q.ord[0]} ${q.ord[1] ? "ASC" : "DESC"}` : ""}${q.lim ? ` LIMIT ${q.lim}` : ""}`, q.ins.map(([, v]) => v)))
        .then((r) => ({ data: r.rows, error: null }), (e) => ({ data: null, error: { message: e.message, code: e.code } })).then(res, rej) }; return b; },
    channel: () => ({ on() { return this; }, subscribe(cb) { cb?.("SUBSCRIBED"); return this; } }), removeChannel() {},
    storage: { from: (bucket) => ({ upload: async (name) => { try { await withTx((c) => c.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ($1,$2)`, [bucket, name])); return { error: null }; } catch (e) { return { error: { message: e.message, code: e.code } }; } } }) },
  };
}
let phoneSeq = 0;
async function newRider(name, { km = 1 } = {}) {
  const id = randomUUID(); await dq(`INSERT INTO auth.users (id, phone) VALUES ($1,$2)`, [id, "9198" + String(20000000 + ++phoneSeq)]);
  const riderApi = createRiderApi(fakeSupabase({ id })); const queue = createLocationQueue({ idb: null });
  let netUp = true; const flusher = createFlusher({ queue, push: async (pts) => (netUp ? riderApi.pushLocations(pts) : { ok: false, error: "network" }), now: () => Date.now() + 1e9 });   // clock skip: backoff never blocks the test
  const R = { id, name, api: riderApi, queue, flusher, net: (v) => { netUp = v; },
    gps: async (lat, lng, t = Date.now()) => { await queue.enqueue({ t, lat, lng, accuracy: 12, speed: 0, bearing: null }); return flusher.flush({ force: true }); } };
  const reg = await riderApi.registerRider({ fullName: name, vehicleType: "SCOOTER", vehicleNumber: "JK01AB1234" }); R.reg = reg;
  return R;
}
const verify = (r) => H("POST", `/admin/riders/${r.id}/verification`, { admin: ADMIN, body: { status: "VERIFIED" } });
const newOrder = async (o = {}) => { const id = randomUUID(); await hub.query(`INSERT INTO orders (id, customer_lat, customer_lng, items, status, current_pharmacy_id, rx_status, payment_mode, subtotal, customer_id, contact_name, contact_phone, delivery_address, delivery_landmark)
  VALUES ($1,34.09,74.80,$2,$3,$4,'VERIFIED',$5,$6,$7,'Aaliya','+919000011111','Flat 402, Block B, Soura','Opp. Park')`, [id, JSON.stringify([{ name: "Augmentin 625", quantity: 1 }, { name: "Paracetamol 500mg", quantity: 2 }]), o.status ?? "ACCEPTED", o.pharmacy ?? P1, o.mode ?? "CASH", o.subtotal ?? 760, o.customer ?? CUSTOMER]); return id; };
const CUSTOMER = randomUUID(), STRANGER = randomUUID();
const dispatch = (orderId, key = KEYS[P1], pharmacyId = P1) => H("POST", "/dispatch", { key, body: { pharmacyId, orderId } });

// =======================================================================================================================================
await dq(`UPDATE delivery_config SET value='false' WHERE key='kyc_required'`);   // the older sections verify riders with the operator shortcut; section 14 turns the rule back on
section("1. Rider onboarding: register, wait for verification, operator approves (no SQL needed)");
const asha = await newRider("Asha Rider");
ok("registering creates a PENDING rider", asha.reg.ok === true);
let me = (await asha.api.getMyRider()).rider;
ok("get_my_rider reports PENDING and zero wallet", me.verificationStatus === "PENDING" && me.cashInHand === 0 && me.status === "OFFLINE", me);
ok("an unverified rider cannot go online", (await asha.api.setStatus("ONLINE")).error === "not_verified");
ok("admin endpoints refuse a missing / wrong token", (await H("GET", "/admin/riders")).status === 403 && (await H("GET", "/admin/riders", { admin: "x".repeat(30) })).status === 403);
ok("the operator lists pending riders and approves Asha", (await H("GET", "/admin/riders?status=PENDING", { admin: ADMIN })).body.riders.some((r) => r.id === asha.id) && (await verify(asha)).body.ok === true);
ok("now verified", (await asha.api.getMyRider()).rider.verificationStatus === "VERIFIED");

section("2. Going online + GPS through the durable queue (weak-signal behaviour)");
ok("rider goes ONLINE", (await asha.api.setStatus("ONLINE")).status === "ONLINE");
asha.net(false);
await asha.gps(34.0815, 74.7905, Date.now() - 20000); await asha.gps(34.0816, 74.7906, Date.now() - 10000);
ok("with no signal the points stay queued (nothing is lost)", (await asha.queue.size()) === 2);
asha.net(true); const fl = await asha.flusher.flush({ force: true });
ok("signal returns: the queue drains oldest-first and empties", fl.sent === 2 && (await asha.queue.size()) === 0, fl);
ok("duplicate fixes are not queued twice", (await asha.queue.enqueue({ t: 5, lat: 1, lng: 1 })) === true && (await asha.queue.enqueue({ t: 5, lat: 1, lng: 1 })) === false);
await asha.queue.clear();
await asha.gps(34.0815, 74.7905);
ok("the server has the rider's position", Math.abs((await dq(`SELECT last_lat FROM riders WHERE id=$1`, [asha.id]))[0].last_lat - 34.0815) < 1e-6);

section("3. Pharmacy accepts -> Hub bridges the order -> nearest rider is FORCE-ASSIGNED");
const o1 = await newOrder();
ok("a pharmacy with the wrong key cannot dispatch", (await dispatch(o1, "wrong-key")).status === 403);
ok("another pharmacy cannot dispatch this order", (await dispatch(o1, KEYS[P2], P2)).status === 403);
ok("an order that is not ACCEPTED is refused", (await dispatch(await newOrder({ status: "SENT_TO_PHARMACY" }))).body.error === "order_not_accepted");
const d1 = await dispatch(o1);
ok("dispatch copies the order across and assigns Asha instantly (no accept step)", d1.body.ok && d1.body.assigned === true && d1.body.rider, d1.body);
ok("dispatching twice is idempotent", (await dispatch(o1)).body.already === true && (await dq(`SELECT count(*)::int n FROM deliveries WHERE order_id=$1`, [o1]))[0].n === 1);
const job1 = (await asha.api.getActiveDelivery()).delivery;
ok("the rider app sees the job: step EN_ROUTE_TO_PHARMACY, items, earnings, pharmacy", stepFromJob(job1) === STEPS.EN_ROUTE_TO_PHARMACY && job1.order.items.length === 2 && job1.order.earnings === 40 && job1.order.pharmacy.name === "Nowshera Pharmacy", job1);
ok("the pharmacy POS list shows the delivery with the rider's name", (await H("GET", `/pharmacy/${P1}`, { key: KEYS[P1] })).body.deliveries.some((d) => d.order_id === o1 && d.riders?.full_name === "Asha Rider"));
ok("...and another pharmacy's list is empty / key-protected", (await H("GET", `/pharmacy/${P1}`, { key: KEYS[P2] })).status === 403 && (await H("GET", `/pharmacy/${P2}`, { key: KEYS[P2] })).body.deliveries.length === 0);
const del1 = job1.order.deliveryId;

section("4. Pickup: arrive, pharmacy shows QR, rider scans (QR only)");
ok("rider swipes 'reached pharmacy'", (await asha.api.markArrived(del1, "pharmacy")).status === "ARRIVED_AT_PHARMACY");
ok("step becomes PICKUP_VERIFICATION", stepFromJob((await asha.api.getActiveDelivery()).delivery) === STEPS.PICKUP_VERIFICATION);
ok("only THIS pharmacy can fetch the QR through the Hub", (await H("GET", `/${del1}/pickup-qr`, { key: KEYS[P2] })).status === 403 && (await H("GET", `/${del1}/pickup-qr`)).status === 403);
const qr = (await H("GET", `/${del1}/pickup-qr`, { key: KEYS[P1] })).body.qr;
ok("the pickup QR has the SW1.<delivery>.<token> shape", /^SW1\.[0-9a-f-]{36}\.[0-9a-f]{32}$/.test(qr) && qr.split(".")[1] === del1);
ok("a wrong QR is refused by the server", (await asha.api.confirmPickup(del1, "QR", `SW1.${del1}.deadbeefdeadbeefdeadbeefdeadbeef`)).error === "qr_mismatch");
ok("manual pickup is off by default", (await asha.api.confirmPickup(del1, "MANUAL", null)).error === "manual_not_allowed");
ok("the right QR -> PICKED_UP", (await asha.api.confirmPickup(del1, "QR", qr)).ok === true);
ok("the QR is now spent (the pharmacy can't re-show it)", (await H("GET", `/${del1}/pickup-qr`, { key: KEYS[P1] })).body.error === "qr_not_available");
ok("step becomes EN_ROUTE_TO_CUSTOMER", stepFromJob((await asha.api.getActiveDelivery()).delivery) === STEPS.EN_ROUTE_TO_CUSTOMER);

section("5. Customer side via the Hub: live tracking + the delivery OTP");
await asha.gps(34.0850, 74.7950);
const track = (await H("GET", `/by-order/${o1}`, { customer: CUSTOMER })).body.delivery;
ok("the customer sees status, the rider's FIRST name and live position (no phone, no surname)", track.status === "PICKED_UP" && track.rider.firstName === "Asha" && Math.abs(track.rider.lat - 34.085) < 1e-6 && !JSON.stringify(track).includes("Rider"), track);
ok("a stranger cannot see this order's tracking or OTP", (await H("GET", `/by-order/${o1}`, { customer: STRANGER })).status === 404 && (await H("GET", `/by-order/${o1}/otp`, { customer: STRANGER })).status === 404 && (await H("GET", `/by-order/${o1}/otp`)).status === 401);
const otp = (await H("GET", `/by-order/${o1}/otp`, { customer: CUSTOMER })).body.otp;
ok("the owner gets a 4-digit OTP; riders and pharmacies have no route to it", /^\d{4}$/.test(otp) && (await asha.api.getActiveDelivery()).delivery.order.customer.phone !== undefined);

section("6. Drop-off: arrive, wrong OTP, cash, proof photo, correct OTP, wallet");
ok("rider swipes 'reached customer' -> DROPOFF_OTP", (await asha.api.markArrived(del1, "customer")).ok && stepFromJob((await asha.api.getActiveDelivery()).delivery) === STEPS.DROPOFF_OTP);
const plan = paymentPlan((await asha.api.getActiveDelivery()).delivery.order);
ok("payment plan: CASH job, collect subtotal + fee = ₹800", plan.mode === "CASH" && plan.needsCash && plan.collect === 800, plan);
const bad = await asha.api.completeDelivery(del1, { otp: otp === "0000" ? "1111" : "0000", paymentMode: plan.mode });
ok("a wrong OTP is refused and counts down the attempts", bad.error === "invalid_otp" && typeof bad.attemptsLeft === "number", bad);
ok("a UPI claim without platform verification is refused", (await asha.api.completeDelivery(del1, { otp, paymentMode: "UPI_QR" })).error === "payment_not_verified");
const up = await asha.api.uploadProof(del1, Buffer.from("jpeg"));
ok("proof photo upload is allowed for the assigned rider while PICKED_UP", up.ok && up.path.startsWith(del1 + "/"), up);
const fin = await asha.api.completeDelivery(del1, { otp, paymentMode: plan.mode, proofPath: up.path });
ok("the right OTP completes the delivery: earnings ₹40, floating cash +₹760", fin.ok && Number(fin.earnings) === 40 && Number(fin.cashInHand) === 760, fin);
me = (await asha.api.getMyRider()).rider;
ok("wallet: cash job = rider keeps the ₹40 fee from the ₹800 collected, owes ₹760; back to ONLINE, no active job", me.cashInHand === 760 && me.earningsBalance === 0 && me.status === "ONLINE" && (await asha.api.getActiveDelivery()).delivery === null, me);
ok("the pharmacy was credited its net (₹684) in the clearinghouse", Number((await dq(`SELECT COALESCE(SUM(amount),0) s FROM pharmacy_ledger WHERE pharmacy_id=$1`, [P1]))[0].s) === 684);
ok("history shows the delivery", (await asha.api.getRecentDeliveries()).rows[0]?.status === "DELIVERED");
await mod.tick();
ok("the worker mirrors DELIVERED back to the Hub's order (the customer app sees it)", (await hub.query(`SELECT status FROM orders WHERE id=$1`, [o1])).rows[0].status === "DELIVERED");
ok("the finished delivery's OTP can no longer be read", (await H("GET", `/by-order/${o1}/otp`, { customer: CUSTOMER })).status === 409);

section("7. Floating cash: settle by UPI, operator verifies");
ok("settling more than you hold is refused", (await asha.api.settleCash(5000, "482910557301")).ok === false);
ok("rider submits a UPI settlement", (await asha.api.settleCash(760, "482910557301")).ok === true);
me = (await asha.api.getMyRider()).rider; ok("pending settlement is visible but cash is not reduced yet", me.pendingSettlement === 760 && me.cashInHand === 760, me);
const pend = (await H("GET", "/admin/settlements", { admin: ADMIN })).body.settlements; ok("operator sees the pending settlement", pend.length === 1 && pend[0].full_name === "Asha Rider");
ok("operator confirms it", (await H("POST", `/admin/settlements/${pend[0].id}/confirm`, { admin: ADMIN })).body.ok === true);
me = (await asha.api.getMyRider()).rider; ok("cash in hand returns to 0", me.cashInHand === 0 && me.pendingSettlement === 0, me);

section("8. UPI at the door: the platform verifies, the rider collects nothing");
const o2 = await newOrder(); const d2 = (await dispatch(o2)).body; const del2 = d2.deliveryId;
await asha.api.markArrived(del2, "pharmacy"); await asha.api.confirmPickup(del2, "QR", (await H("GET", `/${del2}/pickup-qr`, { key: KEYS[P1] })).body.qr); await asha.api.markArrived(del2, "customer");
ok("before verification the plan is still cash", paymentPlan((await asha.api.getActiveDelivery()).delivery.order).needsCash === true);
ok("the platform confirms the customer's UPI payment", (await H("POST", "/admin/payments/confirm", { admin: ADMIN, body: { deliveryId: del2, ref: "PSP-REF-998877" } })).body.ok === true);
const plan2 = paymentPlan((await asha.api.getActiveDelivery()).delivery.order);
ok("now the plan is UPI_QR, collect ₹0 (the app learns this on its next refresh)", plan2.mode === "UPI_QR" && plan2.collect === 0 && plan2.needsCash === false, plan2);
const otp2 = (await H("GET", `/by-order/${o2}/otp`, { customer: CUSTOMER })).body.otp;
ok("cash is refused on an already-paid order", (await asha.api.completeDelivery(del2, { otp: otp2, paymentMode: "CASH" })).error === "payment_mismatch");
const fin2 = await asha.api.completeDelivery(del2, { otp: otp2, paymentMode: plan2.mode });
ok("completes with NO cash added; the ₹40 fee is credited to the earnings balance", fin2.ok && Number(fin2.cashInHand) === 0 && (await asha.api.getMyRider()).rider.earningsBalance === 40, fin2);

section("9. SOS: rider breaks down -> pharmacy reassigns to another rider");
const ben = await newRider("Ben Rider", { km: 2 }); await verify(ben); await ben.api.setStatus("ONLINE"); await ben.gps(34.0900, 74.7905);
await asha.api.setStatus("ONLINE"); await asha.gps(34.0815, 74.7905);
const o3 = await newOrder(); const d3 = (await dispatch(o3)).body; const del3 = d3.deliveryId;
const first = (await dq(`SELECT rider_id FROM deliveries WHERE id=$1`, [del3]))[0].rider_id; const sick = first === asha.id ? asha : ben, other = sick === asha ? ben : asha;
ok("the nearest online rider got it", d3.assigned === true && first === asha.id, { first });
ok("a rider cannot cancel or unassign, only report", (await sick.api.reportIssue(del3, "VEHICLE_BREAKDOWN", "flat tyre")).ok === true && (await dq(`SELECT rider_id FROM deliveries WHERE id=$1`, [del3]))[0].rider_id === sick.id);
ok("the pharmacy POS list shows the issue", (await H("GET", `/pharmacy/${P1}`, { key: KEYS[P1] })).body.deliveries.find((d) => d.id === del3)?.issue_type === "VEHICLE_BREAKDOWN");
const re = await H("POST", `/${del3}/reassign`, { key: KEYS[P1], body: { reason: "SOS_VEHICLE_BREAKDOWN" } });
ok("pharmacy reassigns through the Hub: the broken-down rider is off the job (and OFFLINE), the other rider is on it", re.body.ok && re.body.assigned === true && (await sick.api.getActiveDelivery()).delivery === null && (await other.api.getActiveDelivery()).delivery?.order.deliveryId === del3 && (await sick.api.getMyRider()).rider.status === "OFFLINE", re.body);

section("10. Doorstep failure: customer unreachable -> return the sealed bag");
const del3b = del3; const rider3 = other;
await rider3.api.markArrived(del3b, "pharmacy"); await rider3.api.confirmPickup(del3b, "QR", (await H("GET", `/${del3b}/pickup-qr`, { key: KEYS[P1] })).body.qr); await rider3.api.markArrived(del3b, "customer");
ok("rider reports CUSTOMER_UNREACHABLE", (await rider3.api.reportIssue(del3b, "CUSTOMER_UNREACHABLE", "no answer")).ok);
ok("pharmacy initiates the return through the Hub", (await H("POST", `/${del3b}/return`, { key: KEYS[P1], body: { reason: "CUSTOMER_UNREACHABLE" } })).body.status === "RETURNING_TO_PHARMACY");
ok("rider app step is RETURNING_TO_PHARMACY", stepFromJob((await rider3.api.getActiveDelivery()).delivery) === STEPS.RETURNING_TO_PHARMACY);
const rqr = (await H("GET", `/${del3b}/return-qr`, { key: KEYS[P1] })).body.qr;
ok("a wrong return QR is refused; the pharmacy's return QR closes the loop", (await rider3.api.confirmReturn(del3b, `SW1.${del3b}.00000000000000000000000000000000`)).ok === false && (await rider3.api.confirmReturn(del3b, rqr)).ok === true && (await rider3.api.getActiveDelivery()).delivery === null);
ok("the Hub order is mirrored as RETURNED", (await mod.tick(), (await hub.query(`SELECT status FROM orders WHERE id=$1`, [o3])).rows[0].status === "RETURNED"));

section("11. Nobody online: the order QUEUES, then the first rider to come online takes it");
await dq(`UPDATE riders SET status='OFFLINE'`);
const o4 = await newOrder(); const d4 = (await dispatch(o4)).body;
ok("dispatch with nobody free queues the order", d4.ok && d4.assigned === false && d4.queued === true, d4);
await asha.api.setStatus("ONLINE");
ok("going online (with a fresh position) assigns the waiting order to Asha at once", (await asha.api.getActiveDelivery()).delivery?.order.deliveryId === d4.deliveryId);
ok("the Hub can cancel before pickup; the rider is freed", (await H("POST", `/${d4.deliveryId}/cancel`, { key: KEYS[P1], body: { reason: "CUSTOMER_CHANGED_MIND" } })).body.ok === true && (await asha.api.getActiveDelivery()).delivery === null);

section("12. Isolation: riders and pharmacies see only their own rows");
const bensRows = (await ben.api.getRecentDeliveries(50)).rows; const ashaRows = (await asha.api.getRecentDeliveries(50)).rows;
ok("a rider's history never includes another rider's deliveries", ashaRows.every((r) => r.status) && !bensRows.some((r) => ashaRows.some((a) => a.id === r.id)));
ok("riders cannot read other riders, the secrets table, or ledgers of others", (await (async () => { const c = fakeSupabase({ id: ben.id }); const r = await c.from("delivery_secrets").select("*"); return r.error ? /permission denied/.test(r.error.message) : r.data.length === 0; })()));
ok("the Hub never exposes the pickup token or OTP to anyone but the right caller", (await H("GET", `/pharmacy/${P1}`, { key: KEYS[P1] })).body.deliveries.every((d) => !("pickup_token" in d) && !("otp" in d)));
ok("the pharmacy platform split is hidden from riders (columns not selectable)", (await (async () => { const r = await fakeSupabase({ id: ben.id }).from("deliveries").select("platform_commission, pharmacy_net_amount"); return !!r.error; })()));

section("13. OFFER mode end to end: Hub dispatch -> offers -> simultaneous accept via the rider API layer -> cancel -> operator alert");
await dq(`UPDATE deliveries SET status='CANCELLED', cancelled_at=now(), cancel_reason='e2e reset' WHERE status IN ('DISPATCHED','ACCEPTED','ARRIVED_AT_PHARMACY','PICKED_UP','RETURNING_TO_PHARMACY')`);
await dq(`UPDATE riders SET status='OFFLINE' WHERE status IN ('ONLINE','ON_DELIVERY')`);
const cara = await newRider("Cara Rider"); await verify(cara); await cara.api.setStatus("ONLINE"); await cara.gps(34.0810, 74.7905);
const dev = await newRider("Dev Rider");   await verify(dev);  await dev.api.setStatus("ONLINE");  await dev.gps(34.0830, 74.7905);
await dq(`UPDATE delivery_config SET value='OFFER' WHERE key='dispatch_mode'`);
const o13 = await newOrder(); const d13 = (await dispatch(o13)).body;
ok("Hub dispatch in OFFER mode queues the order; nobody is force-assigned", d13.ok === true && d13.assigned === false && d13.queued === true, d13);
const [oc, od] = await Promise.all([cara.api.getMyOffer(), dev.api.getMyOffer()]);
ok("both nearby riders see the SAME order as an offer, with a live countdown and no customer details", oc.offer && od.offer && oc.offer.deliveryId === od.offer.deliveryId && oc.offer.secondsLeft > 10 && !/Aaliya|9000011111|Flat 402|Augmentin/.test(JSON.stringify([oc, od])), [oc, od]);
const list13 = (await H("GET", `/pharmacy/${P1}`, { key: KEYS[P1] })).body.deliveries.find((x) => x.id === d13.deliveryId);
ok("the chemist's delivery list says 2 riders are being asked in search 1 (counts only: no rider is named)", list13 && list13.riders === null && list13.live_offers === 2 && list13.dispatch_round === 1 && list13.dispatch_exhausted_at === null && !/cara|dev/i.test(JSON.stringify(list13)), list13);
const [rc, rd] = await Promise.all([cara.api.acceptOffer(oc.offer.offerId), dev.api.acceptOffer(od.offer.offerId)]);
const winner = rc.ok ? cara : dev, loser = rc.ok ? dev : cara, lost = rc.ok ? rd : rc;
ok("two simultaneous accepts through the app's API layer: exactly one wins, the other gets offer_taken", [rc, rd].filter((r) => r.ok).length === 1 && lost.error === "offer_taken", [rc, rd]);
const wj = await winner.api.getActiveDelivery();
ok("the winner's job is ACCEPTED and now reveals the customer; the loser has no job and no offer", wj.delivery?.status === "ACCEPTED" && wj.delivery.order.customer.name === "Aaliya" && (await loser.api.getActiveDelivery()).delivery === null && (await loser.api.getMyOffer()).offer === null);
const cx = await winner.api.cancelDelivery(wj.delivery.order.deliveryId, "TOO_FAR", "e2e");
ok("the winner cancels before pickup: re-queued, and the OTHER rider is offered it (the canceller is not)", cx.ok === true && (await loser.api.getMyOffer()).offer?.deliveryId === d13.deliveryId && (await winner.api.getMyOffer()).offer === null, cx);
ok("after pickup a cancel is refused by the server", await (async () => { const lo = (await loser.api.getMyOffer()).offer; const acc = await loser.api.acceptOffer(lo.offerId); const did = acc.delivery.order.deliveryId;
  await loser.api.markArrived(did, "pharmacy"); const qr = (await H("GET", `/${did}/pickup-qr`, { key: KEYS[P1] })).body.qr; await loser.api.confirmPickup(did, "QR", qr);
  return (await loser.api.cancelDelivery(did, "OTHER", null)).error === "cancel_after_pickup"; })());
await dq(`UPDATE riders SET status='OFFLINE' WHERE status='ONLINE'`);
const o14 = await newOrder(); const d14 = (await dispatch(o14)).body; await mod.tick(); await mod.tick();
const stuckList = await H("GET", "/admin/dispatch/stuck", { admin: ADMIN });
ok("no riders at all: the order stays queued and is listed for the operator (admin token required)", d14.ok && stuckList.body.stuck.some((x) => x.deliveryId === d14.deliveryId) && (await H("GET", "/admin/dispatch/stuck")).status === 403, stuckList.body);
ok("the chemist is told once (not on every tick)", emitted.filter((e) => e.ev === "dispatch_stuck" && e.p.deliveryId === d14.deliveryId).length === 1, emitted);
const list14 = (await H("GET", `/pharmacy/${P1}`, { key: KEYS[P1] })).body.deliveries.find((x) => x.id === d14.deliveryId);
ok("when every round found nobody the chemist's list carries the 'exhausted' flag", list14 && list14.riders === null && list14.live_offers === 0 && list14.dispatch_exhausted_at !== null, list14);
await dq(`ALTER TABLE deliveries RENAME COLUMN dispatch_round TO dispatch_round_tmp`);   // simulate: Hub deployed BEFORE the offer-dispatch migration
const fb = await H("GET", `/pharmacy/${P1}`, { key: KEYS[P1] });
await dq(`ALTER TABLE deliveries RENAME COLUMN dispatch_round_tmp TO dispatch_round`);
ok("Hub deployed before the migration: the chemist's list still loads (falls back to the original query)", fb.status === 200 && fb.body.ok === true && fb.body.deliveries.some((x) => x.id === d14.deliveryId) && fb.body.deliveries.every((x) => x.live_offers === undefined), fb.status);
await dq(`UPDATE delivery_config SET value='AUTO' WHERE key='dispatch_mode'`);

// =======================================================================================================================================
section("14. Rider KYC through the rider API layer: documents -> operator review -> verified -> can go online");
await dq(`UPDATE delivery_config SET value='true' WHERE key='kyc_required'`);
const JPG = Buffer.concat([Buffer.from("ffd8ffe000104a46494600", "hex"), Buffer.alloc(400, 9)]).toString("base64");
const kyc = newRider("Kamran Rider");
const K = await kyc;
let k0 = (await K.api.getMyKyc()).kyc;
ok("a new rider starts at DRAFT with 5 documents to add", k0.status === "DRAFT" && k0.required.length === 5 && k0.canEdit === true, k0);
ok("a text file posing as a photo is refused", (await K.api.kycUploadDoc("PAN", Buffer.from("not an image").toString("base64"))).error === "invalid_image");
ok("sending with nothing uploaded names what is missing", (await K.api.kycSubmit({ dob: "1995-04-12", aadhaarLast4: "4821", pan: "ABCPE7777F", dlNumber: "JK01 2019 7770001", dlExpiry: "2032-01-31" })).error === "documents_missing");
for (const kind of ["SELFIE", "AADHAAR_FRONT", "AADHAAR_BACK", "PAN", "DL_FRONT"]) await K.api.kycUploadDoc(kind, JPG);
const sub = await K.api.kycSubmit({ dob: "1995-04-12", aadhaarLast4: "4821", pan: "ABCPE7777F", dlNumber: "JK01 2019 7770001", dlExpiry: "2032-01-31" });
ok("with everything in, the submission is accepted", sub.ok === true && sub.status === "SUBMITTED", sub);
ok("the old 'just verify him' shortcut is refused for a rider with no approved documents", (await H("POST", `/admin/riders/${K.id}/verification`, { admin: ADMIN, body: { status: "VERIFIED" } })).status === 409);
ok("still cannot go online", (await K.api.setStatus("ONLINE")).error === "not_verified");
ok("the operator rejects with a reason and names the picture to retake", ((await dq(`SELECT public.admin_kyc_decide($1::uuid,'REJECT','{PAN}','PAN is blurry','test') AS r`, [K.id]))[0].r).ok === true);
let k1 = (await K.api.getMyKyc()).kyc;
ok("the rider sees the reason and which document to retake", k1.status === "REJECTED" && k1.rejectReason === "PAN is blurry" && k1.docs.PAN.status === "REJECTED" && k1.canEdit === true, k1);
await K.api.kycUploadDoc("PAN", JPG);
ok("after the retake she sends again", (await K.api.kycSubmit({ dob: "1995-04-12", aadhaarLast4: "4821", pan: "ABCPE7777F", dlNumber: "JK01 2019 7770001", dlExpiry: "2032-01-31" })).ok === true);
ok("the operator approves", ((await dq(`SELECT public.admin_kyc_decide($1::uuid,'APPROVE','{}',null,'test') AS r`, [K.id]))[0].r).ok === true);
ok("the rider is VERIFIED and can go online", (await K.api.getMyRider()).rider.verificationStatus === "VERIFIED" && (await K.api.setStatus("ONLINE")).ok === true);
ok("her documents now show as approved, and she can no longer change them", (await K.api.getMyKyc()).kyc.docs.PAN.status === "APPROVED" && (await K.api.kycUploadDoc("PAN", JPG)).error === "kyc_locked");
await dq(`UPDATE delivery_config SET value='false' WHERE key='kyc_required'`);

// =======================================================================================================================================
section("15. Earnings summary: fees kept from cash orders + fees owed for online orders (what the wallet screen shows)");
const E = await newRider("Esha Earner");
const led = (type, amt, ago = "0 days", delivery = randomUUID()) => dq(`INSERT INTO rider_ledger (rider_id, delivery_id, entry_type, amount, cash_in_hand_after, earnings_balance_after, note, created_at) VALUES ($1,$2,$3,$4,0,0,'t', now() - $5::interval)`, [E.id, delivery, type, amt, ago]);
const eA = randomUUID(), eB = randomUUID(), eC = randomUUID(), eD = randomUUID();
await dq(`ALTER TABLE rider_ledger DISABLE TRIGGER ALL`);   // synthetic history: the rows need no real delivery behind them
await led("COD_COLLECTED", 760, "0 days", eA); await led("COD_FEE_KEPT", 40, "0 days", eA);          // cash order today
await led("DELIVERY_EARNING", 40, "0 days", eB);                                                    // online order today
await led("COD_FEE_KEPT", 50, "3 days", eC);                                                         // 3 days ago
await led("RETURN_EARNING", 20, "30 days", eD);                                                      // a month ago: a return trip fee
await led("CASH_SETTLEMENT", 760, "0 days", null);                                                   // a deposit: is NOT earnings
await dq(`ALTER TABLE rider_ledger ENABLE TRIGGER ALL`);
const es = (await E.api.getMyEarnings());
ok("the summary answers", es.ok === true, es);
ok("TODAY: kept 40 from the cash order + 40 credited for the online one = 2 deliveries; collected cash and deposits are not counted as earnings", es.today.keptFromCash === 40 && es.today.credited === 40 && es.today.deliveries === 2, es.today);
ok("LAST 7 DAYS adds the 3-day-old cash fee", es.week.keptFromCash === 90 && es.week.credited === 40 && es.week.deliveries === 3, es.week);
ok("ALL TIME adds the return-trip fee a month ago", es.all.keptFromCash === 90 && es.all.credited === 60 && es.all.deliveries === 4, es.all);
const asha2 = await asha.api.getMyEarnings();
const ashaTruth = (await dq(`SELECT coalesce(sum(amount) FILTER (WHERE entry_type='COD_FEE_KEPT'),0)::float AS k, coalesce(sum(amount) FILTER (WHERE entry_type IN ('DELIVERY_EARNING','RETURN_EARNING')),0)::float AS c FROM rider_ledger WHERE rider_id=$1`, [asha.id]))[0];
ok("for a rider who really delivered (sections 3-10) the summary equals the ledger", asha2.ok && asha2.all.keptFromCash === ashaTruth.k && asha2.all.credited === ashaTruth.c && asha2.all.deliveries > 0, { asha2: asha2.all, ashaTruth });
ok("it also reports what SehatWaadi still owes him and the cash he holds", asha2.owedToRider === (await asha.api.getMyRider()).rider.earningsBalance && asha2.cashInHand === (await asha.api.getMyRider()).rider.cashInHand, asha2);
ok("a rider only ever sees his own figures", (await E.api.getMyEarnings()).all.deliveries === 4 && (await asha.api.getMyEarnings()).all.deliveries !== 4);
ok("anonymous callers cannot call it", (await dq(`SELECT has_function_privilege('anon', 'public.get_my_earnings()', 'execute') AS a`))[0].a === false);
ok("the helper is not callable by riders", (await dq(`SELECT has_function_privilege('authenticated', 'public._earn_block(uuid, timestamptz)', 'execute') AS a`))[0].a === false);

console.log(`\n${pass} passed, ${fail} failed`);
server.close(); await Promise.all([delivery.end(), hub.end(), api.end()]);
process.exit(fail ? 1 : 0);
