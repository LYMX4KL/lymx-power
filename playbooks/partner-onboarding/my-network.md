---
slug: partner-my-network
title: See your recruited customers + the reviews on your recruited businesses
project: LYMX Power
role: partner
prereqs:
  - active_partner_account
duration_min: 2
difficulty: easy
last_verified: 2026-05-27
related:
  - partner-notifications
  - comp-plan-partner-walkthrough
supersedes: null
---

# See your recruited network

Sprint 6 ships two partner-facing surfaces over data that already lived in the database. No new tables, no new RPCs — just views of what's yours.

## Recruited Customers (`/partner-my-customers.html`)

Every customer who joined LYMX through your referral link.

**What you see:** name (or anonymized id if no display_name yet), status (`pending` / `credited` / `blocked` / `reversed`), the LYMX bonus you earned per row, the invite template (partner / customer / business) + method (link / email / contact_book), and the date they signed up.

**Summary cards:** total recruited, credited count, pending count, total LYMX earned (sum of `inviter_bonus_amount` across credited rows).

**Data source:** `public.referrals` filtered by `inviter_user_id = auth.uid()`. Status flips from `pending` → `credited` when the invitee completes their first qualifying action (which also fires your notification in `/notifications.html`).

## Recruited Reviews (`/partner-my-reviews.html`)

Every review left on a business that signed up through your partner link.

**What you see:** each recruited business as a section, with the stars + review body + photo flag + date for every review beneath it. Verified businesses get a shield emoji.

**Summary cards:** recruited businesses count, total reviews count, average rating across all reviews.

**Data source:** `public.businesses` filtered by `signed_up_by_partner_id = my partner.id` → JOIN `public.reviews` on `business_slug`. Reviews are public-read so the query is straightforward.

## Where to find them

Sidebar → Partner section:

- **Recruited Reviews** (📝) — right after My Reviews
- **Recruited Customers** (👪) — right after Recruited Reviews

Both pages start at the partner detection layer, so they only appear when your sidebar mode is partner. Multi-role users on customer-mode pages won't see them in the menu but can still hit the URL directly.

## What you might run into

**"You don't have a partner account."** Your `auth.uid()` doesn't have a row in `public.partners`. Sign up at `/partner-signup.html` (or `/partner-upgrade.html` if you already have a customer account).

**"No businesses recruited yet."** Send your partner referral link to a business that signs up + gets approved. The link template is in `/refer.html` (Refer a Friend) and the email template in `/admin-invite-friends.html` (Invite Friends).

**A business is in the list but has 0 reviews.** Customers haven't reviewed them yet. Reviews land here when a customer hits `/customer-charity.html`... no wait — when a customer fills out the review form (`Write a Review` button on a business page) the row lands in `public.reviews` and your dashboard updates on next reload.

**A customer shows but their name is anonymized like "customer …abc12345".** They haven't filled out their `customers.display_name` yet (still on the auto-generated default). When they do, your view picks it up automatically.

**The LYMX earned total looks low.** Only credited rows count toward the sum. Pending and blocked rows aren't included until they flip to credited. Watch your notification feed for the flip event.

## Glossary

- **`public.referrals`** — table of every invitee→inviter link. Mig 017. RLS allows the inviter to read their own.
- **`public.reviews`** — table of every customer review. Public-read (RLS allows anon SELECT) so any partner can JOIN.
- **`businesses.signed_up_by_partner_id`** — the FK that links a business to the Direct partner who recruited them. Mig 001 + 146.
- **`inviter_bonus_amount`** — LYMX awarded to the inviter per referral. Default 100. Stored on the referrals row, not on lymx_issuances.
