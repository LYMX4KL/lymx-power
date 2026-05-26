---
slug: business-onboarding-06-issuing-lymx
title: Issue and redeem LYMX at your business (Module 5 — unified pipeline)
project: LYMX Power
role: business-owner
prereqs:
  - business_approved
  - onboarding_call_completed
duration_min: 5
difficulty: easy
last_verified: 2026-05-26
related:
  - business-onboarding/README
  - business-onboarding/05-booking-the-call
supersedes: null
---

# Issue and redeem LYMX at your business

Module 5 of the biz-onboarding roadmap unified the LYMX issuance + redemption pipeline. Pre-Module-5, the `issuance` Edge Function wrote to a `transactions` + `wallets` pair of tables that nothing read from, while every UI read from `lymx_issuances` (the canonical ledger) — so every POS issuance silently disappeared from customers' dashboards. Module 5 routes every issuance and redemption through `lymx_issuances` directly, and `v_my_lymx_balance` does the math (positive issuance rows add, negative redemption rows subtract).

## What you'll need
- An approved LYMX business (see playbook 03-approval)
- Your customer's identifier — `recipient_user_id` (preferred), or `customer_id`, or their phone/email (legacy paths)
- A USD transaction amount (whatever they just bought)

## What success looks like
The moment you call `/functions/v1/issuance`, a row lands in `public.lymx_issuances` with `reason='transaction'`, the customer's balance jumps in real time via `v_my_lymx_balance`, and the dashboard reflects it on next refresh. Redemptions work symmetrically (negative row, `reason='redemption'`). Replay attacks on the same `pos_external_id` return the original row idempotently — no double-credits even on flaky POS connections.

## How issuance works (for engineers / POS integrators)

### Step 1 — Call the issuance EF
```js
const r = await fetch(LYMX_URL + '/functions/v1/issuance', {
  method: 'POST',
  headers: {
    apikey: ANON_KEY,
    Authorization: 'Bearer ' + biz_owner_jwt,    // or SERVICE_ROLE for POS integrations
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    business_id: '<your-biz-uuid>',
    recipient_user_id: '<customer-auth-user-id>',  // preferred
    usd_amount: 12.50,                              // the bill
    transaction_method: 'pos',                      // pos / qr / app / review / referral
    pos_external_id: 'sq_xyz_abc',                  // optional idempotency key
    note: 'optional'
  })
});
```

### Step 2 — Server-side, the EF does
1. Authorizes the caller (owner of the business OR service_role).
2. Validates the biz is approved + not archived + not demo.
3. Resolves the recipient (`recipient_user_id` directly, OR falls back to looking up `customer_id` / phone / email).
4. Refuses self-issuance (a biz owner can't issue LYMX to themselves).
5. Computes `lymx_issued = Math.floor(usd_amount × businesses.issuance_rate)`. Default rate is 5 LYMX per $1.
6. Builds an `idempotency_key`: `pos_<pos_external_id>` if provided, otherwise a deterministic per-customer-per-cents-per-minute synthetic key.
7. Checks for an existing row with the same (`business_id`, `idempotency_key`) — returns it if found (replay-safe).
8. INSERTs into `lymx_issuances` with `reason='transaction'`, `admin_status='auto'`, `verified=true`.
9. Returns `{ ok, issuance_id, recipient_user_id, lymx_issued, new_balance, idempotent }`.

### Step 3 — Customer sees it
On their next page render, `v_my_lymx_balance` SUMs the new row in:

```sql
SELECT available_lymx, total_earned, total_redeemed
  FROM public.v_my_lymx_balance;
```

Their wallet card updates. No manual refresh needed if the page subscribes via realtime.

## How redemption works

Same EF shape, opposite sign:

```js
const r = await fetch(LYMX_URL + '/functions/v1/redemption', {
  method: 'POST',
  headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + biz_owner_jwt, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    business_id: '<your-biz-uuid>',
    recipient_user_id: '<customer-auth-user-id>',
    usd_total: 10.00,                       // total bill BEFORE LYMX is applied
    lymx_to_redeem: 200,                    // optional — defaults to MAX allowed
    transaction_method: 'pos',
    pos_external_id: 'sq_redeem_abc'
  })
});
```

### What the EF does
1. Authorizes the caller + validates the biz (same as issuance).
2. Resolves recipient via the same fallback chain.
3. **Verification gate**: customer must have `customers.verified_at IS NOT NULL`. Unverified customers can SIGN UP and EARN LYMX freely, but SPENDING is held until admin verification (see `admin-verifications.html`).
4. Computes current balance via `SELECT SUM(amount_lymx) FROM lymx_issuances WHERE recipient_user_id = ? AND admin_status IN ('auto','approved')`.
5. Applies the **80% rule** — at most `redemption_cap_pct` (default 0.80) of `usd_total` can be paid with LYMX. Max LYMX redeemable = `floor(usd_total × cap_pct × 100 × redemption_rate)`.
6. INSERTs a row with `amount_lymx = -lymxRedeemed`, `reason='redemption'`, idempotency-protected.
7. Returns `{ ok, redemption_id, lymx_redeemed, usd_paid_via_lymx, usd_remaining_to_charge, new_balance, idempotent }`.

The negative amount means `v_my_lymx_balance.available_lymx` (which is a plain `SUM(amount_lymx)`) naturally reflects the new balance — no separate `wallets.balance` to keep in sync.

## How to verify a row landed correctly

```sql
-- The most recent issuance for this customer at this biz
SELECT id, amount_lymx, reason, transaction_method, transaction_amount_cents,
       admin_status, idempotency_key, created_at
  FROM public.lymx_issuances
 WHERE recipient_user_id = '<customer-uuid>'
   AND business_id = '<biz-uuid>'
 ORDER BY created_at DESC
 LIMIT 5;

-- Customer's spendable balance (auth.uid()-scoped)
SELECT available_lymx, total_earned, total_redeemed, bonus_lymx, signup_bonus_count
  FROM public.v_my_lymx_balance;

-- Redemption history via the back-compat view (positive lymx_amount for UI convenience)
SELECT id, business_id, lymx_amount, usd_value_cents, created_at
  FROM public.customer_redemptions
 WHERE customer_user_id = auth.uid()
 ORDER BY created_at DESC;
```

## Common edge cases

### Customer doesn't have a row in `public.customers`
The EF resolves `recipient_user_id` (preferred), so that's enough — no `customers` row needed. If you only have a phone/email, the EF looks them up in `customers`; if not found, returns 404 asking the booker to sign up via `welcome.html?biz=<your-slug>` first.

### POS retries (network flake)
Pass `pos_external_id`. The EF dedups on `(business_id, pos_external_id)` and returns the original row with `idempotent: true`. The unique index `lymx_issuances_biz_idempotency_uniq` (migration 098) makes this race-safe even under concurrent retries.

### Customer tries to redeem before admin-verification
EF returns 403: *"Customer X is not yet verified. LYMX spending is held until admin verification in admin-verifications.html."* This is by design — signup is friction-free; spending requires the verification step.

### Customer tries to redeem more than 80% of the bill
EF returns 400: *"Exceeds 80% rule: requested N but max is M (80% of $X at rate 5)."* Adjust `lymx_to_redeem` or just omit it (defaults to max allowed).

### Customer's balance < requested redemption
EF returns 400: *"Insufficient balance: requested N but balance is M."* The balance source-of-truth is `SUM(lymx_issuances WHERE auto/approved)`.

### Self-issuance attempt (biz owner trying to credit themselves)
EF returns 400 *("A business owner cannot issue LYMX to themselves")* AND the `guard_lymx_issuance` trigger also blocks at the DB layer (defense in depth).

### Velocity limit hit
Trigger raises *"FRAUD BLOCK: <slug> exceeded velocity limit (N per hour)"*. Modern businesses default to 500/hour. Increase via SQL if you have a legitimate high-volume integration.

## What changed in Module 5 (for engineers)

| Layer | Pre-Module-5 | Module 5 |
|---|---|---|
| Issuance EF write target | `transactions` + `wallets` | `lymx_issuances` |
| Redemption EF write target | `transactions` (type=redemption) | `lymx_issuances` (negative amount) |
| Pre-existing wallet row required | YES (404 on first txn) | NO (single insert) |
| Balance source | `wallets.balance` | `SUM(lymx_issuances) WHERE auto/approved` |
| `v_my_lymx_balance` columns | bonus_lymx, available_lymx, pending_lymx, signup_bonus_count, first/last_issued_at | + total_earned, total_redeemed, redemption_count, last_redeemed_at |
| Idempotency | `pos_external_id` on `transactions` | `idempotency_key` on `lymx_issuances` (unique on biz+key) |
| `wallets` + `transactions` tables | Active writers, no readers | Deprecated — commented as such, retained for FK survival |
| `customer_redemptions` URL | 404 (table didn't exist) | View on top of `lymx_issuances WHERE reason='redemption'` |

## What's NOT in this playbook (Module 6+ scope)
- **Customer-facing redemption UX** — the customer-dashboard.html "Spend at biz" flow is Module 6.
- **Bulk admin reconciliation** — tools for spotting/fixing audit-status='pending_review' rows.
- **Dropping `wallets` + `transactions` tables** — a follow-up migration will hard-drop them once zero readers confirmed (currently kept with DEPRECATED comments).
