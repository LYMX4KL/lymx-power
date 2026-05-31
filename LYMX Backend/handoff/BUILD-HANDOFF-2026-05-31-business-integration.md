# BUILD HANDOFF — Business Integration (read-pull) + onboarding auto-invite
**Session date:** 2026-05-31 · **Project:** LYMX Power (Supabase `apffootxzfwmtyjlnteo`)

> ⚠️ **COORDINATION — two sessions running.** This session built the business-integration
> read-pull pipeline + onboarding auto-invite. The OTHER session is debugging. **Do not let
> both sessions edit the files/migrations/EFs listed under "OWNED BY THIS BUILD" at the same
> time.** If the debug session must touch them, finish/za this build first.

---

## 1. What is LIVE now (deployed + verified this session)

**Migrations applied to PROD (in order):**
- `159` business-integration foundation: on `businesses` → `api_key`, `api_key_rotated_at`,
  `integration_active`, `identity_match_mode`; new tables `business_event_catalog`,
  `business_events`, `lymx_pending_claims`, `business_redeem_intents`; `customers.legal_name`
  (+ one-wallet-per-person partial unique idx); `lymx_issuances` settlement-freeze cols;
  `regenerate_business_api_key(uuid)` RPC.
- `160` add `reason='business_event'` to `lymx_issuances_reason_check`.
- `161` onboarding auto-invite: `email_templates` (key `business_integration_invite`),
  `businesses.tech_contact_email`, `business_integration_invite_log`, trigger
  `fn_send_integration_invite_on_intake()` (was UPDATE-only).
- `162` fix: invite trigger now fires on **INSERT OR UPDATE OF intake_completed_at**.
- `163` pull source: `business_integration_source` (RLS, service-role-only token),
  `set_business_integration_source(...)` admin RPC, + creates/activates **InvestPro Realty**
  business record (`slug=investpro`).
- *(staged, NOT yet applied)* none outstanding — 159–163 all applied.

**Edge Functions deployed (all `verify_jwt = OFF`):**
- `business-event` — generic earn engine. api_key auth → catalog rate → reuses
  `lymx_issuances` (fraud guard applies) → no-wallet creates 24h `lymx_pending_claims`.
  Idempotent on `(business_id, external_ref)`. **e2e verified: all 6 paths green.**
- `send-business-integration-invite` — emails the onboarding "build one read endpoint"
  letter (template-driven). Auto-fired by trigger on intake; also callable manually.
- `pull-business-transactions` — the read-pull connector. `{business_id, dry_run, limit}`.
  Fetches `business_integration_source` feed → maps each txn → calls `business-event`.
  `dry_run:true` returns a sample without issuing.

**Frontend:** `admin-business-applications.html` — added "📧 Send integration invite"
button on approved-business cards (calls `send-business-integration-invite`).

**Other fixes shipped + verified:** `admin-manage-permissions.html` staff-names (reads
`staff_roles.display_name/work_email`); band-aid cleanup in `lymx-projector.js`,
`lymx-comp-config.js`, `lymx-momentum.js`.

---

## 2. InvestPro LIVE integration state
- Business row: `slug=investpro`, id `6727889c-f488-42b8-a2ad-1cc939fea345`,
  `integration_active=true`, `intake_completed_at` set, `identity_match_mode='required'`,
  api_key set, invite suppressed (`business_integration_invite_log` row `skipped_pre_integrated`).
- Feed: `GET https://investprorealty.net/lymx/transactions?since=<ISO>`, `Authorization: Bearer <token>`.
  Token stored in `business_integration_source` (service-role-only). **Token confirmed working.**
- Catalog seeded: `fee_application` → **5 LYMX/$1** (Kenny: 5/$1 on ALL IP fees), redeemable, approved.
- **Live pull result (real):** 3 `fee_application` $75 txns pulled, rate applied; all 3 emails had
  no LYMX wallet → **3 × 24h pending claims** created, 0 issued (correct: no wallet → no LYMX).
- To run a pull: POST `/functions/v1/pull-business-transactions` `{business_id:'6727889c-...', dry_run:false}`
  with admin JWT + anon apikey.

---

## 3. OWNED BY THIS BUILD — do not edit concurrently
EFs: `business-event`, `send-business-integration-invite`, `pull-business-transactions`.
Tables: `business_event_catalog`, `business_events`, `lymx_pending_claims`,
`business_redeem_intents`, `business_integration_source`, `email_templates`,
`business_integration_invite_log`; `businesses` integration cols.
Frontend: `admin-business-applications.html` (invite button block).
Migrations: 159–163. Module rules: `14-Project Modules/ARCHITECTURE-RULES.md`,
`reference/LYMX-BUSINESS-API-HANDOFF.md`, `reference/LYMX-TRANSACTION-FEED-ASK.md`.

---

## 4. NEXT BUILDS (not started — pick up here, single session at a time)

**A. Claim-invite email (no-wallet → "join in 24h") — HIGH (Kenny priority "capture the opportunity").**
On a new `lymx_pending_claims` insert, email the customer: benefits of joining, 24h window,
their claim link (`https://getlymx.com/signup.html?claim=<invite_token>`), + a few LYMX
businesses they'd like (directory). Pattern = mirror mig 161 (AFTER INSERT trigger → pg_net →
new EF `send-claim-invite`) + `email_templates` row `customer_claim_invite` + idempotency col
`lymx_pending_claims.invite_emailed_at`. ⚠️ Sends to REAL customer emails — Kenny to confirm
scope (all real vs his test only) before going live.

**B. Scheduled auto-pull — HIGH.** pg_cron + pg_net call `pull-business-transactions` for each
active `business_integration_source` every N min (true hands-free). Today the pull is MANUAL.

**C. Issue-path live demo.** The 3 test txns are locked `no_wallet` (idempotency). To show
375 LYMX landing in a wallet + posting to InvestPro portal: have InvestPro post a fee for an
email that already has a LYMX wallet, then pull.

**D. Add InvestPro's other eligible fee types to catalog** once their exact `type` strings appear
(only `fee_application` confirmed; lease-processing + late not yet seen). All at 5/$1.

**E. Redeem path** (handoff §5.2 / §11): hosted consent OR in-app owner-confirm; reverse; balance.

**F. Module-bank + playbook** for the connector (build-everything-into-the-bank rule).

---

## 5. Carried-over bug-triage (NOT done — feature work pre-empted it)
Open feedback clusters from session start (LYMX inbox): **C** no-data/dead-wallet-buttons,
**D** remaining admin bugs (invite-resend fail #1, offer-letter error #45, back-button CSS #3,
HR-launch-email #46, bulk-policy #0), **B** partner-tree UX (#4–8), **E** misc UX (#32,33,39,40,42,43,44).
Cluster A (19 marketing gate-bounce tickets) was resolved; Helen emailed to toggle marketing perms.

---

## 6. Outstanding cleanups
- **Delete test businesses** (REST can't — RLS; run in SQL editor):
  `f3d62c6b-74e2-4000-8a3d-758989b27dc2` (API Test Co) + `d0e6913f-ce0b-4020-8e5c-880edd3b5bba`
  (E2E Test Biz) — delete from business_events, lymx_pending_claims, lymx_issuances,
  business_event_catalog, business_integration_invite_log, then businesses.
- **Stale `PUSH-*` staging folders** in `2-LYMX Power/LYMX Power/` (PUSH-BUGS-1/2, PUSH-HR-MIGRATIONS,
  PUSH-PAY, PUSH-POS-WEBHOOK, PUSH-POS-WIRE) — Rule 3.1 violations, safe to remove after diff-check.
- Confirm latest push is live on Netlify (admin button page).

---

## 7. Key rules (memory) governing this work
NO WALLET → NO LYMX. Member-only network. LYMX is rewards not money — we only consume the
business's transaction info (amount/type/txn-id+date/their customer ref), wallet resolution is
ours. Business does nothing/won't hire. 3 roles only (business/partner/customer) — "business_partner"
table is legacy/deprecated; anchor on `businesses`. Email staff/partners at @getlymx.com alias.
See memory: `project_lymx_business_integration_model.md`.
