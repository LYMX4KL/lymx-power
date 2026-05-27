---
slug: business-operations-manage-menu
title: Manage your menu items (Menu highlights section on your storefront)
project: LYMX Power
role: business
prereqs:
  - business_signed_up
  - business_approved
duration_min: 10
difficulty: easy
last_verified: 2026-05-27
related:
  - business-operations/edit-my-storefront
supersedes: null
---

# Manage menu items

The "Menu highlights" section on your storefront pulls from a list of items you maintain on the Menu tab of biz-profile.html. Items group by **section** (free-form: "Small plates", "Mains", "Cocktails", "Brunch", etc.) and render in a 2-column grid (1 column on phones).

## Schema of one item

Each menu item is:

| Field | Required | Example |
|---|---|---|
| Section | yes | `Mains` |
| Name | yes | `Hand-pulled beef noodle` |
| Description | optional | `5-hour broth, daikon, bok choy, chili oil` |
| Price ($) | optional | `22.00` (leave blank for "market price" / no price shown) |
| Live | yes (defaults true) | unchecked = hidden from storefront, still in your editor |

## How to add an item

1. Go to `https://getlymx.com/biz-profile.html` → **Menu** tab.
2. At the top of the panel, fill the add-item form:
   - **Section**: pick from the dropdown (autocompletes from sections you've used before) or type a new one.
   - **Item name**: the dish or drink name.
   - **Price**: dollar amount with cents. Leave blank if you don't want to show a price.
   - **Description**: short, evocative sentence. Skip flowery adjectives — just what's in it.
3. Click **+ Add item**.
4. The item appears below in the current-menu grid, grouped under its section.

Repeat for as many items as you want. There is no cap.

## Editing an item

Each row has inline-editable fields. Change any field, click the row's **Save** button.

## Hiding an item (without deleting)

Uncheck the **live** checkbox on the item's row, click **Save**. The item stays in your editor (greyed-out conceptually) but disappears from the public storefront. Use this for:

- Seasonal items that come back later (don't lose the description you wrote)
- Sold-out items for the day (re-enable tomorrow)
- Items you're testing internally before publishing

## Deleting an item

Click the **x** button on the row → confirm. The row is soft-deleted (we keep an audit trail in the DB) and disappears from your editor + storefront. Recovery is possible by emailing hello@getlymx.com if you delete by accident; same-day recovery is easy, after a week the row gets purged.

## Order within a section

Within a single section, items show in the order you added them. To reorder, change the **section** field on a row (e.g. move from "Mains" to "Featured mains"), or delete + re-add in the order you want. Drag-to-reorder is on the roadmap.

## How customers see it

A "Menu highlights" section near the bottom of your storefront, just above Reviews. Each section header is a small uppercase label ("MAINS", "COCKTAILS"), then a 2-column grid of items. Each item shows the name in bold, description in gray, price right-aligned in bold. Items without a price show no price column. No-description items still render with name + price.

## What this is NOT

- **Not a full menu/ordering system.** This is a "highlights" preview to help customers decide whether to walk in. If you need full online ordering, integrate Toast/Square/Clover (see the integration cards on biz-profile).
- **Not a real-time availability feed.** Toggling `live` off is best-effort; do it at the start of service for sold-out items, not transactional.
- **Not a place to put offers.** "Free dessert at 600 LYMX" is an Offer, not a menu item. The Offers tab is the right home.

## When it breaks

If you save an item and it doesn't appear on your storefront:
- Check the **live** checkbox is checked.
- Refresh the public storefront (sometimes Netlify CDN serves a stale version for up to 60s).
- Confirm your business has `approval_status='approved'`. Pending businesses don't render publicly.
- Sign out + sign back in to confirm your session hasn't expired. RLS gates writes by your owner_user_id.

If still broken, screenshot the editor + the storefront and use the feedback widget — Kenny gets pinged on every ticket and replies within a day.
