# LYMX Backend

Supabase-based backend for the LYMX loyalty rewards network. Postgres schema + RLS + Edge Functions.

**Project ID:** `apffootxzfwmtyjlnteo` · **Region:** us-west-1 · **Tier:** Pro · **Frontend:** [lymx.netlify.app](https://lymx.netlify.app) (custom `getlymx.com` in progress)

## Architecture in one paragraph

A solo founder + AI-pair stack: minimal code surface, maximal Postgres. Customers, partners, businesses each have a row in `auth.users` plus an extension table (`customers`, `partners`, `businesses`). Per-business loyalty rewards live in `wallets` (one row per customer-per-business — LYMX is non-transferable across merchants). Money flows tracked in `transactions` with a discriminator `type` column (issuance, redemption, transfer_out, transfer_in). Partner referrals form a tree in `mgc_tree`, with weekly batched payouts via `partner_commissions` → `settlements`. Square POS integration (Phase 3) and per-partner branded email (Phase 4) are the two newest layers.

## Repo layout

```
LYMX Backend/
├── README.md                      ← you are here
├── PARTNER-EMAIL-SETUP.md         ← Cloudflare + SES + Resend setup walkthrough
├── migrations/                    ← run in order via Supabase SQL editor
│   ├── 001_initial_schema.sql     ← 11 tables, RLS, triggers
│   ├── 002_rls_policies.sql       ← 17 policies + 3 helper functions
│   ├── 003_grants.sql             ← table-level grants for service_role + authenticated
│   ├── 004_square_integration.sql ← square_integrations + square_webhook_events
│   └── 005_partner_email_provisioning.sql
└── functions/                     ← deployed via Supabase web editor
    ├── _shared/
    │   ├── cors.ts
    │   └── email/templates/partner-welcome.ts
    ├── business-signup/           ← public; creates auth user + biz + location + 3-mo trial
    ├── customer-wallet-create/    ← user JWT; idempotent customer + wallet creation
    ├── issuance/                  ← biz-owner OR service-role; mints LYMX from $ purchase
    ├── redemption/                ← biz-owner OR service-role; 80% rule cap
    ├── transfer/                  ← customer; LYMX A→B at SAME business (paired tx)
    ├── settlement/                ← service-role; bundles partner commissions weekly
    ├── partner-provision-email/   ← service-role; auto-provisions @getlymx.com email
    ├── partner-revoke-email/      ← service-role; offboarding companion
    └── partner-acknowledge-email/ ← user JWT; flips partner_acknowledged_at
```

External docs in the repo: `PARTNER-PLAYBOOK.md` (commission structure, partner-facing). Outside the repo (in Drive at `Gemini/shared accross projects/`): `COMPANY-EMAIL-ARCHITECTURE.md` (multi-tenant email design — LYMX is one tenant of this pattern).

## Endpoints at a glance

All endpoints live under `https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/`.

| Endpoint | Method | Auth | What it does |
|---|---|---|---|
| `business-signup` | POST | Public | Creates an auth user + `businesses` row + primary `business_locations` + 3-month-trial `business_subscription`. Optionally credits a referring partner with the $500 sign-up bonus. |
| `customer-wallet-create` | POST | User JWT | Idempotent: finds-or-creates a customer row + wallet for the (customer, business) pair. Used by the customer-facing app the first time someone interacts with a business. |
| `issuance` | POST | Biz-owner OR service-role | A business issues LYMX to a customer based on a $ purchase. `lymx_issued = floor(usd_amount * issuance_rate)` (default rate 5/$1). Has POS idempotency via `pos_external_id`. |
| `redemption` | POST | Biz-owner OR service-role | A customer pays for part of a purchase with LYMX. Enforces the **80% rule**: max 80% of `usd_total` can be paid via LYMX. `usd_paid = lymx_redeemed / (rate * 100)`. POS-idempotent. |
| `transfer` | POST | Customer (sender's JWT) | Customer A sends LYMX to Customer B at the **same** business. Two paired transactions (`transfer_out` + `transfer_in`) linked via `paired_transaction_id`. Auto-provisions receiver wallet if missing. |
| `settlement` | POST | Service-role only | Bundles unpaid `partner_commissions` for a date range into payable `settlements` — one row per partner. Supports `dry_run`. Idempotent: re-running the same period only picks up still-unsettled commissions. |
| `partner-provision-email` | POST | Service-role only | Auto-provisions `firstname.lastname@getlymx.com` for a new partner. Calls Cloudflare API + Resend. See `PARTNER-EMAIL-SETUP.md` for the infra side. |
| `partner-revoke-email` | POST | Service-role only | Offboarding companion. Deletes the Cloudflare route, flips `partner_emails.status` to `suspended`. Idempotent. |
| `partner-acknowledge-email` | POST | User JWT (partner) | Called when a partner clicks "I've set up my Gmail" in their dashboard. Flips `partner_acknowledged_at`. Idempotent — re-calls return the existing timestamp. |

Detailed request/response shapes are documented in the file-level comment block at the top of each `functions/*/index.ts`.

## The auth pattern lesson (read this before adding new endpoints)

Supabase's Edge Function gateway can re-stamp the `Authorization` header before your function sees it. **A literal token compare like `token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` is unreliable** — it works in some deploy paths and fails in others, and we wasted a debug session on this with the settlement endpoint.

**Always use the JWT role-claim decode pattern:**

```typescript
function getJwtRole(jwt: string): string | null {
    try {
        const parts = jwt.split(".");
        if (parts.length !== 3) return null;
        const payload = JSON.parse(
            atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
        );
        return payload.role ?? null;
    } catch {
        return null;
    }
}

const isServiceRole = getJwtRole(token) === "service_role";
```

Both legacy service_role keys and gateway-stamped service_role JWTs have `payload.role === "service_role"`, so this is reliable. See `functions/settlement/index.ts` for the canonical implementation, and `partner-provision-email/`, `partner-revoke-email/`, `issuance/`, `redemption/` for ports.

## Schema overview

11 tables from migration 001 + 2 from 004 + 1 from 005 = **14 tables total**.

| Table | Purpose |
|---|---|
| `organizations` | Chain owners (rare; most businesses are single-location) |
| `businesses` | One row per merchant. Has `issuance_rate`, `redemption_rate`, `redemption_cap_pct`. |
| `business_locations` | Multi-location chains; primary location flag |
| `business_subscriptions` | $850 sign-up + $200/mo recurring; trial periods |
| `partners` | Recruiters/affiliates. Tree position via `sponsor_partner_id`. `is_founding_25` flag for grandfathered perks. |
| `customers` | Anyone with a wallet at any LYMX business |
| `wallets` | Per-(customer, business) pair. `balance` + `lifetime_earned` + `lifetime_spent`. |
| `transactions` | Append-only ledger. Discriminated by `type`: issuance, redemption, transfer_out, transfer_in. |
| `mgc_tree` | Materialized partner-tree for fast generation lookups |
| `partner_commissions` | Per-event commission rows (9% direct / 3% G1 / 2% G2 / 1% G3 of LYMX revenue) |
| `settlements` | Weekly batched payouts; each settles 1+ partner_commissions |
| `square_integrations` | One per business; OAuth tokens for Square POS (Phase 3) |
| `square_webhook_events` | Idempotent log of incoming Square webhooks |
| `partner_emails` | Per-partner provisioned `@getlymx.com` email + SMTP creds (Phase 4) |

Sensitive columns (Square OAuth tokens, SES SMTP creds) are protected by **column-level REVOKE**, not just RLS — even a biz owner running `select *` gets a permission error on those columns. Service-role bypasses both.

## Env vars (Supabase Edge Functions secrets)

| Key | Used by | Source |
|---|---|---|
| `SUPABASE_URL` | All | Auto-set by Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | All | Auto-set by Supabase |
| `CF_ZONE_ID_LYMX` | partner-provision/revoke | Cloudflare zone for `getlymx.com` |
| `CF_API_TOKEN_LYMX` | partner-provision/revoke | Cloudflare API token (Email Routing Rules + Zone DNS) |
| `SES_REGION` | partner-provision | e.g. `us-east-1` |
| `SES_SMTP_USERNAME` | partner-provision | AWS SES SMTP creds |
| `SES_SMTP_PASSWORD` | partner-provision | AWS SES SMTP creds |
| `RESEND_API_KEY` | partner-provision | Resend dashboard |
| `EMAIL_FROM` | partner-provision | e.g. `LYMX <hello@getlymx.com>` |
| `LYMX_DOMAIN` | partner-provision | defaults to `getlymx.com` |
| `LYMX_SITE_URL` | partner-provision | defaults to `https://getlymx.com` |

(Square integration env vars come in Phase 3 when we wire OAuth + webhook endpoints.)

## How to deploy / develop

**Migrations** run via the Supabase dashboard's SQL editor. Paste the file contents, hit Run. Each file is idempotent-safe to re-run only if you DROP first — they create tables, so a second run errors. Migrations 001-003 are confirmed run; 004 + 005 are pending as of 2026-05-03.

**Edge Functions** deploy via the Supabase web editor (Edge Functions → Create new function → paste contents → Deploy). For functions that import from `_shared/`, you also need to upload the shared files into the function's `_shared/` path. See the deploy steps in `PARTNER-EMAIL-SETUP.md` §D2 for the partner-email functions.

**Local development.** This backend has no local Deno setup yet — we develop by editing the `.ts` files in this repo, then paste-deploying to Supabase via the web editor. (Supabase CLI deploys are possible but not yet wired up.)

**Testing.** No automated test suite yet. Smoke tests for each endpoint are documented in the per-file header comments and in memory entries. The partner-email pipeline has explicit smoke-test curl examples in `PARTNER-EMAIL-SETUP.md` §E.

## Workflow conventions

- **Branches:** `main` is production; `kenny` and `dave` are personal feature branches. PR-to-main with cross-review when both are working on the same area.
- **Commits to main are direct (no PR)** during initial buildout — Kenny is bypassing branch protection rules. Once Dave is fully ramped up we'll switch to PR-required.
- **File-level comment blocks** at the top of every Edge Function document: route, auth, request body, response, and notable design decisions. Keep these updated when behavior changes.
- **`_shared/` lives at `functions/_shared/`** for cross-function utilities. CORS is the only generic helper there; per-function CORS is also inlined for web-editor-deployment portability.

## What's next

Phase 3 (Square POS): `square-oauth-init`, `square-oauth-callback`, `square-webhook` (with HMAC verification + event_id idempotency).

Phase 4 (partner email): infra setup per `PARTNER-EMAIL-SETUP.md` (Cloudflare zone, SES domain verify, Resend), then deploy + end-to-end test.

Phase 5+: chain-permissions UI, more POS integrations (Toast, Clover), partner dashboard, scheduled reconciliation jobs.
