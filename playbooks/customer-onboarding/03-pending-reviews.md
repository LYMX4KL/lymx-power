---
slug: customer-onboarding-03-pending-reviews
title: See and write your pending reviews (earn 100 LYMX each)
project: LYMX Power
role: customer
last_verified: 2026-05-26
duration_min: 3
difficulty: easy
---

# See and write your pending reviews

When you visit a LYMX business, you earn LYMX automatically. After the visit you can also write a review — that's another **100 LYMX**, spendable across the whole LYMX network. The Pending Reviews card on your dashboard lists every place you've visited but haven't reviewed yet, so you don't have to remember where you've been.

This playbook walks you through finding the card, picking a visit, writing the review, and collecting the bonus.

## Before you start

- You're signed in to LYMX (email + password, magic link, or phone — any sign-in works).
- You've been to at least one LYMX business and earned LYMX there (any visit where you got LYMX counts).
- You haven't already reviewed that business — once reviewed, a business drops off the pending list.

If you've never visited a LYMX business, the card shows "No visits waiting to review yet" with a link to browse the network. Pop into any LYMX spot, earn LYMX on a purchase, and the visit appears in your pending list the next time you load the dashboard.

## Step 1 — Open your dashboard

**Where:** [getlymx.com/customer-dashboard.html](https://getlymx.com/customer-dashboard.html) — or click your avatar / "My account" from anywhere on the site.

**Do:** Scroll down to the **Pending reviews** card. It sits between Recent activity and your wallet sections.

**Expect:** If you have any pending reviews, the card shows a count badge ("3 visits waiting · earn up to 300 LYMX") plus a row per business with its emoji, name, when you visited, and how much LYMX you earned there. Each row has a "Write review" button on the right.

**If you see "No visits waiting to review yet":** You either don't have any visits with LYMX earnings yet, or you've already reviewed everything you've visited. Visit a LYMX business and come back — the next dashboard load will pick up the new visit. The page reads from a live view, no refresh-magic needed beyond a normal page load.

## Step 2 — Pick a visit to review

**Where:** The Pending reviews card.

**Do:** Find the business you want to review. The most-recent visit is at the top, but you can review them in any order. Each row tells you:

- The business name and emoji.
- When you visited (and how many times, if more than once).
- How much LYMX you've earned there so far.
- The bonus you'll get for reviewing (always 100 LYMX).

**Expect:** Each row has a "Write review" link that takes you to the business's profile page with the review form already open.

## Step 3 — Click "Write review"

**Where:** Any row in the Pending reviews card.

**Do:** Click the "Write review" link.

**Element:** The link reads `/biz-<businessname>.html#write-review` — the `#write-review` anchor scrolls the business page to its review form for you, so you land where you can start typing.

**Expect:** The business profile page opens with the review form visible. You'll see a star rating (1–5) and a comment box.

**If the link 404s:** The business slug might have a typo. Tell us via the Send Feedback button (top-right floating chip) and we'll fix the link — meanwhile you can still write the review from the business's profile page directly.

## Step 4 — Write the review

**Where:** Review form on the business's profile page.

**Do:**

1. Pick a star rating (1 = poor, 5 = excellent).
2. Type a short comment. Even one sentence is enough — testers and other customers find one-line "great cold brew, fast service" reviews just as useful as long ones.
3. Click Submit.

**Expect:** The review saves and the page shows a confirmation. The business's review count and average rating update on its profile.

**If submit fails:** Make sure you're signed in (the form blocks anonymous submissions). If you're signed in and it still fails, the Send Feedback button at the bottom-right of the page is the fastest way to flag it — we'll see it within the hour.

## Step 5 — Collect the 100 LYMX

**Where:** Back on `customer-dashboard.html`.

**Do:** Reload your dashboard.

**Expect:**

- The business you just reviewed has disappeared from the Pending reviews card.
- Your LYMX balance went up by **100 LYMX**.
- The Recent activity feed shows the new review-bonus issuance.

**If the 100 LYMX didn't appear:** The bonus issuance runs in a database trigger that fires when the review is inserted. If you submitted and don't see the credit within a minute, file a Send Feedback ticket with the business name and approximate time — we can re-check the issuance log and credit you manually if the trigger missed.

## Common errors

| What you see | What's happening | How to fix |
|---|---|---|
| Card shows "No visits waiting" but you know you've visited | The view only counts visits where LYMX was actually issued (auto- or approved-status rows) and where the business has a public slug. Demo-only and archived businesses don't show up. | If a business you really visited isn't appearing, send us a feedback ticket with the business name and approximate visit date. |
| "Write review" 404s | The business's slug doesn't match a profile page on the site (rare — usually only for retired listings). | Visit the business page directly via the Browse Businesses page in the sidebar, then write your review from there. |
| Pending count keeps showing the same number after a review | Browser cached the old dashboard HTML. | Hard refresh (Ctrl-Shift-R on Windows, Cmd-Shift-R on Mac). The view is queried fresh on each load, no other cache stands between you and current data. |
| Same business appears twice | Won't happen — the view groups by business, so multiple visits to the same place collapse into one row with "X visits · last <when>". | If you do see a duplicate, that's a bug — file a Send Feedback ticket. |

## Why we built this

Customers who write reviews stack up LYMX across the network — those reviews are also what new customers read when deciding where to spend. Both sides of the network grow when reviews flow, which is why every verified review is worth 100 LYMX, spendable at any LYMX business — not just the one you reviewed.

The "review only counts if you actually visited" rule is on purpose. We don't want a flood of drive-by reviews from people who never set foot in the business — that would burn trust on both sides. Showing you a list of places you HAVE been makes writing the review easy AND keeps the review pool honest.

## Reference / under the hood

This section is for technical readers. End users don't need to read it.

- **View:** `public.v_my_pending_reviews` (migration 103). Joins `lymx_issuances` ⨯ `businesses` ⨯ `reviews`, filters to `auth.uid()` issuances with positive amount and auto/approved status, excludes already-reviewed slugs.
- **Trigger:** the 100-LYMX bonus is granted by an INSERT trigger on `public.reviews` (migration 030, fixed in migration 032). Idempotent — multiple reviews for the same business by the same user don't double-credit.
- **Frontend:** `customer-dashboard.html` queries the view on DOMContentLoaded after sign-in. If the view returns zero rows, the existing empty state stays. If rows come back, the late-load JS replaces the empty state with real cards and updates the count pill.
- **Source-of-truth audit:** `LYMX Power/audits/BIZ-ONBOARDING-GAPS-2026-05-26.md` Phase 5 entry for `98fcfa23`.
