// SQL tests for push notifications (migration 20261022000100). Same harness/fixtures as offers.mjs; scratch database sw_push_test.
// (scratch server, Neon branch, local install). It builds its own scratch databases (sw_push_test*), never touching existing data.
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

const { pool: admin, exec: runFile } = await buildDb("sw_push_test", "01_hub_tables.sql", migrations);
const adminQ = async (sql, params) => (await admin.query(sql, params)).rows;
console.log("scratch database ready, migrations applied");

// ---- API-role helper: behaves like PostgREST (connect as authenticator, SET ROLE, claims in a GUC) ----------------------------------------
const api = new pg.Pool({ connectionString: urlFor("sw_push_test", "authenticator"), max: 14 });
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
// OFFER DISPATCH
// =====================================================================================================================
const setCfg = (k, v) => adminQ(`UPDATE delivery_config SET value=$2 WHERE key=$1`, [k, v]);
await setCfg("dispatch_mode", "OFFER"); await setCfg("offer_group_size", "3");
const offersOf = (id, status) => adminQ(`SELECT * FROM delivery_offers WHERE delivery_id=$1 ${status ? `AND status='${status}'` : ""} ORDER BY round_no, offered_at`, [id]);
const events = async (id) => (await adminQ(`SELECT event FROM delivery_events WHERE delivery_id=$1 ORDER BY id`, [id])).map((x) => x.event);
const expireNow = (id) => adminQ(`UPDATE delivery_offers SET expires_at = now() - interval '1 second' WHERE delivery_id=$1 AND status='OFFERED'`, [id]);
const dispatch = async (o) => { const orderId = await newOrder(o); const res = await service.rpc("dispatch_order", "$1::uuid", orderId); return { orderId, res, id: res.deliveryId }; };
const myOffer = async (rider) => (await rider.me.rpc("get_my_offer", "")).offer;
const tick = () => service.rpc("dispatch_tick", "");

const claim = async () => (await adminQ(`SELECT public.push_claim(50) AS r`))[0].r;
const TOK = (s) => "fcm-token-" + s.padEnd(30, "x");

section("P1. Device registration");
await quiet();
const A = await makeRider("Push A", { km: 1 }), B = await makeRider("Push B", { km: 2 });
ok("a rider can register a token", (await A.me.rpc("register_push_device", "$1,$2,$3", TOK("a1"), "android", "0.5.0")).ok === true);
ok("registering again is idempotent (one row)", (await A.me.rpc("register_push_device", "$1,$2,$3", TOK("a1"), "android", "0.5.0")).ok && (await adminQ(`SELECT count(*)::int n FROM push_devices WHERE rider_id=$1`, [A.id]))[0].n === 1);
ok("a too-short token is refused", (await A.me.rpc("register_push_device", "$1,$2,$3", "short", "android", null)).ok === false);
ok("anon cannot register", (await anon.denied(`SELECT public.register_push_device('${TOK("zz")}')`)) === true);
ok("the same phone token moves to whoever signs in on it now", (await B.me.rpc("register_push_device", "$1,$2,$3", TOK("a1"), "android", null)).ok && (await adminQ(`SELECT rider_id FROM push_devices WHERE token=$1`, [TOK("a1")]))[0].rider_id === B.id);
await A.me.rpc("register_push_device", "$1,$2,$3", TOK("a1"), "android", null);   // back to A
for (let i = 0; i < 7; i++) await A.me.rpc("register_push_device", "$1,$2,$3", TOK("many" + i), "android", null);
ok("at most 5 phones per rider", (await adminQ(`SELECT count(*)::int n FROM push_devices WHERE rider_id=$1`, [A.id]))[0].n === 5);
ok("tables and the worker functions are not reachable from the API", (await A.me.denied(`SELECT * FROM push_devices`)) === true && (await A.me.denied(`SELECT * FROM push_outbox`)) === true && (await A.me.denied(`SELECT public.push_claim(5)`)) === true && (await A.me.denied(`SELECT public.push_report('[]')`)) === true);
await adminQ(`DELETE FROM push_devices WHERE rider_id=$1`, [A.id]); await A.me.rpc("register_push_device", "$1,$2,$3", TOK("a1"), "android", null);
await adminQ(`DELETE FROM push_devices WHERE rider_id=$1`, [B.id]);
await B.me.rpc("register_push_device", "$1,$2,$3", TOK("b1"), "android", null);

section("P2. An offer queues exactly one push, with the facts the notification needs and nothing private");
await setCfg("dispatch_mode", "OFFER"); await setCfg("offer_group_size", "3");
await adminQ(`DELETE FROM push_outbox`);
const d1 = await dispatch();
let c = await claim();
const forA = c.find((x) => x.tokens.includes(TOK("a1")));
ok("rider A (nearest) gets an OFFER push carrying the pharmacy name and earnings", forA && forA.kind === "OFFER" && forA.pharmacyName === "Nowshera Pharmacy" && forA.earnings > 0 && forA.secondsLeft > 10 && forA.secondsLeft <= 15, c);
ok("the payload leaks no customer data", !/Aaliya|9000011111|Flat 402|Augmentin/i.test(JSON.stringify(c)));
ok("claiming again straight away returns nothing (already claimed; no duplicate sends)", (await claim()).length === 0);

section("P3. Reporting results");
const ids = c.map((x) => x.id);
await adminQ(`SELECT public.push_report($1::jsonb)`, [JSON.stringify([{ id: ids[0], ok: true, okTokens: c[0].tokens }])]);
ok("a success marks it sent and stamps the device", (await adminQ(`SELECT sent_at FROM push_outbox WHERE id=$1`, [ids[0]]))[0].sent_at !== null && (await adminQ(`SELECT last_success_at FROM push_devices WHERE token=$1`, [c[0].tokens[0]]))[0].last_success_at !== null);
if (ids[1]) {
  await adminQ(`SELECT public.push_report($1::jsonb)`, [JSON.stringify([{ id: ids[1], ok: false, error: "boom", deadTokens: [c[1].tokens[0]] }])]);
  ok("a failure leaves it for retry and removes a dead token", (await adminQ(`SELECT sent_at, last_error FROM push_outbox WHERE id=$1`, [ids[1]]))[0].sent_at === null && (await adminQ(`SELECT count(*)::int n FROM push_devices WHERE token=$1`, [c[1].tokens[0]]))[0].n === 0);
}

section("P4. Stale pushes are never sent");
await quiet(); await adminQ(`DELETE FROM push_outbox`); await adminQ(`DELETE FROM delivery_offers`);
await adminQ(`INSERT INTO push_devices (token, rider_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [TOK("a1"), A.id]);
await online(A);
const d2 = await dispatch();
const live = await myOffer(A);
await A.me.rpc("accept_offer", "$1::uuid", live.offerId);
ok("an offer accepted before the worker looked is dropped, not pushed", (await claim()).filter((x) => x.kind === "OFFER" && x.offerId === live.offerId).length === 0);
await quiet(); await adminQ(`DELETE FROM push_outbox`); await adminQ(`DELETE FROM delivery_offers`); await online(A);
const d3 = await dispatch(); await expireNow(d3.id);
ok("an offer that has already expired is dropped", (await claim()).length === 0 && (await adminQ(`SELECT last_error FROM push_outbox ORDER BY id DESC LIMIT 1`))[0].last_error === "offer_no_longer_live");
await adminQ(`DELETE FROM push_outbox`);
await adminQ(`INSERT INTO push_outbox (rider_id, kind, created_at) VALUES ($1,'OFFER', now() - interval '5 minutes')`, [A.id]);
ok("anything older than 2 minutes is dropped", (await claim()).length === 0);

section("P5. A rider with no registered phone is skipped quietly");
await quiet(); await adminQ(`DELETE FROM push_outbox`); await adminQ(`DELETE FROM delivery_offers`); await adminQ(`DELETE FROM push_devices WHERE rider_id=$1`, [A.id]); await online(A);
await dispatch();
ok("no token -> nothing to send, row closed as no_device", (await claim()).length === 0 && (await adminQ(`SELECT last_error FROM push_outbox ORDER BY id DESC LIMIT 1`))[0].last_error === "no_device");

section("P6. AUTO mode: assignment pushes the rider (they pressed nothing)");
await setCfg("dispatch_mode", "AUTO"); await quiet(); await adminQ(`DELETE FROM push_outbox`);
await adminQ(`INSERT INTO push_devices (token, rider_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [TOK("a1"), A.id]); await online(A);
const d4 = await dispatch();
const ca = await claim();
ok("ASSIGNED push for the auto-assigned rider", d4.res.assigned === true && ca.length === 1 && ca[0].kind === "ASSIGNED" && ca[0].deliveryId === d4.id, ca);

section("P7. Unregister on sign-out");
await B.me.rpc("register_push_device", "$1,$2,$3", TOK("b1"), "android", null); await A.me.rpc("register_push_device", "$1,$2,$3", TOK("a1"), "android", null);
ok("unregister removes only my own token", (await A.me.rpc("unregister_push_device", "$1", TOK("a1"))).ok && (await adminQ(`SELECT count(*)::int n FROM push_devices WHERE token=$1`, [TOK("a1")]))[0].n === 0 && (await adminQ(`SELECT count(*)::int n FROM push_devices WHERE token=$1`, [TOK("b1")]))[0].n === 1 && (await A.me.rpc("unregister_push_device", "$1", TOK("b1"))).ok && (await adminQ(`SELECT count(*)::int n FROM push_devices WHERE token=$1`, [TOK("b1")]))[0].n === 1);

console.log(`\n${pass} passed, ${fail} failed`);
await api.end(); await admin.end();
process.exit(fail ? 1 : 0);
