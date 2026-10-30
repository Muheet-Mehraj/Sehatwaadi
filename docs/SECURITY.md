# Security notes

## What is intentionally not in this repository
`.env` files, `google-services.json`, Firebase service-account JSON, keystores, real Supabase/Neon/Render URLs, UPI IDs, phone numbers, third-party product photos and any real customer, rider or pharmacy data. `scripts/secret-scan.mjs` and the CI job enforce this.

## Design choices worth reading
- Clients hold only a public (anon/publishable) Supabase key; all sensitive operations are security-definer RPCs checked against the caller's role.
- KYC documents live in tables with no grants to app roles; the Hub serves them behind an admin token with `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and a sandboxing CSP.
- Aadhaar numbers are never stored, only the last four digits.
- Push payloads contain no customer name, phone, address or medicines.
- A mock OTP exists only for local tests and must never be deployed.

## Before you fork and deploy
Set your own `DELIVERY_ADMIN_TOKEN` (24+ random characters), rotate any key that has ever been pasted into a chat or committed, and enable RLS on every table you add.
