<h1 align="center">SehatWaadi</h1>
<p align="center"><b>Hyper-local medicine delivery for Kashmir</b><br/>
Customer app · Rider app · Chemist desktop app · Node hub · Postgres delivery engine</p>

<p align="center">
  <a href="https://github.com/Muheet-Mehraj/Sehatwaadi/actions"><img alt="CI" src="https://github.com/Muheet-Mehraj/Sehatwaadi/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="Tests" src="https://img.shields.io/badge/tests-425%20automated-brightgreen">
  <img alt="Stack" src="https://img.shields.io/badge/stack-React%20%C2%B7%20Capacitor%20%C2%B7%20Electron%20%C2%B7%20Node%20%C2%B7%20Postgres-blue">
</p>

> **Portfolio edition.** This is the full working codebase with all credentials, hostnames, payment IDs and customer data removed. Every `.env` value is a placeholder. See [`docs/SECURITY.md`](docs/SECURITY.md).

---

## Contents
1. [The problem](#the-problem)
2. [What is in the box](#what-is-in-the-box)
3. [Architecture](#architecture)
4. [How an order flows](#how-an-order-flows)
5. [Engineering deep-dives](#engineering-deep-dives)
6. [Data model and database API](#data-model-and-database-api)
7. [Hub API](#hub-api)
8. [Testing](#testing)
9. [Getting started](#getting-started)
10. [Configuration reference](#configuration-reference)
11. [Repository layout](#repository-layout)
12. [Security](#security)
13. [Known limits and roadmap](#known-limits-and-roadmap)
14. [License](#license)

---

## The problem

In Kashmir, medicines are bought from small local chemists, often by phone, and delivery is informal. Winter closures, patchy mobile data and a cash-heavy economy make a conventional delivery stack a poor fit. SehatWaadi connects the three parties of an order and handles the hard parts end to end:

- **Customers** find a medicine, pick a nearby chemist, and track one order at a time.
- **Chemists** get a desktop app that rings on a new order, guides picking and hands the parcel to a rider with a QR code.
- **Riders** receive time-limited offers, deliver with proof, and see exactly what they earned and what they owe.
- **Operators** get a desk to review rider KYC documents, resolve stuck dispatches and pay chemists.

## What is in the box

| Component | Path | Tech | Purpose |
|---|---|---|---|
| Customer app | [`apps/customer`](apps/customer) | React, Leaflet | Catalogue, product page, strict substitutes, map pin, order lock, tracking |
| **SehatWaadi Partner** (rider app) | [`apps/partner`](apps/partner) | React, Vite, Capacitor (Android), Supabase JS | Offers, live trip flow, wallet, KYC profile, push |
| Chemist companion | [`apps/companion`](apps/companion) | React, Vite, Electron (Windows) | Incoming orders with ringer, pick workspace, handover QR, payouts, settlements, photo manager |
| Hub | [`hub/`](hub) | Node, Express 5, `pg`, `firebase-admin` | Orders, catalogue and images, delivery bridge, push worker, payouts, operator desk, KYC review |
| Delivery engine | [`database/supabase`](database/supabase) | PostgreSQL, PostGIS, PL/pgSQL | Dispatch, offers, ledger, settlements, KYC, push outbox |

## Architecture

```mermaid
flowchart LR
  C[Customer app<br/>React + Capacitor] -->|orders, catalogue| H
  K[Chemist companion<br/>Electron] -->|accept, pick, payouts| H
  P[Partner app<br/>rider, Capacitor Android] -->|RPC + realtime| S
  O[Operator desk<br/>browser] -->|admin token| H

  H[Hub<br/>Node + Express]
  H -->|orders, catalogue,<br/>catalogue images bytea| N[(Neon Postgres)]
  H -->|bridge: dispatch, payouts,<br/>KYC review| S[(Supabase Postgres<br/>+ PostGIS)]
  S -->|push outbox| H
  H -->|FCM| P
```

Two databases on purpose:

- **Neon (Hub side)** holds the commerce data: customers, pharmacies, orders, catalogue and catalogue images.
- **Supabase (delivery side)** holds the logistics and money: riders, locations, offers, deliveries, the ledger, settlements, payouts and KYC. Riders talk to it directly through narrowly scoped, role-restricted RPCs; row-level security blocks everything else.

The Hub is the only component that holds both connections and the only one that can read KYC documents.

## How an order flows

```mermaid
sequenceDiagram
  participant Cu as Customer
  participant Hu as Hub
  participant Ch as Chemist (Companion)
  participant Db as Delivery DB
  participant Ri as Rider (Partner)

  Cu->>Hu: place order
  Hu->>Ch: new order (ringer)
  Ch->>Hu: accept, pick, mark ready
  Hu->>Db: dispatch_order()
  Db-->>Ri: offer to nearby verified riders (push + realtime)
  Ri->>Db: accept_offer() (first accept wins)
  Ch->>Ri: handover (pickup QR)
  Ri->>Db: confirm_pickup(), live location
  Ri->>Cu: arrive, customer gives OTP
  Ri->>Db: complete_delivery(), payment confirmed
  Db-->>Ri: ledger entry (fee credited or kept)
```

Delivery states: `PENDING → ACCEPTED → ARRIVED_AT_PHARMACY → PICKED_UP → DELIVERED`, with the return path `RETURNING_TO_PHARMACY → RETURNED` and `CANCELLED` / issue reporting (`CUSTOMER_UNREACHABLE`, `VEHICLE_BREAKDOWN`, `ACCIDENT`, ...).

## Engineering deep-dives

### 1. Offer-based dispatch with concurrency safety
`dispatch_mode` is configurable: **`AUTO`** assigns the nearest eligible rider instantly, **`OFFER`** broadcasts the order to nearby riders in rounds.

- Offers carry a **countdown** and reveal **no customer name, phone, address, medicines or exact coordinates**, only a drop-off landmark and the fee. Details unlock after accept.
- `accept_offer()` is atomic, so when two riders tap at the same moment exactly one wins and the other's offer is withdrawn (`_deliveries_withdraw_offers`).
- `dispatch_tick()` expires stale offers (`_offer_expire_due`) and starts the next round; `admin_dispatch_stuck()` lets an operator force a stuck order through.
- Only riders with `verification_status = 'VERIFIED'` (when `kyc_required` is on), who are online and nearby, are eligible.

### 2. Money lives in the database, not the client
Every rupee is a typed row in `rider_ledger`:

| Order type | Fee | Order amount | Ledger entry |
|---|---|---|---|
| **Cash on delivery** | Rider keeps it | Rider collects, owes SehatWaadi | `COD_COLLECTED`, `COD_FEE_KEPT` (no balance change) |
| **Online / prepaid** | Credited to rider | Already paid | `DELIVERY_EARNING` to `earnings_balance` |
| **Return trip** | Credited | n/a | `RETURN_EARNING` |

- `get_my_earnings()` aggregates by **IST day** (today / last 7 days / all time) so the wallet screen never disagrees with the ledger.
- Cash is handed over through a **settlement**: `settle_rider_cash()` → operator `confirm_cash_settlement()` / `reject_cash_settlement()`, with `_apply_settlement` posting the entries.
- **Chemist payouts** are a state machine (`payout_request → payout_confirm / payout_dispute / payout_withdraw`, operator `admin_payout_pay` / `admin_payout_cancel`). Payment references must pass `valid_payment_ref` (exactly 12 digits, normalised by `clean_payment_ref`), enforced by a database constraint so no client can bypass it.

### 3. Rider KYC with gating
- Documents: selfie, Aadhaar (front/back), PAN, driving licence (not required for bicycles).
- **Aadhaar is never stored**, only the last 4 digits, after a **Verhoeff checksum** check on the device. PAN is validated against the `AAAPA9999A` pattern (4th letter `P`).
- Images are **≤ 200 KB `bytea`** with **magic-byte checks** (JPEG/PNG/WebP, not trusting the extension), stored in tables **no application role can read**.
- The Hub streams them to the operator desk with the admin token and the headers `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`.
- `admin_kyc_decide`: **APPROVE** sets `VERIFIED`; **REJECT** requires a reason and the specific documents to retake (the rider sees exactly what to fix); plus `admin_kyc_suspend` / `admin_kyc_reinstate`.
- A single config switch, `kyc_required`, turns the gate on or off per environment.

### 4. Push notifications through an outbox
Triggers (`_push_on_offer`, `_push_on_assign`) write to a push outbox inside the same transaction as the business event. The Hub's **push worker** (`firebase-admin` v14, modular API) claims rows with `push_claim`, sends FCM and reports back with `push_report`, so a crash never loses or double-sends a notification. Payloads are tested to contain **no customer data**. Devices register through `register_push_device`.

### 5. Catalogue images in Postgres
Product photos are stored as `bytea` in Neon and served at `/api/catalog/image/:id` with caching headers, `nosniff` and size/type validation. A bulk importer maps packshot files to catalogue items. This removes an object-storage dependency for a small deployment.

### 6. Offline-tolerant rider app
- A **location queue and flusher** batches GPS points and retries after connectivity returns (`push_locations` RPC), so patchy data does not drop the trip trail.
- Native plugins for background geolocation, keep-awake and push; a web fallback keeps the app testable in a browser.
- The Android hardware **back stack** is modelled explicitly (`backStack.js`) so back never exits mid-delivery.

### 7. Idempotent integration patchers
`hub/apply-delivery-patch.js` and `hub/apply-hub-additions.js` insert the new modules into an existing Express `server.js`. Running them twice changes nothing, which made incremental upgrades of a live Hub safe.

## Data model and database API

Main tables (delivery database): `riders`, `rider_locations`, `deliveries`, `delivery_events`, `delivery_offers`, `rider_ledger`, `cash_settlements`, `pharmacy_ledger`, `pharmacy_settlements` (+ `pharmacy_settlement_items`), `pharmacy_members`, `rider_kyc` and a restricted `rider_kyc_docs`, `push_devices`, `push_outbox`, `delivery_config`, `delivery_secrets`.

Migrations are ordered and each later feature ships a **rollback** in [`database/supabase/rollback`](database/supabase/rollback):

| Migration | Adds |
|---|---|
| `20261011000000_rider_delivery_schema` | Core schema, enums, PostGIS |
| `20261011000100_rider_delivery_functions` | Rider and delivery RPCs |
| `20261011000200_storage_delivery_proofs` | Proof-of-delivery storage policies |
| `20261011000300_secret_exposure_audit` | `secret_exposure_report()` self-audit |
| `20261022000000_offer_dispatch` | OFFER mode, rounds, expiry |
| `20261022000100_push_notifications` | Outbox, devices, triggers |
| `20261024000000_settlements` | Cash settlements, chemist payouts, payment-ref rule |
| `20261025000000_rider_kyc` | KYC tables, review and gating |
| `20261027000000_rider_earnings` | Earnings aggregation, fee rules |

All functions are `SECURITY DEFINER` with an explicit `search_path`, re-check the caller's role inside the function, and are granted only to the roles that need them.

## Hub API

Representative routes (all admin and Companion routes require authentication):

| Area | Routes |
|---|---|
| Delivery bridge | `POST /dispatch`, `POST /orders/:id/dispatch`, `/release`, `/extend`, `/start-picking`, `GET /by-order/:orderId`, `/by-order/:orderId/otp`, `/:deliveryId/pickup-qr`, `/return-qr`, `/reassign`, `/return`, `/cancel` |
| Payouts | `POST /request`, `/:id/confirm`, `/:id/dispute`, `/:id/withdraw`, `/:id/pay`, `GET /` |
| KYC review | `GET /` (queue), `GET /:id/doc/:kind` (streamed document), `POST /:id/decide`, `/:id/suspend`, `/:id/reinstate` |
| Catalogue images | `GET /api/catalog/image/:id`, authenticated upload |
| Operator desk | Served at `/admin/desk` (token-gated single page) |

See [`hub/INTEGRATION.md`](hub/INTEGRATION.md) for the full table and mounting order.

## Testing

**425 automated checks** across the stack, all run in CI.

| Suite | Count | Runs against |
|---|---|---|
| Delivery database (`database/supabase/tests`) | 118 | Real Postgres + PostGIS: dispatch, offers, ledger, settlements, KYC, push |
| Partner app unit and UI (`apps/partner`) | 115 | Vitest + Testing Library |
| **Partner end-to-end** (`apps/partner/test/e2e.mjs`) | 101 | Real Hub routes + real database + the app's real API layer and location queue |
| Hub (`hub/test`) | 59 | Route modules, push worker, and a merged-Hub integration test on Postgres |
| Companion (`apps/companion/test`) | 32 | Dispatch state, pick logic, payout and image helpers |

```bash
# needs Postgres with PostGIS for the database-backed suites
export TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres

(cd database/supabase && npm i && npm test)
(cd hub && npm i && npm test)
(cd apps/partner && npm i && npm test && npm run test:e2e)
(cd apps/companion && npm i && npm test)
```

The suites create and drop their own scratch databases. The end-to-end test walks a complete order: chemist accepts, Hub bridges to the delivery database, two nearby riders see the same offer, one accepts, trip steps, customer OTP, payment, wallet and settlement. The `apps/customer` folder ships source and reference tests but no build configuration.

## Getting started

**Prerequisites:** Node 20+, a Supabase project, a Neon database, (optional) a Firebase project for push, Android Studio for the rider app.

```bash
git clone https://github.com/Muheet-Mehraj/Sehatwaadi.git && cd Sehatwaadi
```

1. **Delivery database.** Run `database/supabase/migrations/*.sql` in order in the Supabase SQL editor. For local login testing, add Supabase *test phone numbers* so no SMS provider is needed.
2. **Hub database.** Run `hub/neon/04_companion.sql` and `hub/neon/05_catalog_images.sql` on Neon.
3. **Hub.**
   ```bash
   cd hub && npm i
   node apply-delivery-patch.js hub/server.js
   node apply-hub-additions.js hub/server.js
   # set the environment variables below, then
   node hub/server.js
   ```
4. **Partner app.**
   ```bash
   cd apps/partner && cp .env.example .env   # fill in your own values
   npm i && npm run dev                       # browser, http://localhost:5174
   npm run android:sync && npm run android:run
   ```
   Push needs your own `google-services.json` ([`apps/partner/FCM_SETUP.md`](apps/partner/FCM_SETUP.md)).
5. **Companion.** `cd apps/companion && cp .env.example .env && npm i && npm run dev`.

## Configuration reference

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | Hub | Neon (commerce) connection |
| `DELIVERY_DATABASE_URL` | Hub | Supabase (delivery) connection |
| `DELIVERY_ADMIN_TOKEN` | Hub | Protects operator desk, KYC and payout admin routes. Use 24+ random characters |
| `JWT_SECRET` | Hub | Signs customer and chemist sessions |
| `PUBLIC_HUB_URL` | Hub | Public https address used in stored photo links |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Hub | Enables the FCM push worker |
| `ALLOWED_ORIGINS` | Hub | CORS allow-list |
| `OTP_MODE` | Hub | Development only. **Never deploy a mock OTP** |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Partner | Public project URL and anon key (RLS protects the data) |
| `VITE_SETTLEMENT_UPI_ID` | Partner | UPI ID shown on the cash settlement sheet |
| `VITE_HUB_URL` | Companion, Customer | Hub address |

## Repository layout

```
.
├── apps/
│   ├── customer/     customer app (source + tests)
│   ├── partner/      SehatWaadi Partner: rider app, Capacitor Android project
│   └── companion/    chemist desktop app (Electron)
├── hub/              Express hub, route modules, patchers, Neon SQL, tests
├── database/
│   └── supabase/     migrations, rollbacks, Postgres-backed test suites
├── docs/             SETUP.md, SECURITY.md
├── scripts/          secret-scan.mjs (run before every push)
└── .github/workflows CI: secret scan, app tests and builds, Hub + database tests
```

## Security

- Clients hold only the public anon key; every sensitive action is a role-checked `SECURITY DEFINER` function, with RLS on every table.
- KYC documents are unreadable by app roles and served only by the Hub with `no-store`, `nosniff` and a sandbox CSP. Aadhaar numbers are never stored.
- Offers and push payloads are tested to leak no customer data.
- A database self-audit (`secret_exposure_report()`) checks for exposed secret columns.
- `scripts/secret-scan.mjs` and CI block `.env`, Firebase files, keystores, keys and real hostnames from being committed.

Details and deployment advice: [`docs/SECURITY.md`](docs/SECURITY.md).

## Known limits and roadmap

- KYC review is manual; there is no government verification API integration.
- Real SMS login requires an SMS provider you configure.
- Push requires your own Firebase project.
- Rider photos live in the database (about 0.5 MB per rider); move to object storage at scale.
- Substitution suggestions are handled manually by the chemist.
- Planned: return policy rules, iOS build of the Partner app, object storage for documents, operator analytics.

## License

MIT, see [`LICENSE`](LICENSE).
