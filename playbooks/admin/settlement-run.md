---
slug: admin-settlement-run
title: Run a monthly business settlement batch
project: LYMX Power
role: admin
prereqs:
  - admin_role
  - app_config_singleton_row
duration_min: 5
difficulty: easy
last_verified: 2026-05-27
related:
  - business-onboarding/08-settlement
supersedes: null
---

# Run a monthly business settlement batch

The settlement run is the load-bearing monthly job that closes the LYMX-Power-as-clearing-house loop. It computes, per business, how much was issued in the period vs. how much was redeemed at that business, and writes a row to `public.business_settlements`. The actual Stripe leg (transfer or invoice) is a separate, manual approve-then-execute step so no money moves accidentally.

## When you run this

**Cadence:** 5th business day of each calendar month, covering the previous calendar month. The plan is to have a scheduled job hit the EF automatically; until that job is wired, an admin clicks "Run settlement" on `admin-settlements.html` on the 5th business day each month.

**Ad-hoc:** you can run a single business or a custom date range any time — useful for resolving disputes, computing a mid-month estimate, or backfilling a missed month.

## Step-by-step

1. **Open admin-settlements.html** (sidebar → Admin → Network → Settlements).
2. **Period defaults to the previous calendar month** — leave it as-is for the regular monthly run. For a specific business, paste the UUID into the optional Business field.
3. **Dry run first** if you're unsure. Click "Dry run" — the EF computes per-business numbers and reports the totals but writes no rows. Use this to verify the period totals match what you expect.
4. **Click "Run settlement"** for the real run. The EF iterates every approved business, computes net cents via `fn_compute_business_settlement`, and inserts a `pending` row for each. Existing rows for the same (business, period_end) are skipped — idempotent. Zero-activity businesses get a `skipped_zero` row so the record exists.
5. **Review the summary** — Computed / Skipped existing / Skipped zero / Pending payout / Pending charge. Anything unexpected here means we should investigate before approving rows.
6. **Approve pending rows individually** in the Pending Settlements table. Approving a row sets `status = 'approved'` and stamps `approved_by` to your admin user. **No Stripe leg fires yet** — that's Sprint 2.
7. **Stripe execution** (Sprint 2): a follow-up EF `business-settlement-execute` will read every `approved` row and call `stripe.transfers.create` (when net > 0) or create an invoice item (when net < 0). Stripe execution is gated by `app_config.stripe_connect_enabled` — flip that to true the moment Stripe approves the LYMX Connect platform.

## The math, for your reference

Per business per period, the EF calls `public.fn_compute_business_settlement(business_id, period_start, period_end)` which computes:

```
lymx_issued       = sum(amount_lymx) where reason <> 'redemption' and business_id = B and admin_status in ('auto','approved')
lymx_redeemed     = -sum(amount_lymx) where reason  = 'redemption' and business_id = B and admin_status in ('auto','approved')
usd_owed_by_cents = sum(business_cost_cents) where reason <> 'redemption'
usd_owed_to_cents = round(lymx_redeemed * app_config.buyback_rate_cents_per_lymx)
net_cents         = usd_owed_to_cents - usd_owed_by_cents
```

`buyback_rate_cents_per_lymx` lives in `public.app_config` (default 0.8 = $0.008 per LYMX). Adjust it from `admin-app-config.html` (Sprint 2) or directly via SQL.

## What you might run into

**Status = `skipped_stripe_disabled`** — `app_config.stripe_connect_enabled` is still false. The ledger row exists but no Stripe call will fire even after approve. Expected behavior pre-platform-launch.

**EF returns 403 "requires admin or service_role"** — your JWT isn't from an admin account. Check `am_i_admin()` returns true for your `auth.uid()`. If you ARE admin but the call rejects, check `public.staff_roles` for your row (role must be 'admin' OR `is_cfo=true` OR `is_hr=true` per migration 102).

**A business shows `status_message: 'No issuance or redemption activity in this period'`** — that's `skipped_zero`. Expected for businesses that didn't issue or redeem in that period (e.g., a new approval that hadn't started yet). The row exists so the record is complete; no action needed.

**Re-running a period shows everything as "already-computed"** — that's the idempotency guarantee. To force a recompute, manually delete the existing row from `business_settlements` and re-run. (Don't do this casually — only when you've corrected upstream data and need a fresh snapshot.)

**The Pending Settlements table shows a row I don't recognize** — every settlement row has a business UUID + a period. Cross-reference against the businesses table to see which business it belongs to. If it's a deleted/test business, mark it `skipped_zero` manually before approving.

## Glossary

- **Period** — calendar month, expressed as `[period_start, period_end)`. period_end is the first day of the FOLLOWING month (exclusive).
- **Approve** — admin click that transitions `pending` → `approved`. Required gate before any Stripe leg.
- **Execute** — Sprint 2 EF that reads `approved` rows and fires the Stripe leg. Not implemented yet.
- **Idempotent** — re-running for the same `(business_id, period_end)` returns the existing row unchanged. Safe to retry.
