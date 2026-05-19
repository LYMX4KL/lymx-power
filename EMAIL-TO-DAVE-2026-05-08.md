# Email to Dave — 13 bug fixes ready for retest (2026-05-08)

> **Copy the section below into Gmail. Subject is on the first line.**

---

**Subject:** LYMX Power · all 13 bugs fixed — please retest

Hi Dave,

Thanks again for the thorough QA pass on May 7 — clean, well-scoped, easy to act on. All 13 issues are now fixed. Please pull the latest and retest at your end. Below is what changed for each one and exactly what to verify.

Live site (after deploy lands): https://getlymx.com

---

## Summary

| # | Issue | Status | Verify by |
|---|---|---|---|
| 1 | Nav bar links compressed | Fixed | Resize browser between 880–1080px; nav stays readable |
| 2 | Logo small / inconsistent | Fixed | Logo is 32px tall on every page where it appears |
| 3 | Browse page wrong selected category | Fixed | Click any category from homepage → that category is highlighted on /browse |
| 4 | Browse page ignores search inputs | Fixed | Type in Find/Near on homepage → values appear pre-filled on /browse |
| 5 | "Partners" label should be "Businesses" | Fixed | /browse now reads "11 Businesses found" and "Showing live Businesses" |
| 6 | Write Review redirects incorrectly | Fixed | Homepage "Write a review" now opens a real review form, not the dashboard |
| 7 | Wallet accessible without login | Fixed | Homepage "Open Wallet" goes to /login.html, not /customer-wallet.html |
| 8 | Browse categories don't filter | Fixed | Click any chip on /browse → list + map markers filter to match |
| 9 | Browse search inputs don't update results | Fixed | Type in Find/Near → list filters in real time as you type |
| 10 | Sign In bypasses authentication | Fixed | Sign In on every page now goes to /login.html, never to a dashboard |
| 11 | Save / Share buttons not functional | Fixed | On a Business profile, Save toggles ♡↔♥ + toast; Share copies the URL with a toast |
| 12 | Business profile images not clickable | Fixed | Click any photo → opens a lightbox (← / → / Esc keys work too) |
| 13 | Network Partner cards not selectable | Fixed | Cards on the homepage now navigate to /browse with the correct category filter |

---

## What changed under the hood

**New files**
- `login.html` — single, friendly sign-in page that gates every Sign In click. Has a placeholder email/password form (no backend yet — by design) plus a role picker (Customer / Business / Partner) sending users to the correct signup flow.
- `write-review.html` — review form with star rating, headline, body, photo upload, receipt field, and the +100 LYMX bonus messaging. Submit shows a confirmation toast (no backend wired yet, marked as preview).

**Auth gating (#7, #10)**
- Every "Sign in" link across 13 pages now points to `login.html` instead of dropping straight into a `*-dashboard.html`.
- Homepage "Open Wallet" and "Write a review" CTAs no longer leak straight into authenticated pages.
- Every `*-dashboard.html` and `customer-wallet.html` now shows a yellow **DEMO PREVIEW** banner so anyone landing there via a stale link knows they're not authenticated.

**Browse filter + search (#3, #4, #5, #8, #9)**
- `browse.html` now reads `?category=`, `?q=`, and `?near=` query params on load and applies them to the chip selection and the Find/Near inputs.
- Category chips were expanded from 7 to 12 to match the homepage taxonomy (added Pets, Fitness, Finance, Automotive, Education).
- Each Business card has `data-category`, `data-price`, `data-rating`, `data-lymx`, and `data-distance` attributes so the filter logic can act on them.
- New JS wires: chip click → filter list + map markers, input typing → filter as you type, sort dropdown → re-orders by distance / rating / LYMX rate. The "X Businesses found near Y" count updates live.
- Homepage category links and the Hero search form now pass `?category=...&q=...&near=...` so user intent carries across pages.
- "11 partners" / "Showing live partners" relabeled to "Businesses" throughout `/browse`.

**Save / Share / Lightbox (#11, #12)**
- On `biz-brew-and-bean.html` and `biz-oakline-kitchen.html`:
  - Save button is now a real `<button>` (not a hash anchor). First click sets state to "Saved" with a heart fill + green toast. Click again unsaves.
  - Share uses the native Web Share API on mobile, falls back to clipboard copy on desktop, with a "Link copied to clipboard" toast.
  - Photo gallery is clickable / keyboard-navigable. Clicking opens a full-screen lightbox; ←/→ keys cycle photos; Esc closes; click outside the photo closes too.

**Nav + logo polish (#1, #2)**
- Logo height standardized to 32px (was a mix of 24/26/28).
- Nav-link gap normalized to 18px with `flex-wrap:wrap` on the largest pages.
- New responsive breakpoint at 881–1080px reduces gap and font slightly so links stop colliding before the 880px hide-on-mobile kicks in. Applied to 76 pages.

**Network Partner cards (#13)**
- Cards in the "Network partners" and "Founding network partners" sections on the homepage are now real `<a>` links going to `/browse?category=<MatchingCategory>`.

---

## Things to know for retest

1. **Auth is intentionally still a placeholder.** `login.html` has a form but doesn't actually authenticate yet — that's by design until the backend is ready. The Sign in flow is fixed in the sense that it no longer auto-logs anyone in as "Kenny." The DEMO banner on dashboards covers users who navigate directly to a dashboard URL.
2. **The Save state is in-page only.** Refreshing the page resets it. Persisting to a real account waits on auth + backend.
3. **The review form is a stub.** Submitting shows a confirmation but doesn't post anywhere yet — also waiting on backend.
4. **Map / location filtering is partial.** The "Near" input filters by text match against name/category/neighborhood for now; true geo-radius filtering needs the backend.

---

## What's NOT fixed (and what I'd love your second pass on)

- Mobile hamburger menu — the nav still hides links below 880px instead of collapsing into a menu. Worth a follow-up bug if you want it included.
- Real authentication wiring (intentional, see above).
- Persistent saved Businesses (intentional, see above).
- Real review submission backend (intentional, see above).

If anything looks off when you retest, log it the same way you did last time — the format made these very fast to act on. Happy to iterate.

Thanks again,

— Kenny
