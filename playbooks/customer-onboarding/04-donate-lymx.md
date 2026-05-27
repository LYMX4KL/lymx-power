---
slug: customer-onboarding-04-donate-lymx
title: Donate LYMX to a nonprofit
project: LYMX Power
role: customer
prereqs:
  - signed_up_as_customer
  - non_zero_lymx_balance
duration_min: 2
difficulty: easy
last_verified: 2026-05-27
related:
  - customer-onboarding/03-pending-reviews
  - business-onboarding/07-customer-redeems
supersedes: null
---

# Donate LYMX to a nonprofit

You can give LYMX directly from your wallet to a verified nonprofit. They receive the USD equivalent in the next monthly payout. There's no separate signup, no extra fees — your existing LYMX balance is the donation.

## What you'll need
- A LYMX account with a positive wallet balance
- A nonprofit you want to support (pick from the verified list)

## What success looks like
You leave the page with a green receipt confirming how many LYMX you donated, which nonprofit received them, and the USD that nonprofit will receive in the next monthly payout. Your wallet balance drops by exactly that LYMX amount; the donation shows up in "Your recent donations" on the same page.

## Step-by-step

1. **Open the page.** Sidebar → Customer → Wallet → Donate LYMX, or go directly to `/customer-charity.html`.
2. **See your available balance** at the top of the page — that's the maximum you can donate.
3. **Pick a nonprofit.** The verified list shows each nonprofit's name and a one-line mission. Tap one to select it (it highlights in blue).
4. **Choose an amount.** Type a LYMX number, or tap a preset (50 / 100 / 500 / Max). The "Nonprofit receives" line shows what the USD payout will be at the current $0.008-per-LYMX rate.
5. **Click "Donate X LYMX to {nonprofit}".** The button only enables once both a nonprofit is selected and the amount is valid.
6. **See the receipt.** A green confirmation shows: LYMX donated, nonprofit name, USD amount the nonprofit will receive, and a short receipt token you can keep for your records.
7. **Verify your balance updated.** The "Available to donate" number drops by exactly the amount you donated. Your recent donations card appears below with the new gift on top.

## What you might run into

**"Insufficient balance"** — your wallet has less LYMX than what you tried to donate. The button auto-caps with "You only have X LYMX" before the donation is even attempted; if you bypassed that and still hit this error, refresh — your balance may have updated while you were on the page.

**"Nonprofit not accepting donations"** — the nonprofit's status changed from `verified` to `pending` or `disabled` after you loaded the page. Refresh and pick a different one.

**The nonprofit list is empty.** No verified nonprofits in the registry yet. Admin is onboarding the first batch; check back later. (The page won't show partially-verified or pending entries — only ones LYMX has confirmed.)

**The button stays disabled.** Either no nonprofit is selected, or the amount is zero / greater than your balance. The button label tells you which.

**"Donation failed (HTTP 5xx)"** — backend issue. Refresh the page and try again; if it persists, use the Feedback chip in the corner to report it. Your LYMX has not been spent if the donation row didn't get created.

## How the rate works

- You see your balance in **LYMX face value** ($0.01 per LYMX). 1,000 LYMX in your wallet = $10 of face value.
- When you donate, the nonprofit receives at the **clearing-house rate** ($0.008 per LYMX). Donating 1,000 LYMX = $8.00 to the nonprofit.
- The 20% gap is the same rate that funds every LYMX redemption across the network — it pays for the platform operations that make donations possible.
- Admin can adjust this rate in `app_config.donation_payout_cents_per_lymx` if economics shift.

## When the nonprofit actually gets paid

Donations sit in `status = pending` until LYMX Power's Stripe Connect platform is approved (currently in review with Stripe). Once approved, a monthly batch transfers the accumulated USD to each nonprofit's Stripe Connect account. The donation row is permanent from the moment you click — only the payout is queued.

Your receipt token is shareable and stable; you can give it to the nonprofit if they want to confirm the gift in their inbound queue.

## Glossary

- **Verified nonprofit** — vetted by LYMX admins, registered in `public.nonprofits` with `status = verified`. Only these accept donations.
- **Receipt token** — 16-character hex string unique to your donation. Lives on `public.donations.receipt_token`.
- **Clearing-house rate** — $0.008 per LYMX, the same rate LYMX Power uses to settle business buy-backs. Stored in `app_config.donation_payout_cents_per_lymx`.
- **Face value** — $0.01 per LYMX, what your wallet displays. The customer-facing valuation of LYMX in the network.
