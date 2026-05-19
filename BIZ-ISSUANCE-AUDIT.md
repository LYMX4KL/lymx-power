# Business → LYMX issuance audit (2026-05-19)

End-to-end walk-through of what works, what's a gap, and how the fraud layers stack up.

## Recruiting → Onboarding (CLOSED ✓)

Built and live:
- `biz-signup.html` — Form A intake (storefront + self-employed). Auto-attributes to referring partner via `?ref=P-000123`.
- `admin-business-applications.html` — Kenny reviews each submission, approve / reject.
- `business-approval-email` Edge Function — sends auto welcome / decline email.
- `biz-launch-day.html` + `biz-launch-week.html` — onboarding milestone pages.
- `biz-dashboard.html` — first login lands here, shows wallet + transactions.
- Migration 035 — bridges biz-signup to `business_partners` table + approval state.
- `book-onboarding-call.html` + `admin-onboarding-calendar.html` — Rachel-led 30-min calls.

**Nothing missing on the funnel from recruit → approved business landing on their dashboard.**

## Gap: business actually issues LYMX (NOT CLOSED ❌)

This is the gap. `pos.html` has the entry UI (customer phone + purchase amount + Issue LYMX button), but the `commitIssue()` JavaScript function only adds a row to the on-screen log and shows a toast — **it does not insert into the `lymx_issuances` table**. The today's-stats display reads from `lymx_issuances` so the schema is correctly set up, but nothing gets written from the button.

What works:
- UI / form / preview math ✓
- Today's stats panel reads real `lymx_issuances` data ✓
- Active promo banner ✓
- Schema + RLS + fraud trigger (migration 048) all ready ✓

What's missing:
- Phone-based customer lookup (find recipient_user_id from typed phone)
- Actual INSERT into `lymx_issuances`
- New-customer flow (phone has no LYMX account yet → send welcome SMS or hold issuance pending)
- Refresh stats after commit
- Error toast on failure (RLS denial, fraud flag, etc.)

**Fixing this unblocks the end-to-end flow for every business — POS-integrated and cash-drawer alike.**

## End-to-end flow once the gap is closed

### Scenario A — Modern POS business (Square / Toast / Clover / Lightspeed / Shopify)
1. Customer pays $20 at the register through their POS as normal.
2. POS API webhook fires a "transaction completed" event → LYMX webhook receiver writes the issuance.
3. Customer's wallet credits +100 LYMX (at 5 LYMX/$ rate). No cashier action needed.
4. Receipt prints with "+100 LYMX earned · text RECEIPT to 555 to claim" on the bottom.
5. New customer (no account) receives a welcome SMS; first sign-up bonus claim adds another +100 LYMX.

Required to fully ship Scenario A: live POS-vendor webhook endpoints + production keys per vendor. The `biz-integration-*.html` pages are informational placeholders today (no working webhook code).

### Scenario B — Cash-drawer business (no POS integration)
1. Customer pays cash for a $20 latte + croissant.
2. Cashier opens `pos.html` on the tablet, types customer phone, types $20, taps **Issue LYMX**.
3. `commitIssue()` (after the fix below) inserts into `lymx_issuances` and credits the customer.
4. Tablet prints a small receipt — `pos-receipt.html` template handles this.
5. Customer's wallet shows +100 LYMX within seconds.
6. New customer flow: phone has no LYMX account → SMS welcome → they sign up, the pending issuance attaches automatically.

This works for cash-drawer-only businesses. It also works as a *fallback* for POS-integrated businesses when their POS is down, when the customer pays cash, or when the cashier wants to apply a bonus manually.

### Scenario C — Customer pulls (receipt-scan, retroactive)
1. Customer forgot to give their phone at the register, or shopped at a brand-new LYMX business that hasn't set up their tablet yet.
2. Customer opens `review-write.html` from their phone, photographs the receipt, fills in the amount.
3. Submission is admin-verified (Kenny / staff approves via `admin-reviews.html`).
4. Verified → `lymx_issuances` row inserted with `reason: 'receipt_scan'` + receipt photo URL attached.
5. Customer's wallet credits +100 LYMX (and they also get the per-review bonus).

This path is wired today via migrations 030-033 (transaction-gated reviews) and `lymx-reviews.js`.

## Fraud prevention layers

Every issuance — whether from POS webhook, cash-drawer tablet, or receipt-scan — flows through one chokepoint: `INSERT INTO lymx_issuances`. The fraud layers all hang off that insert:

### Layer 1 — DB hard-block (migration 048)
- RLS policy `tx_no_customer_transfers` blocks any non-admin trying to insert `transfer_in` / `transfer_out` types. Customers cannot send LYMX to each other; only the platform issues + buys back. Kenny's hard rule.
- Trigger `trg_detect_self_issuance` fires on every insert. If the business issues to a recipient who is itself the business owner (via `fn_is_business_owner()`), a `high` severity fraud flag is auto-written to `fraud_flags`. This catches the 20% arbitrage attack: owner buys LYMX at 80% face from us, redeems at 100% face at a different business.

### Layer 2 — Daily pattern scan (migration 050, cron 04:30 UTC)
The `fraud-scan` Edge Function batch-scans `lymx_issuances` for:
- **Burst issuance** — business issues 5× their 30-day average in one day.
- **Arbitrage loop** — issuance to an account that immediately redeems back through a partner business.
- **Concentration** — one business issues >50% of its volume to a single customer.
- **Stale open flags** — open flags older than 7 days escalate severity.

### Layer 3 — Admin triage UI
`admin-fraud-flags.html` — Kenny reviews each flag, marks **Clear (false positive)**, **Confirm fraud**, or **Mark reviewing**.

### Layer 4 — Receipt-scan dedupe (NEW GAP for Scenario C)
For receipt-photo issuances specifically, two extra checks not yet built:
- **Receipt hash dedupe** — hash the receipt photo (perceptual hash) and reject duplicates. Same receipt can't be claimed twice (e.g. customer + accomplice both scan the same paper receipt).
- **Amount + date sanity** — if the receipt OCR's amount doesn't match the typed amount within 5%, flag for admin manual review.

### Layer 5 — Business-sale ownership transfer (migration 049)
The only path for LYMX to legally change hands outside the issue/redeem cycle is when a business is sold. `fn_transfer_business_ownership()` RPC is admin-only and audits to `business_ownership_transfers`. No customer-to-customer transfer ever.

## Recommended next moves (priority order)

1. **Wire `pos.html` commitIssue() for real** — single biggest gap. Unblocks all cash-drawer businesses and gives POS-integrated businesses a manual fallback. ~30 min of code. (I'll do this now.)
2. **Phone-based customer lookup** — `find_or_create_customer_by_phone()` RPC. If new, set status `pending_signup` + send welcome SMS. ~migration 052.
3. **Receipt-photo dedupe** — perceptual hash on review-write submissions, reject duplicates at insert time. ~migration 053.
4. **Per-business QR generator** — script to regen the print kit with each Founding 25 partner's slug embedded. ~1 hr of Python.
5. **Live POS webhook endpoints** — Square first (highest priority for the Vegas market). Phase 2 work, after the manual path is solid.

## Bottom line for Kenny

The recruiting → onboarding path is closed. The "business actually issues LYMX" path has the UI but lacks the database write. Once `pos.html` commitIssue() is wired (next), cash-drawer businesses are fully live and POS-integrated businesses have a manual fallback. The fraud layers already cover the issuance side; receipt-scan dedupe is the remaining hardening item.
