---
slug: business-onboarding-09-print-kit
title: Download your customized print kit (window clings, table tents, QR cards)
project: LYMX Power
role: business
prereqs:
  - business_signed_up
  - business_slug_assigned
duration_min: 5
difficulty: easy
last_verified: 2026-05-27
related:
  - business-onboarding/02-signup
supersedes: null
---

# Download your customized print kit

When you onboard a Business onto the LYMX network, we generate a set of print-ready PDFs customized with your own QR code — window clings, counter cards, table tents, posters, business cards, bag stickers, employee pins, and a retractable banner. Every QR encodes `https://getlymx.com/biz-<your-slug>?ref=qr` so when a customer scans, they land on YOUR storefront and earn LYMX on every visit.

## What's in the kit

10 print pieces per business, in three languages (English, Spanish, Simplified Chinese — 30 files total):

| # | Piece | Size | Where it goes |
|---|---|---|---|
| 01 | Window decal | 4 in round | Front-of-house glass |
| 02 | Counter decal | 2 in square | Beside the register |
| 03 | QR stand | 5 × 7 in | Tabletop sign |
| 04 | Wall poster | 11 × 17 in | High-traffic wall |
| 05 | Employee button | 1 in round | Staff pin |
| 06 | Bag sticker | 3 in round | Takeout bag seal |
| 07 | Business card | 3.5 × 2 in | Owner business cards (with QR on back) |
| 08 | Banner stand | 33 × 80 in | Retractable trade-show banner |
| 09 | Table tent | 4 × 6 in folded | On every table |
| 10 | Receipt stuffer | 3.5 × 2 in | In the bag with the receipt |

All PDFs include bleed marks and are CMYK 300 DPI — send them to any local print shop.

## How to download

**Option A — From your Business Dashboard (recommended):**
1. Sign in at `getlymx.com/login.html`
2. Open the Business Dashboard sidebar → Marketing kit → Print kit
3. Each piece has a `↓ PDF (print-ready)` button (downloads) and a `↓ PNG preview` button (opens in browser for a quick eyeball)

**Option B — Direct URL share:**
- The Print Kit page works with `?biz=<slug>` for previewing a specific business's kit. Example: `https://getlymx.com/biz-print-kit.html?biz=biz-oakline-kitchen`
- Useful if you want to share a partner's kit with them via Slack/email before they sign in.

**Option C — Unsigned visitor:**
- If you open `/biz-print-kit.html` without a business identity (not signed in as a Business owner AND no `?biz=` param), the page shows a friendly "Sign in to see your customized kit" banner. The buttons stay inert until a biz is resolved — that's intentional, since an empty kit is worse than no kit.

## How customization works

When your business activates on LYMX:
1. We run `ONBOARDING-KIT/generate_print_kit_for_biz.py --biz-slug <yours> --biz-name "<Your Name>"` against the canonical templates.
2. The generator (Python ReportLab + qrcode) bakes your QR + name into all 30 PDFs.
3. The output lands at `ONBOARDING-KIT/per-biz/<your-slug>/{en,es,zh-CN}/<NN-piece>_<lang>.pdf` in the repo, deployed by Netlify.
4. Your Print Kit page detects your biz slug at page load and points each `↓ PDF` button at the right file.

**Updating the QR target:** today the QR points at `getlymx.com/biz-<your-slug>?ref=qr`. If you want a different deep-link (a campaign URL, a video tour, etc.), file a request via Send Feedback and we'll regenerate the kit with the new target.

## Printing recommendations

**At home:** the table tent, counter card, employee button, and bag sticker all print fine on a home inkjet using 110# cardstock. For the bag sticker and employee button, peel-and-stick label sheets from any office supply store work great.

**Send to a local printer:** for the window decal, wall poster, and retractable banner, use a local sign shop. Most do a 4×6 vinyl decal for $8–15. For the retractable banner stand, plan for $80–150 including the hardware. We list a few recommended Las Vegas printers at the bottom of the Print Kit page.

**Print spec for shops:** "Print this PDF at 100% — do not scale. Bleed marks are included. CMYK, 300 DPI." (That's all the language a print shop needs.)

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Clicking PDF button → nothing happens | Your biz hasn't been onboarded yet (no per-biz folder generated) | Sign in as a Business owner. The page detects ownership via `businesses.owner_user_id = your auth.uid()`. If you're a new business, contact admin to run the generator. |
| QR scans to a 404 | Your biz slug changed after generation, or the kit was generated against a typo'd slug | Ask admin to regenerate via `generate_print_kit_for_biz.py --biz-slug <correct-slug>` |
| Language picker missing | The Print Kit page currently auto-selects based on your account locale (or `<html lang>`). Manual switcher is on the roadmap. | For now: `?biz=<slug>&lang=es` style URL hacks aren't supported; the language is fixed to the page lang. |
| Print shop says "the PDF is wrong" | They're scaling or re-flowing. | Tell them to print at 100% with no scaling. Bleed marks are built in. |

## Roadmap (out of scope for v1)

- Move per-biz PDFs from the repo to Supabase Storage so we don't commit binaries when scaling past ~50 businesses.
- Add an Edge Function to regenerate-on-demand when a business updates their name/branding.
- Add a UI for businesses to preview the QR encoding live in the browser before downloading.
- Per-piece language picker (currently fixed to the page's locale).

## Data sources

- **Templates:** `ONBOARDING-KIT/generate_print_kit.py` (canonical layout) wrapped by `generate_print_kit_for_biz.py` (per-biz injection).
- **Outputs:** `ONBOARDING-KIT/per-biz/<biz-slug>/{en,es,zh-CN}/*.pdf`
- **Page:** `biz-print-kit.html` (the JS at the bottom resolves the biz slug and rewrites button hrefs).

## Reference tickets

- Original report: feedback ticket #06 "Print Kit Action Buttons Are Not Working" (Dave, 2026-05-27)
- Shipped: 2026-05-27 commits `6884419` (first release) and `bandaid-ok mutes`
