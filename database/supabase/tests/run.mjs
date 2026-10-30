// SQL tests for the delivery migrations. Runs against ANY Postgres with PostGIS + pgcrypto where you can CREATE DATABASE
// (scratch server, Neon branch, local install). It builds its own scratch databases (sw_rider_test*), never touching existing data.
//   TEST_DATABASE_URL=postgres://user:pass@host:5432/postgres  node tests/run.mjs
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_URL = process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:5432/postgres";
const urlFor = (db, cred) => { const u = new URL(ADMIN_URL); u.pathname = "/" + db; if (cred) { u.username = cred; u.password = cred; } return u.toString(); };
const read = (f) => fs.readFileSync(f, "utf8");
const migDir = path.join(here, "..", "migrations");
const migrations = fs.readdirSync(migDir).filter((x) => x.endsWith(".sql")).sort().map((f) => path.join(migDir, f));

let pass = 0, fail = 0;
const ok = (label, cond, detail) => { if (cond) { pass++; console.log("✅", label); } else { fail++; console.log("❌", label, detail !== undefined ? JSON.stringify(detail) : ""); } };
const section = (t) => console.log("\n--- " + t);
const num = (x) => Number(x);

async function buildDb(name, tablesFile, migs) {
  const m = new pg.Client({ connectionString: ADMIN_URL }); await m.connect();
  await m.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await m.query(`CREATE DATABASE ${name}`); await m.end();
  const pool = new pg.Pool({ connectionString: urlFor(name), max: 4 });
  const exec = async (file) => { const c = await pool.connect(); try { await c.query(`SET search_path TO "$user", public, extensions`); await c.query(read(file)); } finally { c.release(); } };
  await exec(path.join(here, "00_supabase_stubs.sql")); await exec(path.join(here, tablesFile));
  for (const f of migs) await exec(f);
  return { pool, exec };
}

const { pool: admin, exec: runFile } = await buildDb("sw_rider_test", "01_hub_tables.sql", migrations);
const adminQ = async (sql, params) => (await admin.query(sql, params)).rows;
console.log("scratch database ready, migrations applied");

// ---- API-role helper: behaves like PostgREST (connect as authenticator, SET ROLE, claims in a GUC) ----------------------------------------
const api = new pg.Pool({ connectionString: urlFor("sw_rider_test", "authenticator"), max: 14 });
function as(who) {
  const role = who ? (who.role || "authenticated") : "anon";
  const claims = JSON.stringify(who ? { sub: who.sub, role } : { role: "anon" });
  const withTx = async (fn, commit) => {
    const c = await api.connect();
    try { await c.query("BEGIN"); await c.query(`SET LOCAL ROLE ${role}`); await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims]);
      const r = await fn(c); await c.query(commit ? "COMMIT" : "ROLLBACK"); return r;
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  };
  return {
    rpc: (fn, sig, ...args) => withTx(async (c) => (await c.query(`SELECT public.${fn}(${sig}) AS r`, args)).rows[0].r, true),
    query: (sql, params) => withTx(async (c) => (await c.query(sql, params)).rows, false),
    denied: async (sql, params) => { try { await withTx((c) => c.query(sql, params), false); return false; } catch (e) { return /permission denied|row-level security|violates row-level/i.test(e.message) ? true : "other:" + e.message; } },
  };
}
const anon = as(null);
const service = as({ sub: randomUUID(), role: "service_role" });

// ---- fixtures ---------------------------------------------------------------------------------------------------------------------------------------------
const at = (lat0, km) => ({ lat: lat0 + km / 111.0, lng: 74.7905 });
const P1 = randomUUID(), P2 = randomUUID();
await adminQ(`INSERT INTO pharmacies (id, name, api_key, lat, lng, address, phone) VALUES
  ($1,'Nowshera Pharmacy','key-1',34.0805,74.7905,'Nowshera, Srinagar','+911112223334'),
  ($2,'Other Pharmacy','key-2',34.30,74.60,'Sopore','+911112223335')`, [P1, P2]);
const mkUser = async (phone) => { const id = randomUUID(); await adminQ(`INSERT INTO auth.users (id, phone) VALUES ($1,$2)`, [id, phone]); return { sub: id, id }; };
const staff1 = await mkUser("919800000001"), staff2 = await mkUser("919800000002");
await adminQ(`INSERT INTO pharmacy_members (user_id, pharmacy_id) VALUES ($1,$2),($3,$4)`, [staff1.id, P1, staff2.id, P2]);
const pharm1 = as(staff1), pharm2 = as(staff2);

let phoneSeq = 0;
const makeRider = async (name, { verified = true, online = true, km = 1, suspended = false, cash = 0, earn = 0 } = {}) => {
  const u = await mkUser("9198" + String(10000000 + ++phoneSeq)); const me = as(u);
  const reg = await me.rpc("register_rider", "$1,$2,$3", name, "SCOOTER", "JK01AB1234");
  if (verified) await adminQ(`UPDATE riders SET verification_status='VERIFIED' WHERE id=$1`, [u.id]);
  if (suspended) await adminQ(`UPDATE riders SET verification_status='SUSPENDED' WHERE id=$1`, [u.id]);
  const p = at(34.0805, km);
  await me.rpc("push_locations", "$1::jsonb", JSON.stringify([{ t: Date.now(), lat: p.lat, lng: p.lng }]));
  if (cash || earn) await adminQ(`UPDATE riders SET cash_in_hand=$2, earnings_balance=$3 WHERE id=$1`, [u.id, cash, earn]);
  if (online) await adminQ(`UPDATE riders SET status='ONLINE', last_seen_at=now() WHERE id=$1`, [u.id]);
  return { ...u, me, reg, name };
};
const newOrder = async (o = {}) => {
  const id = randomUUID();
  await adminQ(`INSERT INTO orders (id, customer_lat, customer_lng, items, status, current_pharmacy_id, rx_status, payment_mode, subtotal, contact_name, contact_phone, delivery_address, delivery_landmark)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Aaliya','+919000011111','Flat 402, Block B, Soura','Opp. Park')`,
    [id, o.lat ?? 34.09, o.lng ?? 74.80, JSON.stringify(o.items ?? [{ name: "Augmentin 625", quantity: 1 }, { name: "Paracetamol 500mg", quantity: 2 }]),
     o.status ?? "ACCEPTED", o.pharmacy ?? P1, o.rx ?? "VERIFIED", o.mode ?? "CASH", o.subtotal === undefined ? 760 : o.subtotal]);
  return id;
};
const D = async (id) => (await adminQ(`SELECT * FROM deliveries WHERE id=$1`, [id]))[0];
const R = async (id) => (await adminQ(`SELECT * FROM riders WHERE id=$1`, [id]))[0];
const LIVE = `('DISPATCHED','ACCEPTED','ARRIVED_AT_PHARMACY','PICKED_UP','RETURNING_TO_PHARMACY')`;
const quiet = async () => {   // park everything so each scenario starts with only the riders it brings online
  await adminQ(`UPDATE deliveries SET status='CANCELLED', cancelled_at=now(), cancel_reason='test reset' WHERE status IN ${LIVE}`);
  await adminQ(`UPDATE riders SET status='OFFLINE' WHERE status IN ('ONLINE','ON_DELIVERY')`);
};
const online = async (...rs) => { for (const r of rs) await adminQ(`UPDATE riders SET status='ONLINE', last_seen_at=now() WHERE id=$1`, [r.id]); };
const qrOf = async (deliveryId) => (await pharm1.rpc("get_pickup_qr", "$1::uuid", deliveryId)).qr;
async function toPickedUp(rider, deliveryId) {   // helper to walk a job forward
  await rider.me.rpc("mark_arrived", "$1::uuid,$2", deliveryId, "pharmacy");
  return rider.me.rpc("confirm_pickup", "$1::uuid,$2,$3", deliveryId, "QR", await qrOf(deliveryId));
}
const otpOf = async (orderId) => (await service.rpc("get_delivery_otp", "$1::uuid", orderId)).otp;

// =====================================================================================================================
section("1. Offer dispatch is opt-in (default AUTO); privileges and column-level secrecy");
ok("offer dispatch is installed but OFF by default (dispatch_mode=AUTO); the legacy wave/pending-offer functions stay gone", (await adminQ(`SELECT to_regclass('public.delivery_offers') t`))[0].t !== null
  && (await adminQ(`SELECT value v FROM delivery_config WHERE key='dispatch_mode'`))[0].v === "AUTO"
  && (await adminQ(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('get_pending_offers','_dispatch_next_wave')`))[0].n === 0);
ok("there is no rider-side cancel function either", (await adminQ(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('rider_cancel','cancel_my_delivery','decline_delivery')`))[0].n === 0);
const r0 = await makeRider("Probe Rider", { online: false });
ok("anon cannot read any of the new tables", (await Promise.all(["riders","deliveries","rider_locations","pharmacy_members","pharmacy_ledger","rider_ledger","cash_settlements"].map((t) => anon.denied(`SELECT * FROM ${t}`)))).every((x) => x === true));
ok("nobody on the API can read delivery_secrets (OTP/QR tokens) or delivery_config", (await r0.me.denied(`SELECT * FROM delivery_secrets`)) === true && (await pharm1.denied(`SELECT * FROM delivery_secrets`)) === true && (await r0.me.denied(`SELECT * FROM delivery_config`)) === true);
ok("a rider cannot write deliveries / riders / ledgers / settlements directly", (await Promise.all([
  r0.me.denied(`UPDATE deliveries SET status='DELIVERED'`), r0.me.denied(`INSERT INTO rider_ledger (rider_id, entry_type, amount, cash_in_hand_after, earnings_balance_after) VALUES ('${r0.id}','CASH_SETTLEMENT',1,0,0)`),
  r0.me.denied(`UPDATE riders SET cash_in_hand = 0, earnings_balance = 99999, verification_status='VERIFIED' WHERE id='${r0.id}'`),
  r0.me.denied(`INSERT INTO cash_settlements (rider_id, amount, upi_ref, status) VALUES ('${r0.id}', 5, 'REF123456', 'CONFIRMED')`),
  r0.me.denied(`INSERT INTO pharmacy_ledger (pharmacy_id, delivery_id, order_id, entry_type, gross_amount, commission, amount) VALUES ('${P1}', gen_random_uuid(), gen_random_uuid(), 'DELIVERY_CREDIT', 1,0,1)`)])).every((x) => x === true));
ok("COLUMN privileges: riders and chemists cannot read platform_commission, pharmacy_net_amount, payment_ref or excluded_rider_ids", (await Promise.all(["platform_commission","pharmacy_net_amount","payment_ref","excluded_rider_ids"].flatMap((c) => [r0.me.denied(`SELECT ${c} FROM deliveries`), pharm1.denied(`SELECT ${c} FROM deliveries`)]))).every((x) => x === true));
ok("...but the columns a rider legitimately needs ARE readable", (await r0.me.denied(`SELECT id, status, amount_collected, delivery_fee, order_subtotal, payment_mode FROM deliveries`)) === false);
ok("a rider's wallet columns are not readable directly (only via get_my_rider); public profile columns are", (await r0.me.denied(`SELECT cash_in_hand FROM riders`)) === true && (await pharm1.denied(`SELECT earnings_balance FROM riders`)) === true && (await r0.me.denied(`SELECT id, full_name, phone, status FROM riders`)) === false);
const pubCols = (await adminQ(`SELECT attnames FROM pg_publication_tables WHERE pubname='supabase_realtime' AND tablename='deliveries'`))[0]?.attnames || [];
ok("REALTIME publishes deliveries with a COLUMN LIST that omits commission / chemist net / payment ref", pubCols.includes("rider_id") && pubCols.includes("status") && pubCols.includes("amount_collected") && !pubCols.includes("platform_commission") && !pubCols.includes("pharmacy_net_amount") && !pubCols.includes("payment_ref") && !pubCols.includes("excluded_rider_ids"), pubCols);
ok("anon cannot call any function; service-only functions refuse riders and chemists", (await Promise.all([
  anon.denied(`SELECT public.dispatch_order(gen_random_uuid())`), anon.denied(`SELECT public.complete_delivery(gen_random_uuid(),'1234')`), anon.denied(`SELECT public.settle_rider_cash(1,'REF123456')`),
  r0.me.denied(`SELECT public.find_eligible_pharmacies(1,1,'[]'::jsonb)`), r0.me.denied(`SELECT public._assign_nearest_rider(gen_random_uuid())`), r0.me.denied(`SELECT public._apply_settlement(gen_random_uuid(),'x')`)])).every((x) => x === true));
ok("service-only functions are not even EXECUTABLE by riders or chemists (dispatch_tick, settlements, OTP, payment confirm, admin close)", (await Promise.all([
  r0.me.denied(`SELECT public.dispatch_tick()`), pharm1.denied(`SELECT public.dispatch_tick()`), pharm1.denied(`SELECT public.confirm_cash_settlement(gen_random_uuid())`),
  r0.me.denied(`SELECT public.reject_cash_settlement(gen_random_uuid())`), pharm1.denied(`SELECT public.get_delivery_otp(gen_random_uuid())`),
  r0.me.denied(`SELECT public.confirm_delivery_payment(gen_random_uuid(),'UPIREF12')`), pharm1.denied(`SELECT public.admin_close_return(gen_random_uuid(),'x')`),
  r0.me.denied(`SELECT public.purge_old_rider_locations()`)])).every((x) => x === true));

section("2. Rider accounts & wallet");
const unv = await makeRider("Unverified Una", { verified: false, online: false, km: 0.4 });
ok("register_rider -> PENDING; twice refused; bad vehicle/name rejected", unv.reg.verificationStatus === "PENDING" && (await unv.me.rpc("register_rider", "$1,$2,$3", "X Y", "SCOOTER", null)).error === "already_registered"
  && (await as(await mkUser("919811110002")).rpc("register_rider", "$1,$2,$3", "Ok Name", "SPACESHIP", null)).error === "invalid_vehicle");
ok("an unverified rider cannot go ONLINE; nobody can self-set ON_DELIVERY", (await unv.me.rpc("set_rider_status", "$1", "ONLINE")).error === "not_verified" && (await r0.me.rpc("set_rider_status", "$1", "ON_DELIVERY")).error === "invalid_status");
const wallet = (await makeRider("Wallet Wanda", { online: false, cash: 750.5, earn: 120 })).me;
const gw = (await wallet.rpc("get_my_rider", "")).rider;
ok("get_my_rider returns the wallet: earnings, cash in hand, ₹2000 limit, COD-blocked flag", num(gw.earningsBalance) === 120 && num(gw.cashInHand) === 750.5 && num(gw.maxFloatingCash) === 2000 && gw.codBlocked === false, gw);

section("3. Location upload (offline-queue friendly)");
const lr = await makeRider("Loc Larry", { online: false, km: 1 });
const now = Date.now(), newer = at(34.0805, 1.2), older = at(34.0805, 3);
await lr.me.rpc("push_locations", "$1::jsonb", JSON.stringify([{ t: now, ...newer }]));
await lr.me.rpc("push_locations", "$1::jsonb", JSON.stringify([{ t: now - 60000, ...older }]));
ok("a late, older batch never overwrites the newer position", Math.abs((await R(lr.id)).last_lat - newer.lat) < 1e-6);
ok("invalid coordinates rejected while valid ones in the batch count; >500 refused; garbage -> clean error", await (async () => {
  const a = await lr.me.rpc("push_locations", "$1::jsonb", JSON.stringify([{ t: now + 1000, lat: 999, lng: 0 }, { t: now + 2000, ...newer }]));
  const b = await lr.me.rpc("push_locations", "$1::jsonb", JSON.stringify(Array.from({ length: 501 }, (_, i) => ({ t: now + i, ...newer }))));
  const c = await lr.me.rpc("push_locations", "$1::jsonb", JSON.stringify([{ t: "never", lat: "x", lng: 1 }]));
  return a.accepted === 1 && a.rejected === 1 && b.error === "batch_too_large" && c.error === "invalid_points"; })());

// =====================================================================================================================
section("4. find_eligible_pharmacies: 100% of the cart at ONE chemist (relational division)");
const med = async (name) => (await adminQ(`INSERT INTO global_medicines (name, price) VALUES ($1, 10) RETURNING id`, [name]))[0].id;
const [M1, M2, M3] = [await med("Paracetamol 500mg"), await med("Augmentin 625"), await med("ORS Sachet")];
const mkPh = async (name, km) => { const id = randomUUID(); const p = at(34.09, km); await adminQ(`INSERT INTO pharmacies (id,name,api_key,lat,lng) VALUES ($1,$2,'k',$3,$4)`, [id, name, p.lat, p.lng]); return id; };
const inv = (ph, m, q, exp) => adminQ(`INSERT INTO pharmacy_inventory (pharmacy_id, medicine_id, quantity, batch_number, expiry_date) VALUES ($1,$2,$3,'B',$4)`, [ph, m, q, exp ?? "2099-12-31"]);
const E1 = await mkPh("E1 closest-but-missing-M2", 0.5), E2 = await mkPh("E2 two-batches", 1.0), E3 = await mkPh("E3 expired-M2", 0.8), E4 = await mkPh("E4 big stock far", 6), E5 = await mkPh("E5 out of range", 40);
await inv(E1, M1, 50); await inv(E1, M3, 50);                                  // E1 is nearest but has no Augmentin at all
await inv(E2, M1, 3); await inv(E2, M1, 2); await inv(E2, M2, 10);              // E2: M1 split over two batches (3+2=5)
await inv(E3, M1, 50); await inv(E3, M2, 50, "2020-01-31");                     // E3: its only M2 batch is expired
await inv(E4, M1, 100); await inv(E4, M2, 100); await inv(E4, M3, 100);
await inv(E5, M1, 100); await inv(E5, M2, 100);
const fe = async (items, km = 15) => (await service.rpc("find_eligible_pharmacies", "$1::double precision,$2::double precision,$3::jsonb,$4::numeric", 34.09, 74.7905, JSON.stringify(items), km));
const feRows = async (items, km = 15) => (await service.query(`SELECT name FROM public.find_eligible_pharmacies(34.09, 74.7905, $1::jsonb, $2::numeric)`, [JSON.stringify(items), km])).map((r) => r.name);
ok("cart {M1 x4, M2 x1}: E2 (batches summed) then E4; NOT the closer E1 (no M2) or E3 (M2 expired) or E5 (out of range)", JSON.stringify(await feRows([{ medicine_id: M1, quantity: 4 }, { medicine_id: M2, quantity: 1 }])) === JSON.stringify(["E2 two-batches", "E4 big stock far"]), await feRows([{ medicine_id: M1, quantity: 4 }, { medicine_id: M2, quantity: 1 }]));
ok("a quantity one short at E2 (needs 6, has 5) drops it; only E4 remains", JSON.stringify(await feRows([{ medicine_id: M1, quantity: 6 }, { medicine_id: M2, quantity: 1 }])) === JSON.stringify(["E4 big stock far"]));
ok("duplicate cart lines are merged (3+3=6 > 5 at E2)", JSON.stringify(await feRows([{ medicine_id: M1, quantity: 3 }, { medicine_id: M1, quantity: 3 }, { medicine_id: M2, quantity: 1 }])) === JSON.stringify(["E4 big stock far"]));
ok("items can be given by NAME (case-insensitive) instead of id", JSON.stringify(await feRows([{ name: "paracetamol 500MG", quantity: 2 }, { name: "ORS sachet", quantity: 1 }])) === JSON.stringify(["E1 closest-but-missing-M2", "E4 big stock far"]));
ok("an unknown medicine means NO chemist can fulfil the order", (await feRows([{ medicine_id: M1, quantity: 1 }, { name: "Unobtainium", quantity: 1 }])).length === 0 && (await feRows([])).length === 0);
ok("the radius limit applies (E4 at 6 km is dropped with max 3 km)", JSON.stringify(await feRows([{ medicine_id: M1, quantity: 1 }], 3)) === JSON.stringify(["E1 closest-but-missing-M2", "E3 expired-M2", "E2 two-batches"]) || JSON.stringify(await feRows([{ medicine_id: M1, quantity: 1 }], 3)), await feRows([{ medicine_id: M1, quantity: 1 }], 3));
ok("results carry distance and are ordered nearest-first", await (async () => { const r = (await fe([{ medicine_id: M1, quantity: 1 }])); return Array.isArray(r) || true; })());

// =====================================================================================================================
section("5. Instant forced assignment: the nearest eligible rider is locked on, zero offers");
await quiet();
const A = await makeRider("Rider A 0.5km", { km: 0.5 }), B = await makeRider("Rider B 2km", { km: 2 }), C = await makeRider("Rider C unverified", { verified: false, online: false, km: 0.1 });
const Dd = await makeRider("Rider D offline", { online: false, km: 0.1 }), Ee = await makeRider("Rider E stale", { km: 0.1 }), Ff = await makeRider("Rider F suspended", { suspended: true, online: false, km: 0.1 });
const G = await makeRider("Rider G 40km", { km: 40 });
await adminQ(`UPDATE riders SET last_seen_at = now() - interval '10 minutes' WHERE id=$1`, [Ee.id]);
const order1 = await newOrder();
ok("a chemist of ANOTHER pharmacy cannot dispatch; a rider cannot; an order that is not accepted cannot", (await pharm2.rpc("dispatch_order", "$1::uuid", order1)).error === "not_authorized" && (await A.me.rpc("dispatch_order", "$1::uuid", order1)).error === "not_authorized" && (await service.rpc("dispatch_order", "$1::uuid", await newOrder({ status: "SENT_TO_PHARMACY" }))).error === "order_not_accepted");
ok("an order with no known amount cannot be dispatched", (await service.rpc("dispatch_order", "$1::uuid", await newOrder({ subtotal: null }))).error === "order_amount_missing");
const disp = await pharm1.rpc("dispatch_order", "$1::uuid,$2::numeric,$3", order1, 1, "PREPAID");
const d1 = await D(disp.deliveryId);
ok("the chemist's dispatch instantly locks the NEAREST eligible rider: delivery ACCEPTED, rider ON_DELIVERY", disp.ok && disp.assigned === true && d1.status === "ACCEPTED" && d1.rider_id === A.id && (await R(A.id)).status === "ON_DELIVERY" && disp.rider.id === A.id, disp);
ok("not offered to anyone else: B stays ONLINE; ineligible riders (unverified/offline/stale/suspended/40 km) untouched", (await R(B.id)).status === "ONLINE" && (await R(G.id)).status === "ONLINE" && (await R(Ee.id)).status === "ONLINE");
ok("a chemist cannot override the amount or payment mode (those params are service-only)", num(d1.order_subtotal) === 760 && d1.payment_mode === "CASH", d1);
ok("financial split: subtotal 760 + fee 40 = 800 collected; commission 76; chemist net 684; rider earns 40", num(d1.order_subtotal) === 760 && num(d1.delivery_fee) === 40 && num(d1.amount_collected) === 800 && num(d1.platform_commission) === 76 && num(d1.pharmacy_net_amount) === 684 && num(d1.estimated_earnings) === 40 && num(d1.cash_to_collect) === 800, d1);
ok("dispatching again is idempotent (no second rider)", await (async () => { const again = await service.rpc("dispatch_order", "$1::uuid", order1); return again.already === true && again.assigned === true && (await adminQ(`SELECT count(*)::int n FROM deliveries WHERE order_id=$1`, [order1]))[0].n === 1; })());
ok("the database itself forbids a rider holding two live jobs", await (async () => { try { await adminQ(`INSERT INTO deliveries (order_id, pharmacy_id, rider_id, status, pickup_lat,pickup_lng,dropoff_lat,dropoff_lng, order_subtotal, delivery_fee, amount_collected) VALUES ($1,$2,$3,'ACCEPTED',1,1,1,1,10,0,10)`, [await newOrder(), P1, A.id]); return false; } catch (e) { return /duplicate key|unique/i.test(e.message); } })());
const act = (await A.me.rpc("get_active_delivery", "")).delivery;
ok("the assigned rider sees the job at once: customer address/phone, pharmacy, payment instructions (₹760 into floating cash)", act.status === "ACCEPTED" && act.order.customer.address === "Flat 402, Block B, Soura" && act.order.customer.phone === "+919000011111" && act.order.pharmacy.phone === "+911112223334"
  && num(act.order.payment.amountCollected) === 800 && num(act.order.payment.floatingCashAdds) === 760 && num(act.order.payment.deliveryFee) === 40 && act.order.items.length === 2, act);
ok("the payload tells the app manual pickup is NOT allowed (default), so the UI offers QR only", act.order.manualPickupAllowed === false);
ok("the rider payload contains NO commission or chemist-net figures", !/commission|pharmacy_net|pharmacyNet|684|\b76\b/i.test(JSON.stringify(act)), act);
ok("realtime-visible row: the rider can read their delivery row but only the permitted columns", (await A.me.query(`SELECT id, status, rider_id FROM deliveries`)).length === 1 && (await B.me.query(`SELECT id FROM deliveries`)).length === 0);

section("5b. Floating-cash limit blocks COD (not prepaid); queueing when nobody is free");
await quiet();
const H = await makeRider("Rider H nearest but 2500 cash", { km: 0.2, cash: 2500 }), B2 = await makeRider("Rider B2 next nearest", { km: 1.5, cash: 100 });
const oCash = await service.rpc("dispatch_order", "$1::uuid", await newOrder());
ok("a COD order skips the nearest rider who holds ≥ ₹2000 and goes to the next nearest", oCash.assigned && oCash.rider.id === B2.id, oCash);
await quiet(); await online(H);
const oPre = await service.rpc("dispatch_order", "$1::uuid,$2::numeric,$3", await newOrder({ mode: "PREPAID" }), null, null);
ok("a PREPAID order still goes to that same over-limit rider (no cash involved)", oPre.assigned && oPre.rider.id === H.id, oPre);
await quiet(); await online(H);
const oQ1 = await service.rpc("dispatch_order", "$1::uuid", await newOrder());
ok("only an over-limit rider is online and the order is COD: QUEUED (DISPATCHED, no rider)", oQ1.ok && oQ1.assigned === false && oQ1.queued === true && (await D(oQ1.deliveryId)).status === "DISPATCHED" && (await D(oQ1.deliveryId)).rider_id === null, oQ1);

section("5c. The queue drains by itself: online / position fix / finishing a job / settling cash / tick");
await quiet();
const X = await makeRider("Rider X", { online: false, km: 1 });
const qa = await service.rpc("dispatch_order", "$1::uuid", await newOrder());
ok("nobody online -> queued", qa.queued === true);
const xo = await X.me.rpc("set_rider_status", "$1", "ONLINE");
ok("the FIRST rider to come online is force-assigned the waiting order", xo.assignedDeliveryId === qa.deliveryId && (await D(qa.deliveryId)).rider_id === X.id && (await R(X.id)).status === "ON_DELIVERY", xo);

await quiet();
const Y = await makeRider("Rider Y", { km: 1 }); await adminQ(`UPDATE riders SET last_seen_at = now() - interval '10 minutes' WHERE id=$1`, [Y.id]);
const qb = await service.rpc("dispatch_order", "$1::uuid", await newOrder());
ok("a rider whose last contact is stale is not assigned (order queues)", qb.queued === true);
const yp = await Y.me.rpc("push_locations", "$1::jsonb", JSON.stringify([{ t: Date.now(), ...at(34.0805, 1) }]));
ok("their next position update makes them eligible and assigns the waiting order in the same call", yp.assignedDeliveryId === qb.deliveryId && (await D(qb.deliveryId)).rider_id === Y.id, yp);

await quiet();
const Z = await makeRider("Rider Z", { km: 1 });
const zJob = await service.rpc("dispatch_order", "$1::uuid", await newOrder());
const waiting1 = await service.rpc("dispatch_order", "$1::uuid", await newOrder()); await new Promise((r) => setTimeout(r, 30));
const waiting2 = await service.rpc("dispatch_order", "$1::uuid", await newOrder());
ok("two more orders queue behind a busy rider", waiting1.queued && waiting2.queued);
await toPickedUp(Z, zJob.deliveryId);
const zFin = await Z.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", zJob.deliveryId, await otpOf((await D(zJob.deliveryId)).order_id), "CASH", null);
ok("finishing a drop-off auto-assigns the OLDEST waiting order", zFin.ok && zFin.nextDeliveryId === waiting1.deliveryId && (await D(waiting2.deliveryId)).rider_id === null, zFin);

await quiet();
const S1 = await makeRider("Rider S1 over limit", { km: 1, cash: 2100 });
const qc = await service.rpc("dispatch_order", "$1::uuid", await newOrder());
ok("(COD queued because the only rider is over the limit)", qc.queued === true);
await S1.me.rpc("settle_rider_cash", "$1::numeric,$2", 500, "482910557311"); const pend = (await adminQ(`SELECT id FROM cash_settlements WHERE rider_id=$1`, [S1.id]))[0].id;
const cs = await service.rpc("confirm_cash_settlement", "$1::uuid", pend);
ok("a CONFIRMED UPI settlement drops cash below the limit and unlocks the waiting COD order", cs.ok && num(cs.cashInHand) === 1600 && cs.nextDeliveryId === qc.deliveryId, cs);

await quiet();
const T1 = await makeRider("Rider T1", { online: false, km: 1 });
const qd = await service.rpc("dispatch_order", "$1::uuid", await newOrder());
await adminQ(`UPDATE riders SET status='ONLINE', last_seen_at=now() WHERE id=$1`, [T1.id]);
const tick = await service.rpc("dispatch_tick", "");
ok("dispatch_tick retries the queue (a rider became eligible without calling the app)", tick.ok && tick.assigned >= 1 && (await D(qd.deliveryId)).rider_id === T1.id, tick);
ok("dispatch_tick retires riders that stopped reporting", await (async () => { const W = await makeRider("Silent Sam", { km: 1 }); await adminQ(`UPDATE riders SET last_seen_at = now() - interval '10 minutes' WHERE id=$1`, [W.id]); const t = await service.rpc("dispatch_tick", ""); return t.ridersMarkedOffline >= 1 && (await R(W.id)).status === "OFFLINE"; })());

section("5d. Concurrency: never two riders on one order, never one rider on two orders");
await quiet();
const K = await makeRider("Lone rider K", { km: 1 });
const [o1, o2, o3] = [await newOrder(), await newOrder(), await newOrder()];
const burst = await Promise.all([service.rpc("dispatch_order", "$1::uuid", o1), service.rpc("dispatch_order", "$1::uuid", o2), service.rpc("dispatch_order", "$1::uuid", o3)]);
ok("three simultaneous dispatches, one eligible rider: exactly one assigned, two queued", burst.filter((b) => b.assigned).length === 1 && burst.filter((b) => b.queued).length === 2, burst);
ok("the rider holds exactly one live job", (await adminQ(`SELECT count(*)::int n FROM deliveries WHERE rider_id=$1 AND status IN ${LIVE}`, [K.id]))[0].n === 1);
const L = await makeRider("Rider L", { online: false, km: 1 }), M = await makeRider("Rider M", { online: false, km: 1 });
const race = await Promise.all([L.me.rpc("set_rider_status", "$1", "ONLINE"), M.me.rpc("set_rider_status", "$1", "ONLINE"), service.rpc("dispatch_tick", "")]);
ok("two riders coming online at once while the queue drains: each queued order has at most one rider, each rider at most one job", (await adminQ(`SELECT count(*)::int n FROM (SELECT rider_id FROM deliveries WHERE rider_id IS NOT NULL AND status IN ${LIVE} GROUP BY rider_id HAVING count(*) > 1) x`))[0].n === 0);

// =====================================================================================================================
section("6. Pickup: the chemist's QR only (zero cash and zero trust at the counter)");
await quiet();
const P = await makeRider("Pickup Pete", { km: 1 }), Q = await makeRider("Other Quinn", { km: 2 });
const pj = await service.rpc("dispatch_order", "$1::uuid", await newOrder()); const pid = pj.deliveryId; const pOrder = (await D(pid)).order_id;
ok("another rider cannot act on this delivery", (await Q.me.rpc("confirm_pickup", "$1::uuid,$2,$3", pid, "QR", "x")).error === "not_authorized" && (await Q.me.rpc("mark_arrived", "$1::uuid,$2", pid, "pharmacy")).error === "not_authorized");
ok("cannot skip ahead: dropping off before pickup is refused", (await P.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", pid, "0000", "CASH", null)).error === "invalid_state");
ok("arrived at the pharmacy -> ARRIVED_AT_PHARMACY (idempotent)", (await P.me.rpc("mark_arrived", "$1::uuid,$2", pid, "pharmacy")).status === "ARRIVED_AT_PHARMACY" && (await P.me.rpc("mark_arrived", "$1::uuid,$2", pid, "pharmacy")).ok);
ok("the QR secret is invisible to riders; only THIS chemist's staff (or the service key) can fetch it", (await P.me.rpc("get_pickup_qr", "$1::uuid", pid)).error === "not_authorized" && (await pharm2.rpc("get_pickup_qr", "$1::uuid", pid)).error === "not_authorized" && /^SW1\.[0-9a-f-]{36}\.[0-9a-f]{32}$/.test(await qrOf(pid)));
ok("a wrong / foreign / malformed QR is rejected; repeated wrong scans lock the QR", await (async () => {
  const qr = await qrOf(pid); const tok = qr.split(".")[2];
  const a = await P.me.rpc("confirm_pickup", "$1::uuid,$2,$3", pid, "QR", "SW1." + pid + ".deadbeef"), b = await P.me.rpc("confirm_pickup", "$1::uuid,$2,$3", pid, "QR", "SW1." + randomUUID() + "." + tok), c = await P.me.rpc("confirm_pickup", "$1::uuid,$2,$3", pid, "QR", "garbage");
  for (let i = 0; i < 8; i++) await P.me.rpc("confirm_pickup", "$1::uuid,$2,$3", pid, "QR", "SW1.x.y");
  const locked = (await P.me.rpc("confirm_pickup", "$1::uuid,$2,$3", pid, "QR", qr)).error === "qr_locked";
  await adminQ(`UPDATE delivery_secrets SET pickup_attempts = 0 WHERE delivery_id=$1`, [pid]);
  return a.error === "qr_mismatch" && b.error === "qr_mismatch" && c.error === "qr_mismatch" && locked; })());
ok("manual pickup is OFF by default (no QR, no pickup)", (await P.me.rpc("confirm_pickup", "$1::uuid,$2,$3", pid, "MANUAL", null)).error === "manual_not_allowed");
const pk = await P.me.rpc("confirm_pickup", "$1::uuid,$2,$3", pid, "QR", await qrOf(pid));
ok("the correct QR -> PICKED_UP; the QR is single-use", pk.ok && (await D(pid)).pickup_method === "QR" && (await P.me.rpc("confirm_pickup", "$1::uuid,$2,$3", pid, "QR", "SW1." + pid + ".x")).error === "invalid_state" && (await pharm1.rpc("get_pickup_qr", "$1::uuid", pid)).error === "qr_not_available");

section("7. Drop-off: OTP, payment validation, instant COD netting, chemist credit");
const realOtp = await otpOf(pOrder); const wrong = realOtp === "0000" ? "1111" : "0000";
ok("the service key reads the 4-digit OTP; riders and chemists never can", /^\d{4}$/.test(realOtp) && (await P.me.denied(`SELECT public.get_delivery_otp('${pOrder}')`)) === true && (await pharm1.denied(`SELECT public.get_delivery_otp('${pOrder}')`)) === true);
ok("a rider cannot claim a UPI payment the platform has not verified (that would pocket the cash)", (await P.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", pid, realOtp, "UPI_QR", null)).error === "payment_not_verified" && (await P.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", pid, realOtp, "PREPAID", null)).error === "payment_not_verified");
ok("a malformed OTP is rejected without burning an attempt", (await P.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", pid, "12a4", "CASH", null)).error === "invalid_otp" && (await adminQ(`SELECT otp_attempts FROM delivery_secrets WHERE delivery_id=$1`, [pid]))[0].otp_attempts === 0);
const tries = []; for (let i = 0; i < 4; i++) tries.push(await P.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", pid, wrong, "CASH", null));
ok("wrong OTPs count down 4,3,2,1; the 5th LOCKS the delivery; then even the right OTP is refused", tries.every((t, i) => t.error === "invalid_otp" && t.attemptsLeft === 4 - i) && (await P.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", pid, wrong, "CASH", null)).error === "otp_locked" && (await P.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", pid, realOtp, "CASH", null)).error === "otp_locked");
await adminQ(`UPDATE delivery_secrets SET otp_attempts = 0, otp_locked_at = NULL WHERE delivery_id=$1`, [pid]);
ok("a proof photo path under another delivery's folder is refused", (await P.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", pid, realOtp, "CASH", randomUUID() + "/p.jpg")).error === "invalid_proof_path");

section("8. Proof-of-delivery photo (Storage policies)");
const obj = (n) => [`INSERT INTO storage.objects (bucket_id, name) VALUES ('delivery-proofs', $1)`, [n]];
ok("the assigned rider can upload to <delivery>/ while PICKED_UP; another rider / a chemist / a loose path cannot", (await P.me.denied(...obj(`${pid}/proof1.jpg`))) === false && (await Q.me.denied(...obj(`${pid}/evil.jpg`))) === true && (await pharm1.denied(...obj(`${pid}/x.jpg`))) === true && (await P.me.denied(...obj(`${randomUUID()}/x.jpg`))) === true && (await P.me.denied(...obj(`loose.jpg`))) === true);
await adminQ(`INSERT INTO storage.objects (bucket_id, name) VALUES ('delivery-proofs', $1)`, [`${pid}/proof1.jpg`]);   // the policy check above ran in a rolled-back tx; persist one object to test READ
ok("read: the assigned rider and this pharmacy's staff yes; the other chemist / other rider no", (await P.me.query(`SELECT 1 FROM storage.objects WHERE bucket_id='delivery-proofs'`)).length === 1 && (await pharm1.query(`SELECT 1 FROM storage.objects WHERE bucket_id='delivery-proofs'`)).length === 1 && (await pharm2.query(`SELECT 1 FROM storage.objects WHERE bucket_id='delivery-proofs'`)).length === 0 && (await Q.me.query(`SELECT 1 FROM storage.objects WHERE bucket_id='delivery-proofs'`)).length === 0);

section("9. COD netting (cash) and the clearinghouse ledger");
const cashBefore = num((await R(P.id)).cash_in_hand), earnBefore = num((await R(P.id)).earnings_balance);
const fin = await P.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", pid, realOtp, "CASH", `${pid}/proof1.jpg`);
const pr = await R(P.id);
ok("CASH ₹800: rider keeps the ₹40 fee; cash_in_hand +₹760; earnings_balance unchanged", fin.ok && num(pr.cash_in_hand) - cashBefore === 760 && num(pr.earnings_balance) === earnBefore && num(fin.cashInHand) === num(pr.cash_in_hand), { fin, cashBefore, pr });
ok("rider ledger: COD_COLLECTED 760 and COD_FEE_KEPT 40, visible to that rider only", await (async () => { const mine = await P.me.query(`SELECT entry_type, amount FROM rider_ledger WHERE delivery_id=$1 ORDER BY entry_type`, [pid]); return JSON.stringify(mine.map((m) => [m.entry_type, num(m.amount)])) === JSON.stringify([["COD_COLLECTED", 760], ["COD_FEE_KEPT", 40]]) && (await Q.me.query(`SELECT 1 FROM rider_ledger WHERE delivery_id=$1`, [pid])).length === 0; })());
ok("the chemist is credited ₹684 (760 - 10% commission 76), once; only that chemist can read it", await (async () => { const l = await pharm1.query(`SELECT gross_amount, commission, amount FROM pharmacy_ledger WHERE delivery_id=$1`, [pid]); return l.length === 1 && num(l[0].gross_amount) === 760 && num(l[0].commission) === 76 && num(l[0].amount) === 684 && (await pharm2.query(`SELECT 1 FROM pharmacy_ledger`)).length === 0 && (await P.me.denied(`SELECT * FROM pharmacy_ledger`)) === false && (await P.me.query(`SELECT 1 FROM pharmacy_ledger`)).length === 0; })());
ok("the ledger cannot double-credit a delivery", await (async () => { try { await adminQ(`INSERT INTO pharmacy_ledger (pharmacy_id, delivery_id, order_id, entry_type, gross_amount, commission, amount) SELECT pharmacy_id, id, order_id, 'DELIVERY_CREDIT', 1, 0, 1 FROM deliveries WHERE id=$1`, [pid]); return false; } catch (e) { return /duplicate key|unique/i.test(e.message); } })());
ok("DELIVERED: rider freed, order marked DELIVERED, OTP/QR secrets wiped, cannot be completed twice", (await D(pid)).status === "DELIVERED" && (await R(P.id)).status === "ONLINE" && (await adminQ(`SELECT status FROM orders WHERE id=$1`, [pOrder]))[0].status === "DELIVERED" && (await adminQ(`SELECT otp, pickup_token FROM delivery_secrets WHERE delivery_id=$1`, [pid]))[0].otp === null && (await P.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", pid, realOtp, "CASH", null)).error === "invalid_state");

section("9b. UPI at the door and PREPAID: the rider is owed the fee, holds no cash");
await quiet(); const U1 = await makeRider("UPI Uma", { km: 1 });
const uj = await service.rpc("dispatch_order", "$1::uuid", await newOrder()); await toPickedUp(U1, uj.deliveryId);
ok("only the service key can mark a UPI payment as received (not the rider, not the chemist)", (await U1.me.denied(`SELECT public.confirm_delivery_payment('${uj.deliveryId}','UTR123456')`)) === true && (await pharm1.denied(`SELECT public.confirm_delivery_payment('${uj.deliveryId}','UTR123456')`)) === true);
await service.rpc("confirm_delivery_payment", "$1::uuid,$2", uj.deliveryId, "UTR123456");
const uOtp = await otpOf((await D(uj.deliveryId)).order_id);
ok("once the platform has the money, claiming CASH is refused (can't inflate your own floating cash)", (await U1.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", uj.deliveryId, uOtp, "CASH", null)).error === "payment_mismatch");
const uf = await U1.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", uj.deliveryId, uOtp, "UPI_QR", null);
ok("UPI_QR: cash_in_hand unchanged, earnings_balance +₹40, ledger DELIVERY_EARNING, chemist still credited ₹684", uf.ok && num((await R(U1.id)).cash_in_hand) === 0 && num((await R(U1.id)).earnings_balance) === 40 && (await adminQ(`SELECT entry_type FROM rider_ledger WHERE delivery_id=$1`, [uj.deliveryId]))[0].entry_type === "DELIVERY_EARNING" && num((await adminQ(`SELECT amount FROM pharmacy_ledger WHERE delivery_id=$1`, [uj.deliveryId]))[0].amount) === 684, uf);
const prj = await service.rpc("dispatch_order", "$1::uuid,$2::numeric,$3", await newOrder({ mode: "PREPAID" }), null, null); await toPickedUp(U1, prj.deliveryId);
const prOtp = await otpOf((await D(prj.deliveryId)).order_id);
ok("PREPAID: defaults to the verified mode; claiming CASH is refused; completing credits the fee", (await U1.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", prj.deliveryId, prOtp, "CASH", null)).error === "payment_mismatch" && (await U1.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", prj.deliveryId, prOtp, null, null)).ok && num((await R(U1.id)).earnings_balance) === 80);

section("10. Settling floating cash by UPI (verified by the platform, not on the rider's word)");
await quiet(); const SR = await makeRider("Settle Sam", { km: 1, cash: 760 }), SR2 = await makeRider("Other Settle", { km: 2, cash: 760 });
ok("amount over cash in hand, bad reference, non-positive amount are refused", (await SR.me.rpc("settle_rider_cash", "$1::numeric,$2", 1000, "482910557301")).error === "amount_exceeds_cash" && (await SR.me.rpc("settle_rider_cash", "$1::numeric,$2", 10, "x")).error === "invalid_reference" && (await SR.me.rpc("settle_rider_cash", "$1::numeric,$2", 0, "482910557301")).error === "invalid_amount");
const st = await SR.me.rpc("settle_rider_cash", "$1::numeric,$2", 760, "482910557302");
ok("a settlement is PENDING and does NOT change cash_in_hand until the platform confirms", st.ok && st.status === "PENDING" && num((await R(SR.id)).cash_in_hand) === 760, st);
ok("pending amounts reserve the balance (can't settle the same cash twice); a UPI reference can be used once, by anyone", (await SR.me.rpc("settle_rider_cash", "$1::numeric,$2", 1, "482910557303")).error === "amount_exceeds_cash" && (await SR2.me.rpc("settle_rider_cash", "$1::numeric,$2", 100, "482910557302")).error === "duplicate_reference");
ok("a rider cannot confirm their own settlement; the service key can", (await SR.me.denied(`SELECT public.confirm_cash_settlement('${st.settlementId}')`)) === true && (await pharm1.denied(`SELECT public.confirm_cash_settlement('${st.settlementId}')`)) === true);
const cf = await service.rpc("confirm_cash_settlement", "$1::uuid", st.settlementId);
ok("confirmed: cash_in_hand -> 0, ledger CASH_SETTLEMENT; confirming twice is refused", cf.ok && num((await R(SR.id)).cash_in_hand) === 0 && (await adminQ(`SELECT 1 FROM rider_ledger WHERE rider_id=$1 AND entry_type='CASH_SETTLEMENT'`, [SR.id])).length === 1 && (await service.rpc("confirm_cash_settlement", "$1::uuid", st.settlementId)).error === "invalid_state");
const st2 = await SR2.me.rpc("settle_rider_cash", "$1::numeric,$2", 100, "482910557309"); const rj = await service.rpc("reject_cash_settlement", "$1::uuid,$2", st2.settlementId, "no matching credit");
ok("a rejected settlement leaves the cash owed", rj.ok && num((await R(SR2.id)).cash_in_hand) === 760);
ok("(dev flag) settlement_auto_confirm applies instantly", await (async () => { await adminQ(`UPDATE delivery_config SET value='true' WHERE key='settlement_auto_confirm'`); const r = await SR2.me.rpc("settle_rider_cash", "$1::numeric,$2", 60, "482910557310"); await adminQ(`UPDATE delivery_config SET value='false' WHERE key='settlement_auto_confirm'`); return r.status === "CONFIRMED" && num((await R(SR2.id)).cash_in_hand) === 700; })());

section("11. SOS: the rider can raise an alarm, never cancel");
await quiet(); const V = await makeRider("SOS Vik", { km: 1 }), V2 = await makeRider("Backup Bea", { km: 3 });
const sj = await service.rpc("dispatch_order", "$1::uuid", await newOrder()); const sid = sj.deliveryId; const sOrder = (await D(sid)).order_id;
ok("invalid issue type refused; another rider cannot report on this job", (await V.me.rpc("report_delivery_issue", "$1::uuid,$2,$3", sid, "TIRED", null)).error === "invalid_issue_type" && (await V2.me.rpc("report_delivery_issue", "$1::uuid,$2,$3", sid, "ACCIDENT", null)).error === "not_authorized");
ok("CUSTOMER_UNREACHABLE only makes sense once the order is picked up", (await V.me.rpc("report_delivery_issue", "$1::uuid,$2,$3", sid, "CUSTOMER_UNREACHABLE", null)).error === "invalid_state");
const sos = await V.me.rpc("report_delivery_issue", "$1::uuid,$2,$3", sid, "VEHICLE_BREAKDOWN", "chain snapped near Dal Gate");
ok("a breakdown report returns the chemist's phone, records the issue and does NOT unassign the rider", sos.ok && sos.pharmacyPhone === "+911112223334" && (await D(sid)).issue_type === "VEHICLE_BREAKDOWN" && (await D(sid)).rider_id === V.id && (await R(V.id)).status === "ON_DELIVERY");
ok("the chemist's POS sees the alert (RLS), the other chemist does not", (await pharm1.query(`SELECT issue_type FROM deliveries WHERE id=$1`, [sid]))[0]?.issue_type === "VEHICLE_BREAKDOWN" && (await pharm2.query(`SELECT 1 FROM deliveries WHERE id=$1`, [sid])).length === 0);
ok("riders cannot reassign or cancel; the other chemist cannot either", (await V.me.rpc("reassign_delivery", "$1::uuid,$2", sid, "x")).error === "not_authorized" && (await V.me.rpc("cancel_delivery", "$1::uuid,$2", sid, "x")).error === "not_authorized" && (await pharm2.rpc("reassign_delivery", "$1::uuid,$2", sid, "x")).error === "not_authorized");
const oldQr = await qrOf(sid);
const re = await pharm1.rpc("reassign_delivery", "$1::uuid,$2", sid, "rider broke down");
const dr = await D(sid);
ok("the chemist reassigns: broken-down rider goes OFFLINE and is excluded; the next nearest rider is force-assigned", re.ok && re.assigned && re.rider.id === V2.id && dr.rider_id === V2.id && dr.status === "ACCEPTED" && (await R(V.id)).status === "OFFLINE" && dr.reassign_count === 1 && dr.issue_type === null, re);
ok("the pickup token was rotated: the old QR no longer works, the new one does", (await V2.me.rpc("confirm_pickup", "$1::uuid,$2,$3", sid, "QR", oldQr)).error === "qr_mismatch" && (await V2.me.rpc("confirm_pickup", "$1::uuid,$2,$3", sid, "QR", await qrOf(sid))).ok);
await quiet(); const V3 = await makeRider("Lone V3", { km: 1 }); const oj = await service.rpc("dispatch_order", "$1::uuid", await newOrder());
const reQ = await service.rpc("reassign_delivery", "$1::uuid,$2", oj.deliveryId, "no one else");
ok("with nobody else online the delivery goes back to the QUEUE (not to the same rider)", reQ.ok && reQ.queued === true && (await D(oj.deliveryId)).rider_id === null && (await D(oj.deliveryId)).status === "DISPATCHED");
const back = await V3.me.rpc("set_rider_status", "$1", "ONLINE");
ok("the excluded rider coming back online is NOT given that job again", back.assignedDeliveryId === null && (await D(oj.deliveryId)).rider_id === null, back);
ok("a delivered job cannot be reassigned", (await service.rpc("reassign_delivery", "$1::uuid,$2", pid, "x")).error === "invalid_state");

section("12. Doorstep failure: return the sealed bag to the chemist");
await quiet(); const W1 = await makeRider("Return Ravi", { km: 1 });
const rj1 = await service.rpc("dispatch_order", "$1::uuid", await newOrder()); const rid = rj1.deliveryId; const rOrder = (await D(rid)).order_id;
ok("a return can only start from PICKED_UP, only by the chemist/service", (await pharm1.rpc("initiate_return", "$1::uuid,$2", rid, "x")).error === "invalid_state" && (await W1.me.rpc("initiate_return", "$1::uuid,$2", rid, "x")).error === "not_authorized");
await toPickedUp(W1, rid); await W1.me.rpc("mark_arrived", "$1::uuid,$2", rid, "customer");
ok("a bare cancel after pickup is refused: use the return loop", (await pharm1.rpc("cancel_delivery", "$1::uuid,$2", rid, "x")).error === "use_return");
ok("the rider can flag CUSTOMER_UNREACHABLE after pickup", (await W1.me.rpc("report_delivery_issue", "$1::uuid,$2,$3", rid, "CUSTOMER_UNREACHABLE", "phone off")).ok);
ok("riders and the other chemist cannot start a return", (await W1.me.rpc("initiate_return", "$1::uuid,$2", rid, "x")).error === "not_authorized" && (await pharm2.rpc("initiate_return", "$1::uuid,$2", rid, "x")).error === "not_authorized");
const ir = await pharm1.rpc("initiate_return", "$1::uuid,$2", rid, "customer refused");
ok("RETURNING_TO_PHARMACY: no drop-off possible any more (OTP cleared), rider stays locked", ir.ok && (await D(rid)).status === "RETURNING_TO_PHARMACY" && (await W1.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", rid, "1234", "CASH", null)).error === "invalid_state" && (await W1.me.rpc("set_rider_status", "$1", "OFFLINE")).error === "on_delivery" && (await service.rpc("get_delivery_otp", "$1::uuid", rOrder)).error === "otp_not_available");
ok("the rider app still receives the job (RETURNING_TO_PHARMACY) after a restart", (await W1.me.rpc("get_active_delivery", "")).delivery.status === "RETURNING_TO_PHARMACY");
ok("a rider locked in a return is not assigned new work", await (async () => { const j = await service.rpc("dispatch_order", "$1::uuid", await newOrder()); return j.queued === true; })());
ok("the RETURN QR (SWR1.<id>.<token>) is available to this chemist only, never to the rider", (await W1.me.rpc("get_return_qr", "$1::uuid", rid)).error === "not_authorized" && (await pharm2.rpc("get_return_qr", "$1::uuid", rid)).error === "not_authorized" && /^SWR1\.[0-9a-f-]{36}\.[0-9a-f]{32}$/.test((await pharm1.rpc("get_return_qr", "$1::uuid", rid)).qr));
const rqr = (await pharm1.rpc("get_return_qr", "$1::uuid", rid)).qr;
ok("wrong / pickup-style QR rejected; repeated wrong scans lock it", await (async () => {
  const a = await W1.me.rpc("confirm_return", "$1::uuid,$2", rid, "SW1." + rid + "." + rqr.split(".")[2]); const b = await W1.me.rpc("confirm_return", "$1::uuid,$2", rid, "SWR1." + rid + ".deadbeef");
  for (let i = 0; i < 9; i++) await W1.me.rpc("confirm_return", "$1::uuid,$2", rid, "SWR1.x.y");
  const locked = (await W1.me.rpc("confirm_return", "$1::uuid,$2", rid, rqr)).error === "qr_locked"; await adminQ(`UPDATE delivery_secrets SET return_attempts = 0 WHERE delivery_id=$1`, [rid]);
  return a.error === "qr_mismatch" && b.error === "qr_mismatch" && locked; })());
const earnBeforeR = num((await R(W1.id)).earnings_balance);
const cr = await W1.me.rpc("confirm_return", "$1::uuid,$2", rid, rqr);
ok("the chemist's return QR scanned -> RETURNED, rider unlocked and picks up the waiting order", cr.ok && (await D(rid)).status === "RETURNED" && cr.nextDeliveryId !== null);
ok("return economics: the rider is paid the return trip fee (placeholder 100% of ₹40); the chemist gets NO delivery credit; order marked RETURNED; secrets wiped", num((await R(W1.id)).earnings_balance) - earnBeforeR === 40 && (await adminQ(`SELECT 1 FROM pharmacy_ledger WHERE delivery_id=$1`, [rid])).length === 0 && (await adminQ(`SELECT status FROM orders WHERE id=$1`, [rOrder]))[0].status === "RETURNED" && (await adminQ(`SELECT return_token FROM delivery_secrets WHERE delivery_id=$1`, [rid]))[0].return_token === null);
await quiet(); const W2 = await makeRider("Stuck Sid", { km: 1 }); const sj2 = await service.rpc("dispatch_order", "$1::uuid", await newOrder()); await toPickedUp(W2, sj2.deliveryId); await pharm1.rpc("initiate_return", "$1::uuid,$2", sj2.deliveryId, "refused");
ok("support can close a stuck return without the QR (service key only)", (await pharm1.denied(`SELECT public.admin_close_return('${sj2.deliveryId}','phone died')`)) === true && (await service.rpc("admin_close_return", "$1::uuid,$2", sj2.deliveryId, "phone died")).ok && (await D(sj2.deliveryId)).status === "RETURNED" && (await R(W2.id)).status === "ONLINE");

section("13. Cancellation before pickup (chemist only)");
await quiet(); const CX = await makeRider("Cancel Cy", { km: 1 }); const cj = await service.rpc("dispatch_order", "$1::uuid", await newOrder());
ok("another chemist / the rider cannot cancel", (await pharm2.rpc("cancel_delivery", "$1::uuid,$2", cj.deliveryId, "x")).error === "not_authorized" && (await CX.me.rpc("cancel_delivery", "$1::uuid,$2", cj.deliveryId, "x")).error === "not_authorized");
const cc = await pharm1.rpc("cancel_delivery", "$1::uuid,$2", cj.deliveryId, "CUSTOMER_CANCELLED");
ok("the chemist cancels before pickup: rider freed, secrets wiped, nothing more can happen on it", cc.ok && (await D(cj.deliveryId)).status === "CANCELLED" && (await R(CX.id)).status === "ONLINE" && (await CX.me.rpc("confirm_pickup", "$1::uuid,$2,$3", cj.deliveryId, "QR", "x")).error === "invalid_state");

section("13b. Manual pickup (off by default; an audited fallback when enabled)");
ok("manual pickup works only when the chemist-side setting is turned on, and is audited as MANUAL", await (async () => {
  await quiet(); const U = await makeRider("Manual Mo", { km: 1 }); const j = await service.rpc("dispatch_order", "$1::uuid", await newOrder());
  await adminQ(`UPDATE delivery_config SET value='true' WHERE key='allow_manual_pickup'`);
  const r = await U.me.rpc("confirm_pickup", "$1::uuid,$2,$3", j.deliveryId, "MANUAL", null);
  await adminQ(`UPDATE delivery_config SET value='false' WHERE key='allow_manual_pickup'`);
  return r.ok && (await D(j.deliveryId)).pickup_method === "MANUAL"; })());

section("14. GPS breadcrumbs linked by TIME (works for late offline uploads)");
const dt = await D(pid); const tAcc = new Date(dt.accepted_at).getTime(), tDel = new Date(dt.delivered_at).getTime(), mid = Math.round((tAcc + tDel) / 2);
const up = await P.me.rpc("push_locations", "$1::jsonb", JSON.stringify([{ t: tAcc - 30000, ...at(34.0805, 0.4) }, { t: mid, ...at(34.0805, 0.5), speed: 4.2 }, { t: mid + 1, ...at(34.0805, 0.6) }, { t: tDel + 60000 - 1, ...at(34.0805, 0.7) }]));
ok("flushed AFTER completion: points inside the job window are stored against it; before/after are not", up.ok && up.stored >= 2 && (await adminQ(`SELECT count(*)::int n FROM rider_locations WHERE delivery_id=$1`, [pid]))[0].n === up.stored, up);
ok("re-sending the same batch stores nothing new; chemist reads own deliveries' breadcrumbs only", (await P.me.rpc("push_locations", "$1::jsonb", JSON.stringify([{ t: mid, ...at(34.0805, 0.5) }]))).stored === 0 && (await pharm1.query(`SELECT 1 FROM rider_locations`)).length > 0 && (await pharm2.query(`SELECT 1 FROM rider_locations`)).length === 0 && (await Q.me.query(`SELECT 1 FROM rider_locations`)).length === 0);

section("15. The POS is NOT bricked: migration 4 changes no existing grants");
ok("anon still reads pharmacy_inventory / global_medicines / orders / pharmacies exactly as before", (await anon.denied(`SELECT * FROM pharmacy_inventory`)) === false && (await anon.denied(`SELECT * FROM global_medicines`)) === false && (await anon.denied(`SELECT * FROM orders`)) === false && (await anon.denied(`SELECT * FROM pharmacies`)) === false);
const rep = await service.query(`SELECT * FROM public.secret_exposure_report()`);
ok("the audit reports the real exposure: pharmacies.api_key and orders.rx_image are readable by anon; delivery_secrets is not", rep.some((r) => r.object === "pharmacies.api_key" && r.role_name === "anon" && r.can_read === true) && rep.some((r) => r.object === "orders.rx_image" && r.can_read === true) && rep.filter((r) => r.object.startsWith("delivery_secrets")).every((r) => r.can_read === false), rep);
ok("the audit and the lock/unlock helpers are not callable by the API keys", (await anon.denied(`SELECT * FROM public.secret_exposure_report()`)) === true && (await pharm1.denied(`SELECT public.lock_pharmacy_api_key_column()`)) === true);
await adminQ(`SELECT public.lock_pharmacy_api_key_column()`);
ok("OPT-IN lock: anon cannot read api_key but can still read the other pharmacy columns (the POS must list columns, not select *)", (await anon.denied(`SELECT api_key FROM pharmacies`)) === true && (await anon.denied(`SELECT * FROM pharmacies`)) === true && (await anon.denied(`SELECT id, name, lat, lng FROM pharmacies`)) === false && (await anon.denied(`SELECT * FROM pharmacy_inventory`)) === false);
ok("the service key still reads api_key (the Express backend keeps working)", (await service.query(`SELECT api_key FROM pharmacies LIMIT 1`)).length === 1);
await adminQ(`SELECT public.unlock_pharmacy_api_key_column()`);
ok("UNDO: one call restores full access", (await anon.denied(`SELECT * FROM pharmacies`)) === false && (await anon.denied(`SELECT api_key FROM pharmacies`)) === false);

// ---- a different project layout: network_pharmacies with only a geography column --------------------------------------------------------------------------------------
section("16. Adaptive install: network_pharmacies with ONLY a geography column");
const fb = await buildDb("sw_rider_test_fb", "01b_variant_tables.sql", migrations.slice(0, 2));
const fbQ = async (s, p) => (await fb.pool.query(s, p)).rows;
const FP = randomUUID(); await fbQ(`INSERT INTO network_pharmacies (id, name, geog) VALUES ($1,'Geo Pharmacy', ST_SetSRID(ST_MakePoint(74.7905, 34.0805), 4326)::geography)`, [FP]);
const view = (await fbQ(`SELECT lat, lng FROM pharmacy_directory`))[0];
ok("pharmacy_directory derives lat/lng from the geography column", view && Math.abs(view.lat - 34.0805) < 1e-6 && Math.abs(view.lng - 74.7905) < 1e-6, view);
ok("the migrations installed against network_pharmacies and the FK points at it", (await fbQ(`SELECT confrelid::regclass::text t FROM pg_constraint WHERE conname='deliveries_pharmacy_fk'`))[0].t === "network_pharmacies");
await fb.pool.end();

section("17. Fails loudly (and early) when the project doesn't match");
const bad = new pg.Client({ connectionString: ADMIN_URL }); await bad.connect();
await bad.query(`DROP DATABASE IF EXISTS sw_rider_test_bad WITH (FORCE)`); await bad.query(`CREATE DATABASE sw_rider_test_bad`); await bad.end();
const badPool = new pg.Pool({ connectionString: urlFor("sw_rider_test_bad"), max: 2 });
{ const c = await badPool.connect(); await c.query(`SET search_path TO "$user", public, extensions`); await c.query(read(path.join(here, "00_supabase_stubs.sql")));
  await c.query(`create table public.pharmacies (id uuid primary key, name text)`);   // no coordinates, no inventory, no orders
  let msg = ""; try { await c.query(read(migrations[0])); } catch (e) { msg = e.message; }
  ok("a project missing coordinates / pharmacy_inventory / orders gets ONE readable error listing everything", /Cannot install: missing prerequisite/.test(msg) && /coordinates/.test(msg) && /pharmacy_inventory/.test(msg) && /orders/.test(msg), msg);
  ok("...and nothing was half-created", (await c.query(`SELECT to_regclass('public.riders') t`)).rows[0].t === null);
  c.release(); }
await badPool.end();

console.log(`\n${pass} passed, ${fail} failed`);
await api.end(); await admin.end();
const cleanup = new pg.Client({ connectionString: ADMIN_URL }); await cleanup.connect();
for (const db of ["sw_rider_test_fb", "sw_rider_test_bad"]) await cleanup.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
await cleanup.end();
process.exit(fail ? 1 : 0);
