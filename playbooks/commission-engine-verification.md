---
slug: commission-engine-verification
title: How partner commissions are calculated (and how to verify them)
project: LYMX Power
role: admin
prereqs:
  - signed_in_as_admin_or_hr
duration_min: 12
difficulty: medium
last_verified: 2026-05-30 (engine shipped — awaiting first real-data verification by Helen/Dave)
last_revised: 2026-05-30 (created — commission calculation engine, migrations 138 + 139)
related:
  - comp-plan-partner-walkthrough
---

# How partner commissions are calculated (and how to verify them)

This is the plain-English explanation of the **commission engine** — the backend that
turns real business activity into the dollars and LYMX that partners earn. It's written
for **Helen and Dave** so you can (a) understand exactly how every number is produced and
(b) verify it against a hand calculation before we trust it with real money.

> **Why this exists.** Until 2026-05-30 the calculation engine didn't exist — the
> `partner_commissions` table was never populated, so every dashboard and projector
> showed $0. The engine (migrations 138 + 139) now computes commissions from real
> activity. Every rate is stored in a **config table**, never in code, so we can change
> rates for marketing without a developer.

## The three ways a partner earns

A partner is the person who **signed up a business** (the "direct" partner). Their
**upline** is their sponsor (G1), their sponsor's sponsor (G2), and one more level (G3).

**1. Activation bonus — one time, paid in CASH, to the direct partner only**
When a business goes live, the partner who signed them gets a one-time bonus:
- Regular partner: **$500**
- Qualified Founding-25 partner: **$750**

**2. Transaction-fee commission — recurring, paid in LYMX**
Every month, for each business, we look at the **LYMX volume** that ran through it —
that's **LYMX issued + LYMX redeemed** (both are transactions; both count). We charge a
**3% platform fee** on that volume, and the MGC is paid *on that fee*, in LYMX:

| Who | Rate on the fee |
|---|---|
| Direct partner | **9%** (regular) / **11%** (founding) |
| G1 (their sponsor) | 3% |
| G2 | 2% |
| G3 | 1% |

> The base is **LYMX volume**, NOT the dollar value of the customer's purchase. The flat
> "10 LYMX per transaction" charge is separate platform revenue and is **not** part of
> any commission.

**3. Monthly-fee commission — recurring, paid in CASH**
Each business pays a monthly subscription fee. The same MGC (9%/11% direct, 3/2/1% for
G1/G2/G3) is paid on the **monthly fee collected**, in cash — but **only after the
business's first 3 free months** (we don't pay commission on a fee we didn't collect).

**Only the direct rate changes for founding partners** (9% → 11%). G1/G2/G3 stay 3/2/1
for everyone.

## Worked example (verify the math by hand)

Say **Business X** did **1,000 LYMX issued + 500 LYMX redeemed** last month = **1,500 LYMX
volume**. It was signed by **Dave** (regular partner). Dave's sponsor is **Maria** (G1).

- Platform fee = 3% × 1,500 = **45 LYMX**
- Dave (direct, 9%): 9% × 45 = **4.05 LYMX**
- Maria (G1, 3%): 3% × 45 = **1.35 LYMX**
- Maria's sponsor (G2, 2%): 0.90 LYMX · their sponsor (G3, 1%): 0.45 LYMX

If Dave were a **founding** partner his direct cut would be 11% × 45 = **4.95 LYMX**.
Plus, the month Business X went live, Dave got a **$500 cash** activation bonus (one time).
If Business X is past its 3 free months and pays a $199 monthly fee, Dave also earns
9% × $199 = **$17.91 cash** that month (and the upline their 3/2/1%).

## How the engine produces these numbers

- **Rates live in `commission_rate_config`** (one current version). Change a rate there —
  no code change. This is the single source of truth.
- **`run_commission_period(start, end)`** (run monthly by an admin) computes streams 2 and
  3 for every business and writes rows into **`partner_commissions`** — one row per
  (partner, stream, generation, business, month), with `payout_kind` = `cash` or `lymx`.
- **`accrue_activation_bonus(business)`** writes the one-time bonus when a business goes
  live (and `backfill_activation_bonuses()` catches up existing ones).
- It's **safe to re-run** a month: it deletes only the **unsettled** rows for that month
  and recomputes. Rows that were already **settled (paid)** are locked and never touched.
- **Payout** is a separate step (`partner-settlement-run`): it bundles unsettled
  commissions into a settlement and pays cash via Stripe / credits LYMX. Calculate first,
  review, then settle.
- **`partner_income_summary(partner)`** returns a partner's real earned income (cash vs
  LYMX, paid vs unpaid, by stream, by generation) — this is what the dashboards and the
  income projector read.

## How to verify (do this before trusting real payouts)

1. **Run a closed month** as admin (SQL editor):
   `select public.run_commission_period('2026-05-01','2026-05-31');` — note the `rows` count.
2. **Pick one business** with known activity. Get its LYMX volume for the month:
   issued (`reason <> 'redemption'`) + redeemed (`reason = 'redemption'`, `admin_status in
   ('auto','approved')`) from `lymx_issuances`.
3. **Hand-calculate** the fee (3% × volume) and each generation's cut (9/11/3/2/1%).
4. **Compare** to `partner_commissions` rows for that business + month
   (`source_kind = 'transaction_fee'`, check `generation`, `amount`, `payout_kind = 'lymx'`).
   They should match your hand numbers to the cent.
5. **Check a partner's total**: `select public.partner_income_summary('<partner-uuid>');` —
   confirm cash vs LYMX totals look right and unpaid = what's not yet settled.
6. **Founding check**: pick a founding partner who signed a business; confirm their direct
   row used 11%, not 9%.
7. **Free-period check**: a business in its first 3 months should have **no** monthly-fee
   commission rows.

If any number is off, **do not settle** — flag it. The most likely culprits are the wrong
base (must be LYMX volume, not purchase $) or a wrong rate in `commission_rate_config`.

## Changing rates later

Edit `commission_rate_config` (insert a new version, set `is_current = true`). The next
`run_commission_period` uses the new rates automatically. Never hardcode a rate in a page.
