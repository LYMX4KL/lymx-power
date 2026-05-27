---
slug: business-onboarding-08-settlement
title: How your monthly LYMX settlement works
project: LYMX Power
role: business
prereqs:
  - approved_business
  - stripe_connect_pending_or_live
duration_min: 4
difficulty: easy
last_verified: 2026-05-27
related:
  - business-onboarding/06-issuing-lymx
  - business-onboarding/07-customer-redeems
supersedes: null
---

# How your monthly LYMX settlement works

Every month LYMX nets your unit purchases against your buy-backs and either pays you or charges you the difference. The page that shows this is **biz-payouts.html** (sidebar → Business → Payouts (Stripe)).

## The two sides

**You → LYMX (unit purchases).** Every time you issue LYMX to a customer, we charge you $0.008 per LYMX — that's the 80%-of-face-value unit cost. Issuing 1,000 LYMX to a customer costs you $8. This is the cost of running rewards through LYMX instead of a punch card.

**LYMX → You (buy-backs).** Every time a customer redeems LYMX at your business — whether those LYMX were earned at your store or at any other LYMX business — LYMX buys those redeemed units back from you at the same $0.008 per LYMX. The customer experiences a $0.01-per-LYMX discount (face value); the 20% gap between face value and buy-back is your effective discount expense, the cost of acquiring or rewarding that customer.

## The math, in one equation

For each calendar month, the table `business_settlements` records:

- `lymx_issued` — total LYMX you issued in the period (from the canonical pipeline `public.lymx_issuances`)
- `lymx_redeemed` — total LYMX customers redeemed at your business in the period
- `usd_owed_by_cents` — what you owe LYMX for unit purchases (= `lymx_issued` × $0.008)
- `usd_owed_to_cents` — what LYMX owes you for buy-backs (= `lymx_redeemed` × $0.008)
- `net_cents` — `usd_owed_to_cents` minus `usd_owed_by_cents`

If `net_cents` is positive, LYMX wires the difference to the bank you connected via Stripe Connect. If negative, LYMX charges your Stripe subscription card on file. Zero-activity months show `status = skipped_zero` so the record exists but nothing moves.

## When it runs

Settlement runs on the **5th business day** of each month, covering the previous calendar month. No action needed from you — the run is automatic. You can see the result on your biz-payouts.html "Settlement history" card the same day.

If LYMX Power's Stripe Connect platform application is still pending Stripe approval (the "Coming soon" banner is visible at the top of biz-payouts.html), settlement runs still happen and the ledger is recorded — but no money moves until Stripe clears the platform. The moment Stripe clears, the next monthly run pays out whatever balance has accumulated.

## What you'll see on the page

The **Settlement history** card on biz-payouts.html has two parts:

1. **Current period** — your running unsettled net since your last settled `period_end`. If you've never had a settlement run, this shows the all-time net. This is "what would settle right now if we ran today."
2. **Past settlements** — a chronological list of every prior settlement period: dates, LYMX issued + redeemed, net USD, and status (`pending`, `approved`, `paid`, `failed`, `skipped_zero`).

## What you might run into

**"Coming soon — waiting on Stripe approval"** banner is showing. That's the `app_config.stripe_connect_enabled` flag set to false. LYMX Power is waiting on Stripe to approve the Connect platform application. Your settlement records still accrue; payment fires the next monthly run after Stripe clears.

**No past settlements yet.** Expected for any business in their first month — the first monthly run hits on the 5th business day of next month and covers everything from your activation date forward.

**The net seems wrong.** Compare against your raw activity: open `customer_redemptions` (in your biz analytics) and your `lymx_issuances` history. The settlement row equals `(redeemed × $0.008) − (issued × $0.008)`. If those numbers match but the settlement net doesn't, file a feedback ticket — that's an integrity bug we need to know about.

## Glossary

- **Face value** — $0.01 per LYMX. What the customer sees as their balance and what the discount is worth at the counter.
- **Unit cost / buy-back rate** — $0.008 per LYMX. What you pay LYMX when you issue, and what LYMX pays you back when a redemption happens. The 20% gap is your discount expense.
- **Net cents** — positive = LYMX pays you; negative = LYMX charges you. Either way, the math is symmetric — no hidden fees in the settlement engine itself. (Your $199 subscription and any over-3000-order transaction fees are billed separately, not netted into the settlement.)
- **`business_settlements` table** — one row per (your business, calendar month). Idempotent; re-running the same period returns the existing row.
