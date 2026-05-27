---
slug: business-operations-edit-my-storefront
title: Edit your LYMX storefront (the page customers see at /biz?slug=your-slug)
project: LYMX Power
role: business
prereqs:
  - business_signed_up
  - business_approved
duration_min: 15
difficulty: easy
last_verified: 2026-05-27
related:
  - business-operations/upload-photos
  - business-operations/manage-offers
  - business-operations/manage-menu
  - business-onboarding/05-booking-the-call
supersedes: null
---

# Edit your LYMX storefront

Your business has a public page at `https://getlymx.com/biz?slug=your-business-slug`. Every word, photo, offer, and menu item on that page comes from data YOU manage at `https://getlymx.com/biz-profile.html`. Nothing on your public page is hand-coded by the LYMX team — when you save here, your customers see it on the next page load.

This playbook is the overview. The three deep-dives (Photos, Offers, Menu) each have their own playbook.

## What lives on your storefront

| Section | Where you edit it | Updates instantly |
|---|---|---|
| Display name, tagline, description, emoji, category | Profile info tab | ✅ |
| Address, contact phone, website | Profile info tab | ✅ |
| Operating hours | Hours tab | ✅ |
| **Photos** (hero image grid) | **Photos tab** | ✅ |
| **LYMX offers** (Happy Hour, Welcome Bonus, etc.) | **Offers tab** | ✅ |
| **Menu items grouped by section** | **Menu tab** | ✅ |
| Reviews | (Customers write them; you can't edit) | n/a |

## The 5-minute checklist

When your business is approved, do these five things in order. Each is fast:

1. **Profile info** — Set tagline + description + emoji + address. Save.
2. **Hours** — Mark each day open or closed. Save.
3. **Photos** — Upload at least 1 photo (5 is the sweet spot — fills the hero grid). See `upload-photos`.
4. **Offers** — Add 2-3 offer cards (e.g. "Happy hour 2x LYMX 4-6 PM"). See `manage-offers`.
5. **Menu** — Add your top 8-12 items grouped by section. See `manage-menu`.

After all five, refresh `https://getlymx.com/biz?slug=your-slug` in a new tab to see exactly what your customers see.

## Common questions

**Q. Why is my storefront not showing up?**
A. Your business must have `approval_status='approved'` on it. If you can sign in to biz-profile but the public storefront returns 404, your application is still pending — Helen on the LYMX team approves applications and you'll get an email when she does. If you need to chase it, book a 15-min call with Rachel (link in your welcome email) or email hello@getlymx.com.

**Q. Can I have multiple slugs / multiple URLs to the same business?**
A. No. Each business has exactly one slug, auto-generated from your display name (e.g. "Oakline Kitchen" → `oakline-kitchen`). If you rename your business, the slug stays the same unless you ask the LYMX team to change it (we lock it because external links + Google indexing depend on it).

**Q. Do I need to publish each change?**
A. No. Every Save button on biz-profile writes immediately and your storefront updates on the next page load. Customers do not see a draft / preview state.

**Q. How do photos look on mobile?**
A. The hero grid collapses from a 3-column layout to 2 columns on screens narrower than 780px. The 4th and 5th photos hide on phones. Upload your best 3 photos first.

**Q. Can I hide an offer or menu item temporarily without deleting it?**
A. **Menu items**: yes — uncheck the "live" checkbox on the item row in the Menu tab (the item stays in your editor but disappears from the public storefront). **Offers**: not yet — for now delete the offer and re-add it later. (Filed as a Phase 3 polish.)

## What's NOT editable here (yet)

- Real photo uploads to a real photo CDN (we use Supabase Storage and the photos are served from `business-photos` bucket — works fine for tens of photos per biz)
- Per-day-of-week offers (Happy Hour shows the same way Mon-Fri; if you have different specials per day, list them in one offer body)
- Multi-location: each location is its own business signup with its own slug for now

## Booking the 1-on-1 with Rachel

Rachel (LYMX partner concierge) runs a 20-min onboarding call where she walks you through this storefront flow live. The booking link is in your welcome email. If you've lost the email, ask in the in-app chat from your biz-dashboard or email hello@getlymx.com.

## Last thing

When your storefront looks great, share it. Every customer who lands at your `/biz?slug=...` URL and is signed into LYMX earns rewards on transactions with you. The Share button on your storefront copies the URL and triggers a native share sheet on mobile.
