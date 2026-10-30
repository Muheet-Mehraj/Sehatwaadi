// SQL tests for OFFER dispatch (migration 20261022000000). Same harness/fixtures as run.mjs; scratch database sw_offer_test.
// (Original header follows.) SQL tests for the delivery migrations. Runs against ANY Postgres with PostGIS + pgcrypto where you can CREATE DATABASE
// (scratch server, Neon branch, local install). It builds its own scratch databases (sw_offer_test*), never touching existing data.
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

const { pool: admin, exec: runFile } = await buildDb("sw_offer_test", "01_hub_tables.sql", migrations);
const adminQ = async (sql, params) => (await admin.query(sql, params)).rows;
console.log("scratch database ready, migrations applied");

// ---- API-role helper: behaves like PostgREST (connect as authenticator, SET ROLE, claims in a GUC) ----------------------------------------
const api = new pg.Pool({ connectionString: urlFor("sw_offer_test", "authenticator"), max: 14 });
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

section("O1. One eligible rider is offered; accepting assigns; the offer shows NO customer data");
await quiet();
const A1 = await makeRider("Offer A", { km: 1 });
const d1 = await dispatch();
ok("dispatch in OFFER mode queues the order and opens round 1 (nobody is force-assigned)", d1.res.ok && d1.res.assigned === false && d1.res.queued === true && (await D(d1.id)).rider_id === null && (await D(d1.id)).dispatch_round === 1);
const off1 = await myOffer(A1);
ok("exactly one live offer, to the eligible rider, with a ~15s server-side countdown", (await offersOf(d1.id, "OFFERED")).length === 1 && off1 && off1.deliveryId === d1.id && off1.secondsLeft > 12 && off1.secondsLeft <= 15 && off1.windowSeconds === 15);
const offJson = JSON.stringify(off1);
ok("the offer reveals no customer name/phone/address, no medicines, no coordinates", !/Aaliya|9000011111|Flat 402|Augmentin|Paracetamol|lat|lng/i.test(offJson) && off1.pharmacy.name === "Nowshera Pharmacy" && off1.earnings > 0 && off1.pickupDistanceKm > 0);
const acc1 = await A1.me.rpc("accept_offer", "$1::uuid", off1.offerId);
ok("accepting assigns the rider and ONLY NOW reveals the customer's details", acc1.ok === true && acc1.delivery.order.customer.name === "Aaliya" && (await D(d1.id)).rider_id === A1.id && (await D(d1.id)).status === "ACCEPTED" && (await R(A1.id)).status === "ON_DELIVERY");
const ev1 = await events(d1.id);
ok("audit trail contains ROUND_STARTED, OFFER_ACCEPTED, RIDER_ASSIGNED", ["ROUND_STARTED", "OFFER_ACCEPTED", "RIDER_ASSIGNED"].every((e) => ev1.includes(e)), ev1);

section("O2. A repeated tap by the winner is safe");
const acc1b = await A1.me.rpc("accept_offer", "$1::uuid", off1.offerId);
ok("same rider accepting again: same answer, no second assignment", acc1b.ok === true && acc1b.already === true && (await adminQ(`SELECT count(*)::int n FROM deliveries WHERE order_id=$1`, [d1.orderId]))[0].n === 1 && (await offersOf(d1.id, "ACCEPTED")).length === 1);

section("O3. Simultaneous accepts: exactly one winner (15 independent races, 3 riders each)");
let raceOk = true, raceDetail = [];
for (let i = 0; i < 15; i++) {
  await quiet();
  const [x, y, z] = [await makeRider(`Race X${i}`, { km: 1 }), await makeRider(`Race Y${i}`, { km: 1.5 }), await makeRider(`Race Z${i}`, { km: 2 })];
  const dd = await dispatch();
  const offs = await Promise.all([x, y, z].map(myOffer));
  const results = await Promise.all([x, y, z].map((r, k) => r.me.rpc("accept_offer", "$1::uuid", offs[k].offerId)));
  const winners = results.filter((r) => r.ok), losers = results.filter((r) => !r.ok);
  const dl = await D(dd.id);
  const good = offs.every(Boolean) && winners.length === 1 && losers.length === 2 && losers.every((l) => l.error === "offer_taken")
    && dl.status === "ACCEPTED" && [x, y, z].some((r) => r.id === dl.rider_id)
    && (await offersOf(dd.id, "ACCEPTED")).length === 1 && (await offersOf(dd.id, "WITHDRAWN")).length === 2
    && (await adminQ(`SELECT count(*)::int n FROM riders WHERE id = ANY($1) AND status='ON_DELIVERY'`, [[x.id, y.id, z.id]]))[0].n === 1;
  if (!good) { raceOk = false; raceDetail.push({ i, results, dl: dl.status }); }
}
ok("15/15 races: one winner, two clean 'offer_taken' losers, one ON_DELIVERY rider, one ACCEPTED offer", raceOk, raceDetail);

section("O4. Expired offers cannot be accepted");
await quiet();
const A4 = await makeRider("Late A", { km: 1 });
const d4 = await dispatch(); const o4 = await myOffer(A4);
await expireNow(d4.id);
const late = await A4.me.rpc("accept_offer", "$1::uuid", o4.offerId);
ok("accepting after the deadline is refused; the order stays unassigned", late.error === "offer_expired" && (await D(d4.id)).rider_id === null && (await D(d4.id)).status === "DISPATCHED");
ok("an expired offer is no longer shown to the rider", (await myOffer(A4)) === null || (await myOffer(A4)).offerId !== o4.offerId);

section("O5. Declining does not assign, costs the rider nothing, and the last decline moves the order on");
await quiet();
const [A5, B5] = [await makeRider("Dec A", { km: 1 }), await makeRider("Dec B", { km: 2 })];
const d5 = await dispatch(); const [oa5, ob5] = [await myOffer(A5), await myOffer(B5)];
const dec = await A5.me.rpc("decline_offer", "$1::uuid", oa5.offerId);
ok("decline: order not assigned, B's offer still live, rider A still ONLINE (no penalty)", dec.ok && (await D(d5.id)).rider_id === null && (await offersOf(d5.id, "DECLINED")).length === 1 && (await myOffer(B5))?.offerId === ob5.offerId && (await R(A5.id)).status === "ONLINE");
ok("declining twice is harmless; a stranger cannot decline for someone else", (await A5.me.rpc("decline_offer", "$1::uuid", oa5.offerId)).already === true && (await B5.me.rpc("decline_offer", "$1::uuid", oa5.offerId)).error === "offer_not_found");
await B5.me.rpc("decline_offer", "$1::uuid", ob5.offerId);
const dd5 = await D(d5.id);
ok("everyone declined and nobody else is eligible: the order stays queued and is FLAGGED for the operator (not dropped)", dd5.status === "DISPATCHED" && dd5.rider_id === null && dd5.dispatch_exhausted_at !== null && (await events(d5.id)).includes("DISPATCH_EXHAUSTED"));
const stuck = await service.rpc("admin_dispatch_stuck", "");
ok("the operator list shows it; riders, chemists and anon cannot call it", stuck.ok && stuck.stuck.some((s) => s.deliveryId === d5.id) && (await A5.me.denied(`SELECT public.admin_dispatch_stuck()`)) === true && (await pharm1.denied(`SELECT public.admin_dispatch_stuck()`)) === true && (await anon.denied(`SELECT public.admin_dispatch_stuck()`)) === true);
ok("neither decliner is re-offered this order when a fresh cycle starts", await (async () => { await adminQ(`UPDATE deliveries SET offer_deadline = now() - interval '1 hour' WHERE id=$1`, [d5.id]); await tick(); return (await offersOf(d5.id, "OFFERED")).length === 0; })());

section("O6/O7. No response: the round expires and the NEXT round searches wider");
await quiet();
const [X, Y] = [await makeRider("Near X", { km: 2 }), await makeRider("Far Y", { km: 5 })];
const d7 = await dispatch();
let oo = await offersOf(d7.id);
ok("round 1 (radius 3 km) offers only the near rider", oo.length === 1 && oo[0].rider_id === X.id && oo[0].round_no === 1 && Number(oo[0].radius_km) === 3);
await expireNow(d7.id); await tick();
oo = await offersOf(d7.id);
ok("after the deadline X's offer is EXPIRED and round 2 (6 km) offers Y — X is not asked again", oo.find((o) => o.rider_id === X.id).status === "EXPIRED" && oo.filter((o) => o.round_no === 2).length === 1 && oo.find((o) => o.round_no === 2).rider_id === Y.id && Number(oo.find((o) => o.round_no === 2).radius_km) === 6);
ok("a timeout does not penalise X (still ONLINE) and is audited", (await R(X.id)).status === "ONLINE" && (await events(d7.id)).includes("OFFER_EXPIRED"));

section("O8. Duplicate timeout jobs cannot duplicate dispatch");
await quiet();
const [X8, Y8, Z8] = [await makeRider("Dup X", { km: 2 }), await makeRider("Dup Y", { km: 5 }), await makeRider("Dup Z", { km: 9 })];
const d8 = await dispatch(); await expireNow(d8.id);
await Promise.all([1, 2, 3, 4, 5, 6].map(() => tick()));
oo = await offersOf(d8.id);
ok("six simultaneous ticks open exactly ONE new round (Y only; Z waits for round 3)", oo.filter((o) => o.round_no === 2).length === 1 && oo.filter((o) => o.round_no === 3).length === 0 && (await events(d8.id)).filter((e) => e === "ROUND_STARTED").length === 2);
await tick(); await tick();
ok("further ticks while the round is open change nothing", (await offersOf(d8.id)).length === 2);

section("O9. Deadlines live in the database (restart-safe) and a lapsed round advances without the scheduler");
await quiet();
const [A9, B9] = [await makeRider("Rst A", { km: 1 }), await makeRider("Rst B", { km: 5 })];
const d9 = await dispatch();
const fresh = new pg.Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, "/sw_offer_test") }); await fresh.connect();   // a brand-new connection = a restarted backend
const stored = (await fresh.query(`SELECT expires_at, status FROM delivery_offers WHERE delivery_id=$1`, [d9.id])).rows[0]; await fresh.end();
ok("the deadline is a stored timestamp ~15s ahead; a new connection sees the same live offer", stored.status === "OFFERED" && stored.expires_at.getTime() - Date.now() > 10000 && stored.expires_at.getTime() - Date.now() < 16000);
await expireNow(d9.id);
const lazy = await myOffer(B9);            // NO tick: B simply polls
ok("with no scheduler running, the next rider's poll advances the lapsed round (lazy expiry)", lazy && lazy.deliveryId === d9.id && lazy.round === 2);

section("O10/O11. Cancelled orders are never dispatched; a stale job cannot reassign an assigned order");
await quiet();
const d10 = await dispatch();          // nobody online: queued + flagged
await adminQ(`UPDATE orders SET status='CANCELLED' WHERE id=$1`, [d10.orderId]);
const R10 = await makeRider("Cxl R", { km: 1 }); await tick();
ok("customer cancelled while queued: the delivery is cancelled and never offered", (await D(d10.id)).status === "CANCELLED" && (await D(d10.id)).cancel_reason === "ORDER_CANCELLED" && (await offersOf(d10.id)).length === 0 && (await myOffer(R10)) === null);
await quiet();
const A11 = await makeRider("Stale A", { km: 1 }); const d11 = await dispatch(); await A11.me.rpc("accept_offer", "$1::uuid", (await myOffer(A11)).offerId);
const stale = (await adminQ(`SELECT public._offer_round($1) r`, [d11.id]))[0].r; await tick();
ok("a stale/duplicate round job on an assigned order does nothing", stale.skipped === "not_dispatchable" && (await D(d11.id)).rider_id === A11.id && (await offersOf(d11.id)).length === 1);

section("O12. Ineligible riders cannot get or accept offers");
await quiet();
const [E1, E2, E3, E4] = [await makeRider("Elig ok", { km: 1 }), await makeRider("Unverified", { km: 1, verified: false }), await makeRider("Cash heavy", { km: 1, cash: 2500 }), await makeRider("Stranger", { km: 1.2 })];
await adminQ(`UPDATE riders SET status='OFFLINE' WHERE id=$1`, [E4.id]);
const d12 = await dispatch(); const oe = await myOffer(E1);
ok("only the verified, ONLINE, under-cash-limit rider is offered a COD order", (await offersOf(d12.id)).length === 1 && (await offersOf(d12.id))[0].rider_id === E1.id);
ok("another rider cannot accept someone else's offer; an offline rider cannot accept at all", (await E4.me.rpc("accept_offer", "$1::uuid", oe.offerId)).error === "offer_not_found" && (await E3.me.rpc("accept_offer", "$1::uuid", oe.offerId)).error === "offer_not_found");
await adminQ(`UPDATE riders SET status='OFFLINE' WHERE id=$1`, [E1.id]);
ok("an offer-holder who went offline in the meantime is refused", (await E1.me.rpc("accept_offer", "$1::uuid", oe.offerId)).error === "rider_not_available" && (await D(d12.id)).rider_id === null);
ok("anonymous callers cannot touch the offer API", (await anon.denied(`SELECT public.accept_offer(gen_random_uuid())`)) === true && (await anon.denied(`SELECT public.get_my_offer()`)) === true);

section("O13-O15. Rider cancellation: ownership, before pickup, after pickup");
await quiet();
const [A14, B14] = [await makeRider("Cxl A", { km: 1 }), await makeRider("Cxl B", { km: 2 })];
const d14 = await dispatch(); await A14.me.rpc("accept_offer", "$1::uuid", (await myOffer(A14)).offerId);
const tok0 = (await adminQ(`SELECT pickup_token FROM delivery_secrets WHERE delivery_id=$1`, [d14.id]))[0].pickup_token;
ok("a rider cannot cancel another rider's assignment", (await B14.me.rpc("rider_cancel_delivery", "$1::uuid,$2,$3", d14.id, "OTHER", null)).error === "not_authorized" && (await D(d14.id)).rider_id === A14.id);
ok("a structured reason is required; notes are length-limited", (await A14.me.rpc("rider_cancel_delivery", "$1::uuid,$2,$3", d14.id, "BORED", null)).error === "invalid_reason" && (await A14.me.rpc("rider_cancel_delivery", "$1::uuid,$2,$3", d14.id, "OTHER", "x".repeat(301))).error === "notes_too_long");
await A14.me.rpc("mark_arrived", "$1::uuid,$2", d14.id, "pharmacy");
const cx = await A14.me.rpc("rider_cancel_delivery", "$1::uuid,$2,$3", d14.id, "VEHICLE_ISSUE", "Puncture");
const dc = await D(d14.id);
ok("cancel before pickup: back in the queue, canceller excluded and still ONLINE, pickup QR rotated, reassign counted", cx.ok && dc.status === "DISPATCHED" && dc.rider_id === null && dc.excluded_rider_ids.includes(A14.id) && dc.reassign_count === 1 && (await R(A14.id)).status === "ONLINE" && (await adminQ(`SELECT pickup_token FROM delivery_secrets WHERE delivery_id=$1`, [d14.id]))[0].pickup_token !== tok0);
const ob14 = await myOffer(B14);
ok("dispatch re-entered: the NEXT rider is offered, the canceller is not; the reason is audited", ob14 && ob14.deliveryId === d14.id && (await myOffer(A14)) === null && (await adminQ(`SELECT detail FROM delivery_events WHERE delivery_id=$1 AND event='RIDER_CANCELLED'`, [d14.id]))[0].detail.reason === "VEHICLE_ISSUE");
await B14.me.rpc("accept_offer", "$1::uuid", ob14.offerId);
ok("the replacement rider accepts: exactly one live assignment", (await D(d14.id)).rider_id === B14.id && (await adminQ(`SELECT count(*)::int n FROM deliveries WHERE order_id=$1 AND status IN ${LIVE}`, [d14.orderId]))[0].n === 1);
await toPickedUp(B14, d14.id);
const late14 = await B14.me.rpc("rider_cancel_delivery", "$1::uuid,$2,$3", d14.id, "OTHER", null);
ok("after pickup a rider cannot simply cancel: medicines are in the field", late14.error === "cancel_after_pickup" && (await D(d14.id)).status === "PICKED_UP" && (await D(d14.id)).rider_id === B14.id);
ok("the safe path still works: report the problem, the chemist reassigns (audited), the order is offered again — never silently transferred", await (async () => {
  const rep = await B14.me.rpc("report_delivery_issue", "$1::uuid,$2,$3", d14.id, "VEHICLE_BREAKDOWN", null);
  const C14 = await makeRider("Cxl C", { km: 1.5 });
  const re = await pharm1.rpc("reassign_delivery", "$1::uuid,$2", d14.id, "BREAKDOWN");
  const dr = await D(d14.id);
  return rep.ok && re.ok && dr.status === "DISPATCHED" && dr.reassign_count === 2 && dr.excluded_rider_ids.includes(B14.id) && (await myOffer(C14))?.deliveryId === d14.id;
})());

section("O16. A rider never holds two live offers; DB-enforced");
await quiet();
const S16 = await makeRider("Solo", { km: 1 });
const dA = await dispatch(), dB = await dispatch();
ok("one rider, two orders: only the first is offered (the second waits/escalates)", (await offersOf(dA.id, "OFFERED")).length === 1 && (await offersOf(dB.id)).length === 0);
ok("the database itself refuses a second live offer for the same rider", await (async () => { try { await adminQ(`INSERT INTO delivery_offers (delivery_id, rider_id, cycle_no, round_no, expires_at) VALUES ($1,$2,9,1, now()+interval '15 seconds')`, [dB.id, S16.id]); return false; } catch (e) { return /delivery_offers_one_live_per_rider/.test(e.message); } })());

section("O17. The whole trip still works end to end after an accepted offer");
await quiet();
const T = await makeRider("Trip", { km: 1 }); const dt = await dispatch({ mode: "CASH" });
await T.me.rpc("accept_offer", "$1::uuid", (await myOffer(T)).offerId);
await toPickedUp(T, dt.id);
await T.me.rpc("mark_arrived", "$1::uuid,$2", dt.id, "customer");
const fin = await T.me.rpc("complete_delivery", "$1::uuid,$2,$3,$4", dt.id, await otpOf(dt.orderId), "CASH", null);
ok("arrive → QR pickup → OTP drop-off → DELIVERED; the rider is free and ONLINE; the chemist is credited", fin.ok === true && (await D(dt.id)).status === "DELIVERED" && (await R(T.id)).status === "ONLINE" && (await adminQ(`SELECT count(*)::int n FROM pharmacy_ledger WHERE delivery_id=$1`, [dt.id]))[0].n === 1);

section("O18. Privileges");
ok("riders read only their OWN offers (RLS); they cannot write offers or read the audit trail", (await T.me.query(`SELECT count(*)::int n FROM delivery_offers WHERE rider_id <> auth.uid()`))[0].n === 0 && (await T.me.denied(`UPDATE delivery_offers SET status='ACCEPTED'`)) === true && (await T.me.denied(`SELECT * FROM delivery_events`)) === true && (await anon.denied(`SELECT * FROM delivery_offers`)) === true);
ok("the internal round engine is not callable from the API", (await T.me.denied(`SELECT public._offer_round(gen_random_uuid())`)) === true && (await pharm1.denied(`SELECT public._offer_expire_due()`)) === true);

section("O19. Switching back to AUTO restores today's behaviour instantly");
await setCfg("dispatch_mode", "AUTO"); await quiet();
const Q = await makeRider("Auto Q", { km: 1 }); const before = (await adminQ(`SELECT count(*)::int n FROM delivery_offers`))[0].n;
const dq = await dispatch();
ok("AUTO mode: instant forced assignment, no offers created", dq.res.assigned === true && (await D(dq.id)).rider_id === Q.id && (await adminQ(`SELECT count(*)::int n FROM delivery_offers`))[0].n === before);
const Q2 = await makeRider("Auto Q2", { km: 2 });
const cq = await Q.me.rpc("rider_cancel_delivery", "$1::uuid,$2,$3", dq.id, "OTHER", null);
ok("AUTO mode: a rider cancel re-assigns straight to the next rider", cq.ok && (await D(dq.id)).rider_id === Q2.id);

console.log(`\n${pass} passed, ${fail} failed`);
await api.end(); await admin.end();
process.exit(fail ? 1 : 0);
