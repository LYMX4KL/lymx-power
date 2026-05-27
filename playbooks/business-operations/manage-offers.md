---
slug: business-operations-manage-offers
title: Manage LYMX offers on your storefront (Happy Hour, Welcome bonus, etc.)
project: LYMX Power
role: business
prereqs:
  - business_signed_up
  - business_approved
duration_min: 5
difficulty: easy
last_verified: 2026-05-27
related:
  - business-operations/edit-my-storefront
supersedes: null
---

# Manage offers

The "Current LYMX offers" section on your public storefront is driven by an `offers` array you edit on the Offers tab of biz-profile.html. Each offer is a small card with a category **badge**, a **title**, and a one-sentence **body**.

## What an offer is (and isn't)

| ✅ Good offer | ❌ Not an offer |
|---|---|
| "2× LYMX 4-6 PM weekdays" | "We sell coffee" |
| "Free dessert at 600 LYMX" | "Open Saturdays" (that goes in Hours) |
| "+250 LYMX welcome bonus on your first visit" | "Best in town" |
| "Spend 1500 LYMX → free entrée before 9 PM" | "We have free WiFi" |

Offers should describe a **specific value exchange involving LYMX**. They're the reason a customer chooses your storefront over the one next door. Vague marketing copy doesn't earn the slot.

## How to add one

1. Go to `https://getlymx.com/biz-profile.html` → **Offers** tab.
2. Click **+ Add offer**.
3. Fill in three fields:
   - **Badge** (short category label): `Happy hour`, `Redeem perk`, `First visit`, `Loyalty bonus`, etc. Keep it under 20 characters.
   - **Title** (the offer headline): `2× LYMX 4-6 PM weekdays`. Keep it under ~50 characters so it doesn't wrap on mobile.
   - **Body** (one sentence explaining the offer): `Earn 10 LYMX per $1 on bar tabs and small plates during happy hour.` Keep it under ~200 characters.
4. Click **Save offers** at the bottom of the list.

Repeat for up to 6 offers. Each save publishes everything at once.

## Editing or removing an offer

- **Edit**: change any field on a card, click **Save offers**. Saves all changes for all offers in one shot.
- **Reorder**: use the **^** and **v** buttons on each offer card to move it up or down. The order on your storefront matches the order in the editor.
- **Remove**: click the **x** button on the offer card. Then click **Save offers** to commit the removal.

## What customers see

A 3-column grid (1 column on phones) with each offer as a white card: badge label at the top in blue, then the title in bold, then the body sentence in muted gray. Same look as the cards in the screenshots Helen and Dave use in their demo decks.

## Trust & Safety rules

- **Do not offer LYMX in exchange for a positive review.** LYMX customers already get a separate review bonus from the platform — offering biz-funded LYMX as "review payment" is a Trust & Safety violation. Customers leave reviews because they want to; LYMX rewards them for that signal.
- **Honor the offer when redeemed.** If you advertise "2× LYMX during happy hour" and a customer arrives at 4:30 PM, the 2× rate must apply. The platform doesn't enforce this technically (issuance happens at your POS terminal), but customers who feel duped will report it via the feedback widget and we will follow up.
- **Don't impersonate the LYMX brand.** Use your own voice on offer copy, not "LYMX recommends..." or similar.

## Limits

- Max **6 offers** per storefront (we cap to keep the section scannable).
- Offers do not yet support per-day-of-week scheduling. If your Happy Hour is Mon-Fri only, list that in the body text.
- Offers cannot be scheduled to publish later. They're live the moment you save.

## When it breaks

If a customer claims your offer didn't apply at the register, the issue is almost always one of:
1. Your POS terminal wasn't running the right LYMX issuance rate when they transacted.
2. The customer redeemed at the wrong time window (e.g. happy hour over).
3. The offer text was ambiguous.

Pull the transaction from your biz-dashboard → Transactions, look at the timestamp + amount + LYMX issued. If the math is wrong, mark the transaction "adjusted" and issue the difference.
