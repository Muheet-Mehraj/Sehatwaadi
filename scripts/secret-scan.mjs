#!/usr/bin/env node
// Scans the repo for things that must never be public. Run before every push:  node scripts/secret-scan.mjs
// Exit code 1 if anything is found. Add your own personal strings (name, email, phone, UPI id, project URLs) with
//   SCAN_EXTRA="my@email.com|9876543210|myupi@bank|abcd1234.supabase.co" node scripts/secret-scan.mjs
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".gradle"]);
const BAD_FILES = [/(^|\/)\.env(\.|$)(?!example)/, /google-services\.json$/, /GoogleService-Info\.plist$/, /service-account.*\.json$/i, /\.(keystore|jks|apk|aab|pem|p12)$/i, /local\.properties$/];
const RULES = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----(?!\s*$)(?![\s\S]{0,5}(PLACEHOLDER|EXAMPLE))/],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["JWT / Supabase key", /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
  ["Supabase publishable/secret key", /sb_(publishable|secret)_[A-Za-z0-9_-]{15,}/],
  ["real Supabase project URL", /https:\/\/(?!x\.|your-|example|project)[a-z0-9]{15,25}\.supabase\.co/],
  ["Postgres URL with password", /postgres(ql)?:\/\/[^:\s/]+:(?!postgres@|pass@|password@|\$|<|\{|x@)[^@\s]{4,}@(?!localhost|127\.0\.0\.1)[^\s'"]+/],
  ["Render hostname", /[a-z0-9-]+\.onrender\.com/],
  ["Twilio SID", /\bAC[0-9a-f]{32}\b/],
  ["GitHub / Slack / AWS token", /(ghp_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/],
  ["email address", /[A-Za-z0-9._%+-]+@(?!example\.|demo-|x\.|test\.)[A-Za-z0-9-]+\.(com|in|org|net|io)\b(?!\/)/],
  ["real-looking UPI id", /\b[a-z0-9.\-_]{3,}@(okhdfcbank|okicici|oksbi|okaxis|ybl|paytm|ibl|axl|upi)\b/i],
];
if (process.env.SCAN_EXTRA) RULES.push(["your personal string", new RegExp(process.env.SCAN_EXTRA, "i")]);

let hits = 0;
const rel = (f) => path.relative(root, f).split(path.sep).join("/");
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(f); continue; }
    if (BAD_FILES.some((r) => r.test(rel(f)))) { console.log(`FILE  ${rel(f)}  (must not be committed)`); hits++; continue; }
    if (f.endsWith("secret-scan.mjs") || fs.statSync(f).size > 2_000_000) continue;
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) continue; // binary
    const txt = buf.toString("utf8");
    for (const [name, re] of RULES) { const m = re.exec(txt); if (m) { console.log(`${name.toUpperCase().padEnd(30)} ${rel(f)}: ${m[0].slice(0, 60)}`); hits++; } }
  }
})(root);
console.log(hits ? `\n${hits} problem(s). Fix before pushing.` : "secret-scan: clean");
process.exit(hits ? 1 : 0);
