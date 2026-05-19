# Fraud prevention — current state + gaps (2026-05-19)

Audit done while wiring `pos.html` for real DB writes. The good news: most of your hard rules are already enforced at the database layer, so they apply universally — POS-integrated, cash-drawer, or receipt-scan, every issuance route goes through the same chokepoint.

## Your three hard rules (from the original brief)

> 1. LYMX can't be transferred customer-to-customer.
> 2. LYMX can only be purchased from the platform when a business issues against a real transaction.
> 3. Business is sold → LYMX transfers as inventory to the new owner if they stay on the platform.

## Where each rule is enforced

### Rule 1 — no customer-to-customer transfers

**Enforced at DB layer, hard-block.**

- Migration 048's RLS policy `tx_no_customer_transfers` on `public.transactions` rejects any insert with `type` in `('transfer_in','transfer_out')` unless the inserter is admin (`am_i_admin()`). This means: the API physically cannot create a transfer row for a non-admin user, period. Any customer-side attempt 403s at the database.

### Rule 2 — business issues only via real transaction

**Enforced at DB layer + UI layer.**

- Migration 012 trigger `enforce_issuance_rules` (auto-fires on every insert to `lymx_issuances`) checks:
  - Recipient's user_id must NOT be in the business's `owner_user_ids` array → `raise exception 'FRAUD BLOCK: Cannot issue LYMX to a business owner'`. This blocks the 20% arbitrage attack at the DB.
  - Reason must be one of: `signup_bonus | transaction | referral | manual | correction | promo` (CHECK constraint).
- POS UI (`pos.html`, just wired): requires phone + USD amount before the Issue button enables. If the recipient isn't a registered LYMX customer, the cashier sees "No LYMX account — send them pay.html first" rather than the issuance going through to an arbitrary ID.
- Receipt-scan UI (`review-write.html`): customer uploads receipt photo + types amount → admin manually reviews via `admin-reviews.html` before issuance lands. No auto-credit on receipt scan.

### Rule 3 — business-sale inventory transfer

**Enforced at DB layer, admin-only.**

- Migration 049 created `business_ownership_transfers` audit table + `fn_transfer_business_ownership()` SECURITY DEFINER RPC. Only admins can call it. Every transfer logs old owner, new owner, sale price, notes, timestamp.
- Admin UI: `admin-business-transfer.html` — 4-step wizard.

## Detection layers (post-insert)

### Layer A — Migration 048 trigger `detect_self_issuance` (CURRENTLY BROKEN ⚠)

This is supposed to soft-flag self-issuance to `fraud_flags` for admin review. **It references the column `new.source_business_id` which does not exist on `lymx_issuances` (real column is `business_id`).** It also looks up in `public.businesses` (singular owner_user_id) but `lymx_issuances.business_id` references `business_partners` (array owner_user_ids). Net effect: the trigger never writes a flag.

**This is OK because migration 012's HARD BLOCK already prevents self-issuance.** The soft flag was redundant. But you may want to repair migration 048 anyway so the flag-and-review path is available for less-clean attack patterns (close-but-not-exact owner relationships, multi-account collusion, etc.).

→ **Migration 052** (small repair, not urgent) would fix the column + table references.

### Layer B — Daily cron scan (migration 050, 04:30 UTC)

The `fraud-scan` Edge Function runs nightly and writes flags for:
- **Burst issuance** — business issued 5× their 30-day average in one day
- **Arbitrage loop** — issuance to an account that immediately redeems back through a partner business
- **Concentration** — one business issues >50% of its volume to a single customer
- **Stale open flags** — open flags older than 7 days escalate severity

These rely on `lymx_issuances` reads, not the broken trigger column, so they work today.

### Layer C — Admin triage UI

`admin-fraud-flags.html` — open / reviewing / cleared / confirmed buckets, with per-flag Clear / Confirm / Reviewing actions.

## Path-specific risks

### Path 1 — Modern POS webhook (Square / Toast / Clover / Lightspeed / Shopify)

**Lowest risk path** because the issuance is grounded in a real, verifiable external transaction:
- Square / Toast etc. give us a `transaction_id` and `transaction_amount_cents` that's signed by their backend.
- Our webhook receiver should:
  1. Verify the vendor's signature (Square: HMAC; Toast: bearer; etc.)
  2. Confirm the `transaction_id` is unique (idempotency key)
  3. Confirm the merchant_id matches a known LYMX business
  4. Insert into `lymx_issuances` with `transaction_method: 'webhook'`, `verified: true`
- The `enforce_issuance_rules` trigger then checks recipient is not the business owner.

**Currently:** webhook receiver code is NOT yet built. The `biz-integration-square.html` etc. pages are marketing placeholders. Phase 2 work.

### Path 2 — Cash-drawer tablet (manual POS via pos.html, just wired)

**Medium risk** because the only "proof of transaction" is what the cashier typed:
- Cashier could type a fake amount → over-issue LYMX to themselves or a friend
- Migration 012 hard-block stops issuance to OWN owner — but a friend's account is allowed
- Migration 050 daily scan catches concentration (>50% of biz volume to one user)

**Mitigations in place:**
- `business_cost_cents` field is calculated server-side from `amount_lymx × FEE_RATE` — business is billed for every LYMX they issue, so over-issuance is self-defeating economically (they pay 80% of face for every LYMX they create).
- Concentration trigger catches systemic abuse.
- Per-issuance `transaction_amount_cents` + `transaction_method='manual'` is logged, so post-hoc audit can compare against bank deposits or cash drawer reconciliation.

**Recommended adds (not blockers):**
- Daily max-issuance cap per business (operator-configurable, default e.g. $5k LYMX/day for new businesses).
- Cashier-vs-owner attribution: `issuing_user_id` is now stamped on every row. Reports can flag cashiers whose issuance pattern looks off.

### Path 3 — Receipt-scan (customer-side, review-write.html)

**Highest review burden** but lowest direct fraud surface because admin reviews every submission:
- Customer photographs receipt → submits via review-write.html
- Admin manually approves via admin-reviews.html → triggers `lymx_issuances` insert with `reason: 'manual'`

**Gaps to harden (recommended, not urgent):**
1. **Receipt hash dedupe** — perceptual hash of the receipt photo (pHash). Reject duplicates at submission. Same paper receipt can't be claimed twice (e.g. customer + accomplice with shared receipt).
2. **Receipt OCR cross-check** — extract amount + business name from the photo, compare to typed amount. >5% delta → admin must manually verify. <5% can auto-approve under a small daily cap.
3. **Time-window cap** — same business + same customer can only generate one receipt-scan per 4 hours. Catches receipt-recycling.

These are migration 053 + a small Edge Function. Not blocking launch but should be on the roadmap.

## Bottom line for Kenny

Your three hard rules are enforced at the DB level today. The two real risks are:

1. **Cash-drawer over-issuance** — businesses can type fake amounts. The economic disincentive (they pay 80% of face) + concentration detection handles most of this. A simple daily cap per business would close the rest.
2. **Receipt-scan duplicates / OCR-vs-claim mismatches** — admin manual review currently handles, but doesn't scale past a few hundred per day. Hash dedupe + OCR cross-check are the unlock.

Migration 048's self-issuance soft-flag trigger is silently broken (wrong column name) but it's redundant with migration 012's hard-block. Repair is low priority — file as migration 052 when you want to tidy up.

Everything else is launch-ready from a fraud-prevention standpoint.
