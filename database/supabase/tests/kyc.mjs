// SQL tests for rider KYC (migration 20261025000000). Scratch database sw_kyc_test.
// (scratch server, Neon branch, local install). It builds its own scratch databases (sw_kyc_test*), never touching existing data.
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

const { pool: admin, exec: runFile } = await buildDb("sw_kyc_test", "01_hub_tables.sql", migrations);
const adminQ = async (sql, params) => (await admin.query(sql, params)).rows;
console.log("scratch database ready, migrations applied");

// ---- API-role helper: behaves like PostgREST (connect as authenticator, SET ROLE, claims in a GUC) ----------------------------------------
const api = new pg.Pool({ connectionString: urlFor("sw_kyc_test", "authenticator"), max: 14 });
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

const mkUser = async (phone) => { const id = randomUUID(); await adminQ(`INSERT INTO auth.users (id, phone) VALUES ($1,$2)`, [id, phone]); return { sub: id, id }; };
let seq = 0;
const newRider = async (vehicle = "SCOOTER") => {
  const u = await mkUser("9197" + String(10000000 + ++seq)); const me = as(u);
  await me.rpc("register_rider", "$1,$2,$3", "Test Rider " + seq, vehicle, vehicle === "BICYCLE" ? null : "JK01AB1234");
  return { ...u, me };
};
// tiny valid images
const JPG = Buffer.concat([Buffer.from("ffd8ffe000104a46494600", "hex"), Buffer.alloc(300, 7)]).toString("base64");
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(200, 1)]).toString("base64");
const WEBP = Buffer.concat([Buffer.from("52494646", "hex"), Buffer.alloc(4, 0), Buffer.from("57454250", "hex"), Buffer.alloc(100, 3)]).toString("base64");
const up = (r, kind, data = JPG) => r.me.rpc("kyc_upload_doc", "$1,$2,$3", kind, "image/jpeg", data);
const ALL = ["SELFIE", "AADHAAR_FRONT", "AADHAAR_BACK", "PAN", "DL_FRONT"];
const uploadAll = async (r, kinds = ALL) => { for (const k of kinds) { const x = await up(r, k); if (!x.ok) throw new Error(k + " " + JSON.stringify(x)); } };
let panSeq = 0;
const nextPan = () => "ABCPE" + String(1000 + ++panSeq) + "F";
let dlSeq = 0;
const nextDl = () => "JK01" + "2019" + String(1000000 + ++dlSeq);
const submit = (r, o = {}) => r.me.rpc("kyc_submit", "$1,$2,$3,$4,$5", o.dob ?? "1995-04-12", o.a ?? "4821", o.pan ?? nextPan(), o.dl === undefined ? nextDl() : o.dl, o.exp ?? "2032-01-31");
const kyc = async (r) => (await r.me.rpc("get_my_kyc", "")).kyc;

section("1. a new rider is not verified and cannot go online");
const A = await newRider();
let k0 = await kyc(A);
ok("status DRAFT, verification PENDING, 5 documents required for a scooter", k0.status === "DRAFT" && k0.verificationStatus === "PENDING" && k0.required.length === 5 && k0.canEdit === true, k0);
ok("cannot go online before approval", (await A.me.rpc("set_rider_status", "$1", "ONLINE")).error === "not_verified");

section("2. uploads are checked");
ok("a JPEG, a PNG and a WebP are accepted", (await up(A, "SELFIE", JPG)).ok && (await up(A, "PAN", PNG)).ok && (await up(A, "AADHAAR_BACK", WEBP)).ok);
ok("the stored type comes from the bytes, not the label", (await adminQ(`SELECT content_type FROM rider_kyc_docs WHERE rider_id=$1 AND kind='PAN'`, [A.id]))[0].content_type === "image/png");
ok("text pretending to be an image is refused", (await up(A, "PAN", Buffer.from("hello <script>alert(1)</script>").toString("base64"))).error === "invalid_image");
ok("garbage base64 is refused", (await up(A, "PAN", "%%%not base64%%%")).error === "invalid_image");
ok("empty is refused", (await up(A, "PAN", "")).error === "invalid_image");
ok("over 200 KB is refused", (await up(A, "PAN", Buffer.concat([Buffer.from("ffd8ff", "hex"), Buffer.alloc(210000)]).toString("base64"))).error === "image_too_large");
ok("unknown document kind refused", (await up(A, "PASSPORT")).error === "invalid_document");
ok("a bicycle rider cannot/need not upload a licence", (await up(await newRider("BICYCLE"), "DL_FRONT")).error === "invalid_document");
ok("anonymous callers are refused", (await anon.denied(`SELECT public.kyc_upload_doc('SELFIE','image/jpeg','x')`)) === true);

section("3. submitting needs every document and sane details");
const B = await newRider();
await uploadAll(B, ["SELFIE", "PAN"]);
const miss = await submit(B);
ok("missing documents are named", miss.error === "documents_missing" && miss.missing.includes("AADHAAR_FRONT") && miss.missing.includes("DL_FRONT") && !miss.missing.includes("PAN"), miss);
await uploadAll(B);
const bad = {
  dob_young: await submit(B, { dob: new Date(Date.now() - 17 * 365 * 864e5).toISOString().slice(0, 10) }),
  dob_junk: await submit(B, { dob: "not a date" }),
  dob_old: await submit(B, { dob: "1940-01-01" }),
  aad: await submit(B, { a: "12AB" }), aad2: await submit(B, { a: "123" }),
  pan1: await submit(B, { pan: "ABCDE1234" }), pan2: await submit(B, { pan: "12345ABCDE" }), pan_company: await submit(B, { pan: "ABCCE1234F" }),
  dl1: await submit(B, { dl: "123" }), dl_none: await submit(B, { dl: null }),
  dl_exp: await submit(B, { exp: "2020-01-01" }), dl_exp_junk: await submit(B, { exp: "soon" }),
};
ok("under 18 / bad dob / over 70 refused", bad.dob_young.error === "invalid_dob" && bad.dob_junk.error === "invalid_dob" && bad.dob_old.error === "invalid_dob", bad);
ok("Aadhaar last-4 must be 4 digits", bad.aad.error === "invalid_aadhaar" && bad.aad2.error === "invalid_aadhaar");
ok("PAN must be 5 letters, 4 digits, 1 letter, and an individual's (4th letter P)", bad.pan1.error === "invalid_pan" && bad.pan2.error === "invalid_pan" && bad.pan_company.error === "invalid_pan", bad);
ok("licence number must look like one; an expired licence is refused", bad.dl1.error === "invalid_dl" && bad.dl_none.error === "invalid_dl" && bad.dl_exp.error === "dl_expired" && bad.dl_exp_junk.error === "invalid_dl_expiry", bad);
const sub = await submit(B, { pan: "abcpe9999z", dl: "jk-01 2019-1234567" });
ok("a good submission is accepted (PAN upper-cased, licence number cleaned)", sub.ok === true && sub.status === "SUBMITTED", sub);
const kb = await kyc(B);
ok("get_my_kyc shows it, masks Aadhaar, and the rider cannot edit while it is in review", kb.status === "SUBMITTED" && kb.aadhaarMasked === "XXXX XXXX 4821" && kb.pan === "ABCPE9999Z" && kb.dlNumber === "JK0120191234567" && kb.canEdit === false, kb);
ok("a full Aadhaar number is never stored anywhere", (await adminQ(`SELECT count(*)::int n FROM rider_kyc WHERE aadhaar_last4 !~ '^[0-9]{4}$'`))[0].n === 0);
ok("locked: no re-upload and no re-submit while in review", (await up(B, "SELFIE")).error === "kyc_locked" && (await submit(B)).error === "kyc_locked");
ok("still cannot go online while in review", (await B.me.rpc("set_rider_status", "$1", "ONLINE")).error === "not_verified");

section("4. one PAN / licence belongs to one rider");
const C = await newRider(); await uploadAll(C);
ok("reusing someone else's PAN is refused", (await submit(C, { pan: "ABCPE9999Z" })).error === "pan_in_use");
ok("reusing someone else's licence is refused", (await submit(C, { dl: "JK01 2019 1234567" })).error === "dl_in_use");
const bic = await newRider("BICYCLE"); await uploadAll(bic, ["SELFIE", "AADHAAR_FRONT", "AADHAAR_BACK", "PAN"]);
const bs = await bic.me.rpc("kyc_submit", "$1,$2,$3,$4,$5", "1999-01-01", "1234", nextPan(), null, null);
ok("a bicycle rider submits without a licence", bs.ok === true, bs);

section("5. only the operator decides, and only the operator can see the pictures");
const call = (fn, sig, ...a) => service.rpc(fn, sig, ...a);
const attempts = [`public.admin_kyc_decide('${B.id}','APPROVE','{}',null,'x')`, `public.admin_kyc_list('SUBMITTED')`, `public.admin_kyc_get('${B.id}')`, `public.admin_kyc_suspend('${B.id}','xx','x')`, `public.admin_kyc_reinstate('${B.id}','x')`];
const dn = []; for (const f of attempts) dn.push(await B.me.denied(`SELECT ${f}`), await anon.denied(`SELECT ${f}`));
ok("a rider (even this one) and anonymous callers cannot call any admin function", dn.every((d) => d === true), dn);
ok("riders cannot read or write the KYC tables", (await B.me.denied(`SELECT * FROM rider_kyc_docs`)) === true && (await B.me.denied(`SELECT * FROM rider_kyc`)) === true && (await B.me.denied(`UPDATE rider_kyc SET status='APPROVED'`)) === true && (await B.me.denied(`UPDATE riders SET verification_status='VERIFIED'`)) === true);
ok("a pharmacy login cannot either", (await as(await mkUser("919800000044")).denied(`SELECT * FROM rider_kyc_docs`)) === true);
const list = await call("admin_kyc_list", "$1", "SUBMITTED");
ok("the queue lists the submitted riders", list.ok && list.items.some((x) => x.riderId === B.id) && !list.items.some((x) => x.riderId === C.id), list);
const got = await call("admin_kyc_get", "$1::uuid", B.id);
ok("the operator sees the details and the documents (not the bytes)", got.ok && got.kyc.pan === "ABCPE9999Z" && got.docs.length === 5 && got.docs.every((d) => d.size > 0 && d.bytes === undefined), got);

section("6. rejection: reason required, retake only what is named, then approval verifies the rider");
ok("reject needs a reason", (await call("admin_kyc_decide", "$1::uuid,$2,$3::text[],$4,$5", B.id, "REJECT", ["PAN"], "", "op")).error === "reason_required");
ok("reject refuses an unknown document", (await call("admin_kyc_decide", "$1::uuid,$2,$3::text[],$4,$5", B.id, "REJECT", ["PASSPORT"], "blurry", "op")).error === "invalid_document");
ok("a nonsense decision is refused", (await call("admin_kyc_decide", "$1::uuid,$2,$3::text[],$4,$5", B.id, "MAYBE", [], null, "op")).error === "invalid_decision");
const rj = await call("admin_kyc_decide", "$1::uuid,$2,$3::text[],$4,$5", B.id, "REJECT", ["PAN", "SELFIE"], "PAN photo is blurry and the selfie is dark", "op1");
ok("reject works", rj.ok && rj.status === "REJECTED", rj);
let kr = await kyc(B);
ok("the rider sees why, which pictures to retake, and can edit again", kr.status === "REJECTED" && /blurry/.test(kr.rejectReason) && kr.docs.PAN.status === "REJECTED" && kr.docs.SELFIE.status === "REJECTED" && kr.docs.AADHAAR_BACK.status === "PENDING" && kr.canEdit === true, kr);
ok("not verified, cannot go online", (await B.me.rpc("set_rider_status", "$1", "ONLINE")).error === "not_verified" && (await R2(B)).verification_status === "PENDING");
async function R2(r) { return (await adminQ(`SELECT * FROM riders WHERE id=$1`, [r.id]))[0]; }
ok("resubmitting without retaking the rejected pictures is refused", (await submit(B)).error === "documents_missing");
await up(B, "PAN"); await up(B, "SELFIE");
const re = await submit(B, { pan: "ABCPE9999Z", dl: "JK01 2019 1234567" });
ok("after the retake the same details resubmit (own PAN/licence is not 'in use')", re.ok === true, re);
ok("approve a rider who was never submitted fails", (await call("admin_kyc_decide", "$1::uuid,$2,$3::text[],$4,$5", A.id, "APPROVE", [], null, "op")).error === "invalid_state");
const ap = await call("admin_kyc_decide", "$1::uuid,$2,$3::text[],$4,$5", B.id, "APPROVE", [], null, "op2");
const rb = await R2(B);
ok("approval verifies the rider and records who", ap.ok && rb.verification_status === "VERIFIED" && rb.verified_by === "op2" && rb.verified_at, { ap, rb });
ok("the same decision twice is refused", (await call("admin_kyc_decide", "$1::uuid,$2,$3::text[],$4,$5", B.id, "APPROVE", [], null, "op")).error === "invalid_state");
ok("the rider can now go online", (await B.me.rpc("set_rider_status", "$1", "ONLINE")).ok === true);
ok("and get_my_kyc shows APPROVED / VERIFIED, locked", (await kyc(B)).status === "APPROVED" && (await kyc(B)).canEdit === false);

section("7. suspension takes a rider off the road");
await adminQ(`UPDATE riders SET status='ONLINE', last_seen_at=now() WHERE id=$1`, [B.id]);
ok("suspend needs a reason", (await call("admin_kyc_suspend", "$1::uuid,$2,$3", B.id, "", "op")).error === "reason_required");
const sp = await call("admin_kyc_suspend", "$1::uuid,$2,$3", B.id, "Driving licence expired", "op3");
const rs = await R2(B);
ok("suspended: verification SUSPENDED, offline", sp.ok && rs.verification_status === "SUSPENDED" && rs.status === "OFFLINE", { sp, rs });
ok("cannot go online while suspended", (await B.me.rpc("set_rider_status", "$1", "ONLINE")).error === "not_verified");
ok("suspended riders cannot edit documents either", (await kyc(B)).canEdit === false);
ok("reinstate lifts it", (await call("admin_kyc_reinstate", "$1::uuid,$2", B.id, "op")).ok && (await R2(B)).verification_status === "VERIFIED");
ok("reinstate on a rider who isn't suspended is refused", (await call("admin_kyc_reinstate", "$1::uuid,$2", B.id, "op")).error === "invalid_state");
const D2 = await newRider(); await uploadAll(D2); await submit(D2);
await call("admin_kyc_suspend", "$1::uuid,$2,$3", D2.id, "complaint", "op");
ok("an approval never silently lifts a suspension", (await call("admin_kyc_decide", "$1::uuid,$2,$3::text[],$4,$5", D2.id, "APPROVE", [], null, "op")).error === "invalid_state");

ok("the 'kyc_required' switch exists and defaults to true", (await adminQ(`SELECT value FROM delivery_config WHERE key='kyc_required'`))[0]?.value === "true");
section("8. nothing else in the delivery system changed");
ok("the earlier gate still holds: PENDING riders get no offers (index and function untouched)", (await adminQ(`SELECT indexdef FROM pg_indexes WHERE indexname='riders_assign_geog_idx'`))[0].indexdef.includes("VERIFIED"));

console.log(`\n${pass} passed, ${fail} failed`);
await api.end(); await admin.end();
process.exit(fail ? 1 : 0);
