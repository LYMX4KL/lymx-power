---
slug: business-operations-upload-photos
title: Upload photos to your storefront (replaces the emoji placeholder)
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

# Upload photos

Until you upload a real photo, your storefront's hero shows a single emoji on a peach gradient. The moment you upload one photo, the hero upgrades to a real image. Upload 5 and you get the full grid layout (one big photo on the left, four smaller photos on the right).

## How

1. Sign in to LYMX, go to `https://getlymx.com/biz-profile.html`.
2. Click the **Photos** tab.
3. Click **Pick a photo** → choose a JPG, PNG, or WebP. Max 10 MB.
4. Add alt text (optional but recommended for accessibility + search). Example: "Bartender pouring a Yuzu spritz at the bar at Oakline Kitchen".
5. Click **Upload photo**.
6. The photo appears in the **Current photos** grid below, tagged MAIN if it's your first upload.

Repeat for up to 5 photos. After 5, the hero grid is full; additional photos still upload and are stored, they just don't show in the hero (yet — a "more photos" gallery is on the roadmap).

## Order matters

The first photo (tagged MAIN) is the big left-hand image on the hero grid. The next four fill the right column. To change the order: delete a photo and re-upload it in the position you want. (Drag-to-reorder is on the roadmap.)

## Photo guidelines

- **Landscape** (wider than tall) works best. The hero is a 380px tall band on desktop.
- **High resolution** is fine — Supabase Storage resizes lazily and the public URL is cached.
- **Avoid text-heavy graphics** (menus, posters) for the MAIN photo. Text gets tiny on mobile. Save those for the Menu tab as actual line items.
- **One MAIN, then variety**: hero should be your most recognizable shot. Side photos can show interior, a signature dish, the team, etc.

## What happens when you delete a photo

Clicking the **X** button on a photo row:
1. Removes the row from `public.business_photos`
2. Removes the file from the `business-photos` storage bucket
3. Refreshes the grid

This is permanent. If you delete by mistake, just re-upload — your original is gone but you can replace.

## What customers see

Your storefront at `/biz?slug=your-slug`:

- **0 photos uploaded** → single emoji on peach gradient (your category emoji, set in Profile info)
- **1 photo** → single full-width hero image
- **2-5 photos** → grid: one big photo on the left, the rest tiled on the right
- **6+ photos** → first 5 show in the grid; the rest are stored for future "view all photos" lightbox

## Permissions

Only the business owner (the user_id linked to your business) can upload, edit, or delete photos for your business. LYMX admin staff can edit any business's photos. Nobody else can touch them.

## When it breaks

If upload fails with a permission error, you're likely signed in as a different account than your business owner. Sign out, sign back in with the email that received the LYMX welcome email. Still stuck? Ask Rachel on the onboarding call or email hello@getlymx.com.
