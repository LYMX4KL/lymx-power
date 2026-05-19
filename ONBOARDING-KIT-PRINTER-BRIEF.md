# LYMX Storefront Onboarding Kit — Printer Brief

**Client:** LYMX Power · getlymx.com
**Contact:** Kenny Zhong · zhongkennylin@gmail.com
**Kit version:** v1.0 · Generated 2026-05-19

## What's in the box

10 pieces × 3 languages (EN / ES / zh-CN) = **30 print-ready PDFs**.

All files include 0.125" bleed and 0.25" safe zone. Built in RGB
(printer to convert to CMYK at proof stage — brand colors are
`#0e1116` black, `#d4af37` gold, `#ffffff` white).

| # | Piece | Final size | Bleed size (in PDF) | Suggested material | Qty per kit |
|---|---|---|---|---|---|
| 01 | Window decal (round) | 4" diameter | 4.25" × 4.25" square | Static-cling vinyl, full-color exterior-grade | 2 |
| 02 | Counter decal (square) | 2" × 2" | 2.25" × 2.25" | Adhesive vinyl, gloss laminate | 4 |
| 03 | QR table-top stand | 5" × 7" | 5.25" × 7.25" | 100lb gloss cardstock, slot in clear acrylic | 3 |
| 04 | Wall poster | 11" × 17" | 11.25" × 17.25" | 100lb matte paper or laminated | 1 |
| 05 | Employee button | 1" diameter | 1.25" × 1.25" square | 1" round metal button (mylar laminate) | 5 |
| 06 | Takeout-bag sticker | 3" diameter | 3.25" × 3.25" square | Gloss adhesive label roll | 100 |
| 07 | Owner business card | 3.5" × 2" (2-sided) | 3.75" × 2.25" | 16pt soft-touch cardstock | 250 |
| 08 | Retractable banner | 33" × 80" | 33.25" × 80.25" | 13oz scrim vinyl, w/ retractable stand | 1 |
| 09 | Table tent | 4" × 6" | 4.25" × 6.25" | 100lb cardstock, scored for folding | 6 |
| 10 | Receipt-stuffer card | 3.5" × 2" | 3.75" × 2.25" | 14pt uncoated cardstock | 250 |

## Languages

Three separate, drop-in-replacement runs:

- `en/` — English (default storefront)
- `es/` — Español (Spanish — recommended for any Vegas storefront with Hispanic-leaning clientele)
- `zh-CN/` — 简体中文 (Simplified Chinese — for Vegas tourist-corridor businesses)

Each business chooses whichever language(s) match their customer mix.
Multilingual businesses can order multiple kits.

## Brand specs

- **Primary black:** `#0e1116` — CMYK approx (75, 68, 65, 90) / Pantone Black 6 C
- **Brand gold:**   `#d4af37` — CMYK approx (15, 30, 90, 5) / Pantone 124 C
- **Mark:** Four equal black squares in a 2×2 grid with small gap. Mark must
  always appear as a unit, never split. Minimum size: 0.18" wide.
- **Wordmark:** "LYMX" in Helvetica Bold (or close geometric sans). Always
  in solid color (black or white or gold) — never gradient.
- **Typography:** Helvetica family for EN/ES. Embedded "Droid Sans Fallback"
  for zh-CN (already embedded in the PDFs — no font swap needed).
- **Color profile:** Files exported in sRGB. Please convert to your house
  CMYK profile (e.g. GRACoL 2013) at preflight.

## QR code

Every piece carries a QR code pointing to:

```
https://getlymx.com/pay.html?biz=YOUR-BUSINESS
```

The `YOUR-BUSINESS` placeholder is the per-business slug. For per-business
runs, see the **QR regeneration** section below.

**Quiet zone:** QR codes have a 2-module border. Do not encroach.
**Contrast:** Always pure black on pure white background (never tint).
**Min size:** Smallest QR in the kit is 0.75" (on the bag sticker) — still
scans cleanly from 6" away. Do not scale below 0.6".

## Per-business QR regeneration

The template files use the placeholder slug `YOUR-BUSINESS`. To generate
per-business kits, swap the URL in the generator script:

1. Open `generate_print_kit.py` (sandbox) or send the slug list to your
   designer to regenerate.
2. Replace the line:
   ```python
   QR_URL = 'https://getlymx.com/pay.html?biz=YOUR-BUSINESS'
   ```
   with:
   ```python
   QR_URL = f'https://getlymx.com/pay.html?biz={biz_slug}'
   ```
3. Re-run for each business: `python3 generate_print_kit.py ./brew-and-bean-kit`
4. PDFs land in `<output>/en/`, `<output>/es/`, `<output>/zh-CN/`.

(For an MVP launch with Founding 25 partners, this is one print run of 25
kits with personalized QRs. After that, generic QRs can route customers to
a "Find a business" lookup page.)

## Personalization fields

The business card (`07-business-card_*.pdf`) has two text placeholders:

- `<Owner Name>` — replace with the actual owner's name
- `<Business Name>` — replace with the storefront name

These are intentionally left as placeholders for per-business runs.
Receipt-stuffer (`10`), table tent (`09`), and banner (`08`) all carry
the LYMX brand only — no business-specific text — so they can be printed
in bulk and shared across the network.

## Print settings (recommended)

- **Resolution:** 300 DPI minimum at final size (all QRs were generated at
  20–60 pixels per module so they're crisp at any reasonable print size).
- **Bleed:** 0.125" (already in the PDF — trim to outer edge of bleed.)
- **Color:** CMYK at output. The brand black `#0e1116` should be rich black:
  C50 M40 Y40 K100 (or your house equivalent) — never just K100.
- **Finishing:**
  - Window decal: cut to circle along outer bleed
  - Counter decal: square cut with 0.1" rounded corners
  - Bag sticker: kiss-cut circle
  - Banner: hem + grommet OR include retractable stand
  - Table tent: score along center fold (3" mark of the 6" height)

## Acceptance checks (before shipping to customer)

1. Scan every QR code with a phone — it must open `getlymx.com/pay.html`
   without errors.
2. Verify the gold prints as warm gold (`#d4af37`), not muddy yellow.
3. Confirm 4-block mark stays crisp at smallest sizes (employee button,
   business card).
4. Chinese text reads correctly — characters should be solid, no missing
   glyphs.

## Files location

```
ONBOARDING-KIT/
├── en/
│   ├── 01-window-decal_en.pdf      (4.25" sq, round trim)
│   ├── 02-counter-decal_en.pdf
│   ├── 03-qr-stand_en.pdf
│   ├── 04-wall-poster_en.pdf       (11.25" × 17.25")
│   ├── 05-employee-button_en.pdf
│   ├── 06-bag-sticker_en.pdf       (3.25" sq, round trim)
│   ├── 07-business-card_en.pdf     (2 pages — front + back)
│   ├── 08-banner-stand_en.pdf      (33.25" × 80.25")
│   ├── 09-table-tent_en.pdf        (fold at 3.125")
│   └── 10-receipt-stuffer_en.pdf
├── es/   (same 10 pieces, Spanish copy)
└── zh-CN/  (same 10 pieces, Simplified Chinese copy)
```

## Questions for the printer

1. Can you do a single proof set in EN before the full run?
2. What's the lead time for the 33" × 80" retractable banner?
3. Bulk pricing on 250-pack of business cards and receipt-stuffers?
4. Can you stock the kit components so re-orders ship same-week?

— end —
