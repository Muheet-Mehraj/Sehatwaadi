# SehatWaadi

A hyper-local medicine-delivery platform built for Kashmir: customers order from nearby chemists, a rider is dispatched, and the chemist, rider and operator each get their own tooling. This repository is the full stack: four apps, a Node hub, and a Postgres delivery engine with its test suites.

> Demo/portfolio edition. All credentials, hostnames, payment IDs and customer data have been removed; every `.env` value is a placeholder. See [`docs/SECURITY.md`](docs/SECURITY.md).

## Architecture

```
 Customer app ──┐                                  ┌── Supabase Postgres (+PostGIS)
 (React/Capacitor)                                 │   delivery engine: riders, offers,
                ├──►  Hub (Node + Express)  ◄──────┤   ledger, payouts, KYC
 Partner app ───┤     • orders, catalog, payouts   │   security-definer RPCs + RLS
 (rider, Capacitor)    • FCM push worker           │
                │     • operator desk              └── Neon Postgres: orders, catalog,
 Companion ─────┘     • KYC document review             catalog images (bytea)
 (Electron, chemist desktop)
```

| Path | What it is |
|---|---|
| `apps/customer` | Customer app: product pages, strict substitutes, map pin, one-order-at-a-time lock |
| `apps/partner` | **SehatWaadi Partner**: rider app (React + Capacitor Android): offers, live trips, wallet, KYC profile |
| `apps/companion` | Windows desktop companion for chemists (Electron): incoming orders, catalog |
| `hub/` | Express hub: routes, push worker, payouts, operator desk, KYC review, patch scripts |
| `database/supabase` | SQL migrations, rollbacks and Postgres-backed test suites for the delivery engine |

## Engineering highlights

- **Offer-based dispatch** (`OFFER`) alongside instant auto-assign: nearby riders are offered an order with a countdown and see no customer details until they accept; first accept wins under concurrency.
- **Money handled in the database**: a ledger table with typed entries, cash vs online fee rules (riders keep the fee on cash orders and owe the order amount; online fees are credited), IST-day earnings aggregation, and chemist payout state machine with a 12-digit payment-reference constraint.
- **Rider KYC and gating**: documents stored as size-capped `bytea` with magic-byte checks, in tables no app role can read; only the Hub serves them (admin token, `no-store`, `nosniff`, sandbox CSP). Only the last 4 digits of Aadhaar are kept (Verhoeff-checked); PAN format validated. Operator approve/reject (with retake reasons)/suspend/reinstate; unverified riders cannot receive offers.
- **Push notifications** via an outbox table and a `firebase-admin` worker; payloads are tested to leak no customer data.
- **Least privilege**: security-definer functions, role-restricted RPCs, row-level security, no secrets in clients.
- **Catalog images** stored in Postgres and served with caching headers; a bulk importer for packshots.
- **Idempotent patchers** (`hub/apply-*.js`) that integrate the modules into an existing Hub `server.js` without double-applying.

## Tests

| Suite | Command | Needs |
|---|---|---|
| Partner app (unit/UI) | `cd apps/partner && npm i && npm test` | Node 20+ |
| Partner end-to-end (Hub + DB + app API layer) | `cd apps/partner && npm run test:e2e` | Postgres + PostGIS |
| Companion | `cd apps/companion && npm i && npm test` | Node |
| Hub | `cd hub && npm i && npm test` | Node (+ Postgres for the integration test) |
| Delivery database | `cd database/supabase && npm i && npm test` | Postgres + PostGIS |

Database-backed suites read `TEST_DATABASE_URL` (e.g. `postgres://postgres:postgres@localhost:5432/postgres`) and create/drop their own scratch databases. CI (`.github/workflows/ci.yml`) runs all of this on every push, plus a secret scan.

## Running it

1. Copy each `.env.example` to `.env` and fill in your own Supabase / Neon / Firebase values (see [`docs/SETUP.md`](docs/SETUP.md)).
2. Apply `database/supabase/migrations/*.sql` to a Supabase project and `hub/neon/*.sql` to a Neon database.
3. Start the hub (`DELIVERY_ADMIN_TOKEN`, `DELIVERY_DATABASE_URL`, `DATABASE_URL`, optional `FIREBASE_SERVICE_ACCOUNT_JSON`), then the apps.

## Known limits

KYC review is manual (no government API); real SMS login needs a provider you configure; push needs your own Firebase project; this edition has no real catalogue or pharmacy data.

## License

MIT, see [`LICENSE`](LICENSE).
