---
slug: business-onboarding-07-customer-redeems
title: How a customer sees, earns, and redeems LYMX
project: LYMX Power
role: customer
prereqs:
  - signed_up_as_customer
duration_min: 3
difficulty: easy
last_verified: 2026-05-26
related:
  - business-onboarding/README
  - business-onboarding/06-issuing-lymx
supersedes: null
---

# How a customer sees, earns, and redeems LYMX

This is the customer side of the loop that closes the biz-onboarding flow. Module 6 wired every customer-facing surface (dashboard, wallet, history, notifications, pay) to read from the canonical Module 5 pipeline — `v_my_lymx_balance` for balance and `customer_redemptions` for spend history. Pre-Module-6 those pages fell back to a `wallets` + `transactions` chain that was empty by design (Module 5 deprecated those tables), so dashboards showed 0 LYMX even when customers had real activity.

## What you'll need (as the customer)
- A LYMX account (signed up via `welcome.html?biz=<slug>` or `/login.html`)
- A LYMX business willing to issue + accept LYMX

## What success looks like
1. **Balance is correct.** Open `customer-dashboard.html`, `customer-wallet.html`, or `pay.html` — your spendable LYMX appears in seconds, sourced from `v_my_lymx_balance.available_lymx`.
2. **Activity is unified.** The dashboard's "Earned this month / Spent this month / Lifetime visits" stats render real numbers. The wallet's "Recent activity" feed shows BOTH earnings and redemptions in one timeline.
3. **History is complete.** `customer-history.html` lists every earn + spend chronologically; `customer_redemptions` view backs the spend rows directly.
4. **Notifications stay current.** The notifications panel surfaces the last 14 days of activity — earn + spend + referral payouts — in one merged list.

## Steps (from the customer's view)

### Step 1 — Sign up + receive a welcome bonus
**Where:** `welcome.html?biz=<biz-slug>` (linked from any approved business's marketing or the partner's referral link)
**Do:** Enter email + phone, set a password, confirm.
**Expect:** A `lymx_issuances` row with `reason='signup_bonus'`, amount per the platform default (currently 100 LYMX). `v_my_lymx_balance.available_lymx` jumps by 100 on next refresh.

### Step 2 — Spend at a real LYMX business
**Where:** Any approved business's storefront / POS
**Do:** Hand the cashier your LYMX QR (or share your phone/email).
**Expect:** The cashier scans → enters the bill amount → POS calls `/functions/v1/issuance` with `recipient_user_id` (yours) + `usd_amount`. A new `lymx_issuances` row lands with `reason='transaction'`. Your balance jumps.

### Step 3 — Redeem some LYMX
**Where:** Same business, later visit
**Do:** Tell the cashier you'd like to use LYMX. They enter the bill total + how much LYMX to apply (up to 80% of the bill).
**Expect:** POS calls `/functions/v1/redemption` with `recipient_user_id` + `usd_total` + optional `lymx_to_redeem`. A new `lymx_issuances` row lands with `reason='redemption'` and NEGATIVE `amount_lymx`. `v_my_lymx_balance.available_lymx` drops by that amount. The cashier sees `usd_remaining_to_charge` — what to charge you on the card/cash for the rest.

### Step 4 — See it all in the dashboard
**Where:** `customer-dashboard.html` (you're auto-redirected here after sign-in)
**Do:** Refresh once.
**Expect:**
- **Big balance card** — current `available_lymx`
- **"Earned this month / Spent this month / Lifetime visits"** stats — populated from `lymx_issuances` (positive sum) + `customer_redemptions` (count + sum).
- **Recent activity row** — last few rows from `fetchMyTransactions` (lymx-auth.js helper) showing earn + spend mixed.

### Step 5 — Drill into the wallet
**Where:** `customer-wallet.html`
**Expect:**
- Balance, earned-this-month, spent-this-month rows.
- A "Recent activity" section showing the last 5 events (earnings + redemptions) with timestamps + business names.

### Step 6 — Full history
**Where:** `customer-history.html`
**Expect:** Every earn + spend event chronologically, with business name + category. Filters by type / business available.

### Step 7 — Notifications
**Where:** `notifications.html`
**Expect:** Last 14 days of activity grouped by day, including:
- LYMX earned at each business
- LYMX redeemed (now visible — pre-Module-6 was silently empty)
- Referral payouts

## Engineer's view: the data flow

```
                ┌────────────────────────────────┐
                │       BUSINESS POS APP         │
                │  (or admin tool / EF caller)   │
                └────────────────┬───────────────┘
                                 │ POST issuance / redemption
                                 ▼
         ┌─────────────────────────────────────────────┐
         │  EF /functions/v1/issuance                  │
         │  EF /functions/v1/redemption                │
         │   Resolve customer → INSERT lymx_issuances  │
         │   (positive for issuance, negative for      │
         │    redemption + reason='redemption')        │
         └─────────────────────┬───────────────────────┘
                               │
                               ▼
              ┌─────────────────────────────────┐
              │   public.lymx_issuances          │  ← single source of truth
              │   51 historic + every new row    │
              └──┬─────────────────┬────────────┘
                 │                 │
       ┌─────────▼────┐   ┌────────▼─────────────────┐
       │ v_my_lymx_   │   │ customer_redemptions      │
       │ balance VIEW │   │ VIEW (WHERE reason='red') │
       │ (per-user    │   │ (positive lymx_amount     │
       │  rollup)     │   │  for UI convenience)      │
       └──────┬───────┘   └──────────┬───────────────┘
              │                      │
              ▼                      ▼
   customer-dashboard.html    customer-history.html
   customer-wallet.html       customer-wallet.html (spend)
   pay.html                   notifications.html
                              customer-dashboard.html (spend stats)
```

The deprecated `wallets` + `transactions` tables are still present in the schema for safety (FK survival of historical references) but have DEPRECATED comments, no readers, and no writers. They'll be hard-dropped in a follow-up cleanup migration once we're confident zero stragglers remain.

## Common edge cases

### "My balance is wrong after I just spent"
- The customer-wallet page reads `v_my_lymx_balance` on load. If the redemption JUST happened, refresh.
- The view does `SUM(amount_lymx) WHERE admin_status IN ('auto', 'approved')`. If the redemption is pending admin review (`admin_status='pending_review'`), it doesn't subtract from `available_lymx` yet — `pending_lymx` shows the delta.

### "Recent activity is missing my redemption"
- The dashboard's compact activity reads from `fetchMyTransactions` (lymx-auth.js) which now queries `lymx_issuances` directly. If the redemption row is more than 20 events back in your history, it falls off the limit — open `customer-history.html` for the full list.

### "Spent this month shows 0 but I redeemed yesterday"
- The view filters by `created_at >= startOfCurrentMonth`. If "yesterday" was last month, the rollup correctly resets to 0.
- If "yesterday" was this month, refresh and check `customer-history.html` — if the row is there, the dashboard query is stale (file a bug).

### "I see negative balance"
- Should never happen: the redemption EF refuses to redeem more than your current balance (`Insufficient balance: requested N but balance is M`). If you see negative, file a bug — it would indicate an EF bypass.

## What's NOT in this playbook (future modules)
- **Customer-facing "Spend at biz" flow** with QR generation — current path is cashier-driven (biz POS calls the redemption EF). Customer-self-initiated spend with a QR scan is a polish/Module-7 item.
- **Saved-businesses redemption history** — drill into a single biz to see your history there. Module 6 surfaces the per-biz roll-up via `fetchMyWallets` but the dedicated page is Module 7+.
- **Admin/biz-side activity views** — `biz-analytics.html`, `admin-customers.html`, `pos.html` still read from the deprecated `transactions` table. Those will migrate in a follow-up admin/biz module.
