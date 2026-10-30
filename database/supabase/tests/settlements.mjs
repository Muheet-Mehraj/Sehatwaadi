// SQL tests for settlements (migration 20261024000000): payment-reference rule + chemist payouts. Scratch database sw_settle_test.
// (scratch server, Neon branch, local install). It builds its own scratch databases (sw_settle_test*), never touching existing data.
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

const { pool: admin, exec: runFile } = await buildDb("sw_settle_test", "01_hub_tables.sql", migrations);
const adminQ = async (sql, params) => (await admin.query(sql, params)).rows;
console.log("scratch database ready, migrations applied");

// ---- API-role helper: behaves like PostgREST (connect as authenticator, SET ROLE, claims in a GUC) ----------------------------------------
const api = new pg.Pool({ connectionString: urlFor("sw_settle_test", "authenticator"), max: 14 });
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

await setCfg("dispatch_mode", "AUTO");
const refOk = async (r) => (await adminQ(`SELECT public.valid_payment_ref($1) AS v`, [r]))[0].v;

section("S1. What counts as a valid payment reference");
const good = ["482910557301", "412345678901", "300198765432", "902837465109"];
const bad = ["", "x", "12345", "48291055730", "4829105573011", "48291055730a", "UPIREF000001", "111111111111", "000000000000", "123456789012", "012345678901", "987654321098", "890123456789",
             "121212121212", "123123123123", "123412341234", "123456123456", "4829 1055 7301"];
ok("real-looking 12-digit references pass", (await Promise.all(good.map(refOk))).every(Boolean));
const badRes = await Promise.all(bad.map(refOk));
ok("empty, short, long, letters, one digit repeated, runs and repeated blocks are all refused", badRes.every((v) => v === false), bad.filter((_, i) => badRes[i]));
ok("spaces typed by a person are ignored (4829 1055 7301 -> 482910557301)", (await adminQ(`SELECT public.valid_payment_ref(public.clean_payment_ref('4829 1055 7301')) AS v`))[0].v === true);

section("S2. A rider's cash deposit accepts only a valid reference");
await quiet();
const RD = await makeRider("Deposit Rider", { km: 1 }); await adminQ(`UPDATE riders SET cash_in_hand=1000 WHERE id=$1`, [RD.id]);
const dep = (amt, ref) => RD.me.rpc("settle_rider_cash", "$1::numeric,$2", amt, ref);
ok("letters, a made-up pattern, too short and too long are refused with invalid_reference", (await Promise.all(["UPIREF000001", "123456789012", "1111", "48291055730123"].map((r) => dep(100, r)))).every((x) => x.error === "invalid_reference"));
ok("nothing was recorded by the refused attempts", (await adminQ(`SELECT count(*)::int n FROM cash_settlements WHERE rider_id=$1`, [RD.id]))[0].n === 0);
const okDep = await dep(100, " 4829 1055 7301 ");
ok("a valid reference (spaces ignored) is accepted and stored cleaned", okDep.ok === true && (await adminQ(`SELECT upi_ref FROM cash_settlements WHERE id=$1`, [okDep.settlementId]))[0].upi_ref === "482910557301");
ok("the same reference cannot be used again", (await dep(100, "482910557301")).error === "duplicate_reference");
ok("the valid-reference helper is callable by a rider (the app can mirror it) but the payout tables are not readable", (await RD.me.rpc("settle_rider_cash", "$1::numeric,$2", 50, "482910557388")).ok === true && (await RD.me.denied(`SELECT * FROM pharmacy_settlements`)) === true);

section("S3. Chemist payout: claim -> paid -> confirmed");
const rider = await makeRider("Payout Rider", { km: 1 });
const delivered = async (pharmacy, net) => {
  const d = await dispatch({ pharmacy });
  await adminQ(`UPDATE deliveries SET status='DELIVERED', rider_id=$2, pharmacy_net_amount=$3, delivered_at=now() WHERE id=$1`, [d.id, rider.id, net]);
  return d.id;
};
await quiet();
const sum = async (ph) => (await service.rpc("payout_summary", "$1::uuid", ph));
const e1 = await sum(P1);
ok("nothing to claim yet", e1.ok && Number(e1.unsettled.amount) === 0 && e1.unsettled.orders === 0 && e1.open === null);
ok("claiming with nothing finished is refused", (await service.rpc("payout_request", "$1::uuid", P1)).error === "nothing_to_settle");
const a1 = await delivered(P1, 684), a2 = await delivered(P1, 300), a3 = await delivered(P1, 100.5), b1 = await delivered(P2, 50);
const s1 = await sum(P1);
ok("the unsettled balance is the sum of what SehatWaadi owes THIS pharmacy only (net of commission)", Number(s1.unsettled.amount) === 1084.5 && s1.unsettled.orders === 3 && Number((await sum(P2)).unsettled.amount) === 50, s1);
const rq = await service.rpc("payout_request", "$1::uuid", P1);
ok("claim: amount frozen at 1084.50 for 3 orders, status REQUESTED", rq.ok && Number(rq.amount) === 1084.5 && rq.orders === 3 && (await adminQ(`SELECT status FROM pharmacy_settlements WHERE id=$1`, [rq.settlementId]))[0].status === "REQUESTED");
ok("a second claim while one is open is refused", (await service.rpc("payout_request", "$1::uuid", P1)).error === "settlement_already_open");
const a4 = await delivered(P1, 40);
const s2 = await sum(P1);
ok("balance now shows only the NEW order; the open claim keeps its frozen amount", Number(s2.unsettled.amount) === 40 && s2.open.status === "REQUESTED" && Number(s2.open.amount) === 1084.5);
ok("the chemist cannot confirm before it is paid", (await service.rpc("payout_confirm", "$1::uuid,$2::uuid", P1, rq.settlementId)).error === "invalid_state");
const lst = await service.rpc("admin_payout_list", "$1", null);
ok("the operator sees it, with the pharmacy name", lst.settlements.length === 1 && lst.settlements[0].pharmacyName === "Nowshera Pharmacy" && lst.settlements[0].status === "REQUESTED");
ok("paying with an invalid reference is refused", (await service.rpc("admin_payout_pay", "$1::uuid,$2,$3,$4", rq.settlementId, "123456789012", "admin", null)).error === "invalid_reference" && (await service.rpc("admin_payout_pay", "$1::uuid,$2,$3,$4", rq.settlementId, "UTR-1", "admin", null)).error === "invalid_reference");
const paid = await service.rpc("admin_payout_pay", "$1::uuid,$2,$3,$4", rq.settlementId, "507291847362", "admin", "Paid by UPI");
ok("paying with a valid reference moves it to PAID and records who/when/ref", paid.ok && (await sum(P1)).open.status === "PAID" && (await sum(P1)).open.paidRef === "507291847362");
ok("the balance is NOT zero yet: it is only settled once the chemist confirms", (await sum(P1)).open !== null && (await service.rpc("payout_request", "$1::uuid", P1)).error === "settlement_already_open");
ok("another pharmacy cannot confirm or dispute it", (await service.rpc("payout_confirm", "$1::uuid,$2::uuid", P2, rq.settlementId)).error === "not_found" && (await service.rpc("payout_dispute", "$1::uuid,$2::uuid,$3", P2, rq.settlementId, "not mine")).error === "invalid_state");
ok("a payment reference can settle only one payout", await (async () => { await delivered(P2, 75); const r2 = await service.rpc("payout_request", "$1::uuid", P2); return (await service.rpc("admin_payout_pay", "$1::uuid,$2,$3,$4", r2.settlementId, "507291847362", "admin", null)).error === "duplicate_reference"; })());
const cfm = await service.rpc("payout_confirm", "$1::uuid,$2::uuid", P1, rq.settlementId);
const s3 = await sum(P1);
ok("chemist confirms: settled. Open claim gone, history shows it, the old orders no longer count", cfm.ok && s3.open === null && s3.history.length === 1 && s3.history[0].status === "CONFIRMED" && Number(s3.unsettled.amount) === 40 && s3.unsettled.orders === 1, s3);
ok("confirming twice is harmless", (await service.rpc("payout_confirm", "$1::uuid,$2::uuid", P1, rq.settlementId)).already === true);
const rq2 = await service.rpc("payout_request", "$1::uuid", P1);
const paid2 = await service.rpc("admin_payout_pay", "$1::uuid,$2,$3,$4", rq2.settlementId, "611827364950", "admin", null); await service.rpc("payout_confirm", "$1::uuid,$2::uuid", P1, rq2.settlementId);
ok("after the next claim is paid and confirmed the balance is exactly zero", paid2.ok && Number((await sum(P1)).unsettled.amount) === 0 && (await sum(P1)).unsettled.orders === 0);
ok("every order was claimed exactly once (4 orders in 2 settlements, none twice)", (await adminQ(`SELECT count(*)::int n, count(distinct delivery_id)::int d FROM pharmacy_settlement_items i JOIN deliveries x ON x.id=i.delivery_id WHERE x.pharmacy_id=$1`, [P1]))[0].n === 4);

section("S4. 'I did not receive it' and the other ways out");
await delivered(P1, 200); await delivered(P1, 20);
const rq3 = await service.rpc("payout_request", "$1::uuid", P1);
ok("a dispute needs a reason", (await service.rpc("payout_dispute", "$1::uuid,$2::uuid,$3", P1, rq3.settlementId, " ")).error === "note_required" && (await service.rpc("payout_dispute", "$1::uuid,$2::uuid,$3", P1, rq3.settlementId, "money not in my account")).error === "invalid_state");
await service.rpc("admin_payout_pay", "$1::uuid,$2,$3,$4", rq3.settlementId, "722918374651", "admin", null);
const dsp = await service.rpc("payout_dispute", "$1::uuid,$2::uuid,$3", P1, rq3.settlementId, "money not in my account");
ok("the chemist disputes a PAID claim: it goes to DISPUTED, stays open (no new claim), operator sees the reason", dsp.ok && (await sum(P1)).open.status === "DISPUTED" && (await service.rpc("payout_request", "$1::uuid", P1)).error === "settlement_already_open" && (await service.rpc("admin_payout_list", "$1", null)).settlements.find((x) => x.id === rq3.settlementId).disputeNote === "money not in my account");
ok("a DISPUTED claim cannot be confirmed", (await service.rpc("payout_confirm", "$1::uuid,$2::uuid", P1, rq3.settlementId)).error === "invalid_state");
ok("the operator pays again with the correct reference and the chemist confirms", (await service.rpc("admin_payout_pay", "$1::uuid,$2,$3,$4", rq3.settlementId, "833029485762", "admin", null)).ok && (await service.rpc("payout_confirm", "$1::uuid,$2::uuid", P1, rq3.settlementId)).ok && Number((await sum(P1)).unsettled.amount) === 0);

await delivered(P1, 90);
const rq4 = await service.rpc("payout_request", "$1::uuid", P1);
const wd = await service.rpc("payout_withdraw", "$1::uuid,$2::uuid", P1, rq4.settlementId);
ok("the chemist can withdraw a claim before it is paid: its orders are claimable again", wd.ok && Number((await sum(P1)).unsettled.amount) === 90 && (await sum(P1)).open === null);
const rq5 = await service.rpc("payout_request", "$1::uuid", P1);
const cx = await service.rpc("admin_payout_cancel", "$1::uuid,$2,$3", rq5.settlementId, "wrong amount", "admin");
ok("the operator can cancel an unpaid claim: orders are freed; a paid-and-confirmed one cannot be cancelled", cx.ok && Number((await sum(P1)).unsettled.amount) === 90 && (await service.rpc("admin_payout_cancel", "$1::uuid,$2,$3", rq3.settlementId, "x", "admin")).error === "invalid_state");
ok("a chemist cannot withdraw a claim that is already PAID", await (async () => { const r = await service.rpc("payout_request", "$1::uuid", P1); await service.rpc("admin_payout_pay", "$1::uuid,$2,$3,$4", r.settlementId, "944130596873", "admin", null); return (await service.rpc("payout_withdraw", "$1::uuid,$2::uuid", P1, r.settlementId)).error === "invalid_state"; })());

section("S5. Nobody but the Hub can touch payouts");
const fns = ["payout_summary('" + P1 + "')", "payout_request('" + P1 + "')", "admin_payout_list(null)", "admin_payout_pay(gen_random_uuid(),'507291847362')", "admin_payout_cancel(gen_random_uuid())"];
const denies = [];
for (const f of fns) { denies.push(await rider.me.denied(`SELECT public.${f}`), await pharm1.denied(`SELECT public.${f}`), await anon.denied(`SELECT public.${f}`)); }
ok("riders, chemists' own logins and anonymous callers cannot call any payout function", denies.every((d) => d === true), denies);
ok("and cannot read or write the payout tables", (await pharm1.denied(`SELECT * FROM pharmacy_settlements`)) === true && (await pharm1.denied(`UPDATE pharmacy_settlements SET status='CONFIRMED'`)) === true && (await rider.me.denied(`SELECT * FROM pharmacy_settlement_items`)) === true);

console.log(`\n${pass} passed, ${fail} failed`);
await api.end(); await admin.end();
process.exit(fail ? 1 : 0);
