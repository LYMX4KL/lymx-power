---
slug: customer-onboarding-05-browse-all
title: Find any business on the LYMX network
project: LYMX Power
role: customer
prereqs:
  - signed_up_as_customer
duration_min: 1
difficulty: easy
last_verified: 2026-05-27
related:
  - business-onboarding/07-customer-redeems
supersedes: null
---

# Find any business on the LYMX network

`browse.html` shows a curated set of featured + nearby businesses. **`browse-all.html`** is the full directory: every business on the network, searchable, filterable by kind, paginated.

## When to use it

- You know a business name but it's not in the featured set.
- You want to scan a category (Restaurant, Cafe, Salon, etc.) end-to-end.
- You're looking for the newest businesses on the network.

## How it works

1. **Open it.** Sidebar → Customer → Wallet → All businesses, or `/browse-all.html` directly. Featured `browse.html` has a Featured-back-arrow at the top so you can hop between the curated set and the full directory.
2. **Search.** Type any part of a business name, legal name, or category. The grid filters live (300ms debounce).
3. **Filter by kind.** The chips at the top are auto-populated from the directory — counts show how many of each kind are on the network. Tap a chip to narrow.
4. **Page through.** Each page shows 24 businesses. Previous / Next buttons jump pages; the label shows total count.
5. **Tap a card** to open the business page (`/biz-<slug>.html`) and start earning + redeeming.

## What you might run into

**A business I expect to see isn't here.** Only businesses with `approval_status = approved` and `demo_only = false` appear. If a business is in onboarding, they're not yet listed. New approvals appear within a minute.

**The verified badge is missing on some cards.** Verified businesses (KYC + Stripe Connect complete) get a green "verified" pill. Non-verified means they're approved but haven't finished Stripe onboarding.

**Filter chips show 0 counts after I search.** Search applies to the visible page; the chip counts reflect the full directory. Clear the search to see chip-filtered results.

## Glossary

- **`v_businesses_directory`** — the SECURITY DEFINER view (migration 081) that backs this page. Exposes only safe columns: id, display_name, legal_name, slug, business_kind, verified_at, created_at. Anon + authenticated can SELECT.
- **Range + Prefer: count=exact** — Postgres-style pagination via PostgREST. The page sends Range and the server returns Content-Range with total count.
