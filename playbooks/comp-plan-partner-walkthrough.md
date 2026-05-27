---
slug: comp-plan-partner-walkthrough
title: Understand the LYMX Partner Comp Plan
project: LYMX Power
role: partner
prereqs:
  - signed_in_as_partner
duration_min: 7
difficulty: easy
last_verified: 2026-05-26
last_revised: 2026-05-26 (created — closes #7bfc73c8 Comp Plan 404)
related:
  - partner-email-setup
  - partner-onboarding
---

# Understand the LYMX Partner Comp Plan

The Partner Comp Plan page (`/comp-plan.html`) is the plain-English explainer of how Partners earn from LYMX — sign-up bonuses, recurring revenue, the Founding 25 race, and the three-generation downline. This playbook walks Partners through what's on the page, what the numbers actually mean, and where to go next to start earning.

## Quick context — what changed

Before 2026-05-26, partners who clicked "see comp plan" anywhere on the site (Share Hub, dashboards) hit a 404. The compensation plan existed in scattered marketing docs and inside Kenny's head, but no single user-facing page consolidated it. That hurt new partners who needed to internalize the math before pitching their first business.

The new page consolidates everything in one place:

- The three headline numbers ($750 per activation, 11% recurring, $1,000 Founding 25 speed bonus)
- Partner fee structure (and the global waiver through 7/31/2027)
- Three-generation downline rules (G1/G2/G3 are *Partners*, not Businesses — Businesses are Production)
- Founding 25 qualifying criteria (first 25 Partners to hit 5 Direct activations)
- Two worked-example scenarios (steady year vs Founding-25 sprint)
- A 4-step "how to start earning" walkthrough

## What you'll need

- A partner account on LYMX (sign in at `getlymx.com/login.html` with your partner email).
- 7 minutes to read through and understand the math.
- Optional: a notepad to write down your own personal earning targets.

## What success looks like

After reading the page, you can:

1. State the three headline numbers from memory ($750, 11%, $1,000).
2. Explain to a prospect — in one sentence — what activating a Business as a Partner earns you.
3. Tell the difference between "Production" (your own Businesses) and "G1/G2/G3" (your downline Partners).
4. Use the Commission Calculator to model your own goal.

You'll also know exactly where to click next: the Discovery Script (60-second pitch), the Commission Calculator, and your personal partner link.

## Steps

### Step 1 — Open the Comp Plan page
**Where:** Sidebar (Partner role) → Earn → **Comp Plan** OR direct URL `getlymx.com/comp-plan.html`.
**Do:** Click the link. The page loads with the gold "Partner compensation" eyebrow and three cards at the top.
**Element:** Sidebar link with slug `comp-plan-partner-walkthrough` data attribute on the page body.
**Expect:** Page loads in under 2 seconds. The top three cards show $750 / 11% / $1,000.
**If you see a 404:** The page hasn't deployed yet. Hard-refresh once. If still 404, file a feedback ticket — the page was added 2026-05-26 and should be live.

### Step 2 — Memorize the one-sentence math
**Where:** Section titled "The math, in one sentence" (just below the three headline cards).
**Do:** Read this card out loud: *"Activate one Business → $750 up front + ~$22 every month after. Five activations → $3,750 up front + ~$110 monthly recurring."*
**Expect:** That sentence becomes your default answer when a Business owner asks "what's in it for you?" during a pitch.
**Why this matters:** Partners who can't recite the math fumble in the first 10 seconds of a pitch. This sentence is your hook.

### Step 3 — Understand what Partner fees you actually pay
**Where:** Section titled "What being a Partner costs" (the table with $25 / $12.95 / $0).
**Do:** Read the three rows and the small print under the table.
**Expect:** You learn that the $25 sign-up and $12.95/mo (or $100/yr) fee are BOTH waived for everyone through July 31, 2027 — and that Founding 25 partners have a permanent waiver for life. So today, you pay zero to be a Partner. The fees exist on paper for the structure, but no one is collecting them right now.
**If you're worried about the post-2027 fee:** Either qualify for Founding 25 (5 Direct activations) for the permanent waiver, or factor the $12.95/mo into your activation income — one Business activation pays your fee for ~3 years.

### Step 4 — Distinguish Production from G1/G2/G3
**Where:** Section titled "Three generations of downline" (the three-card row + the blue callout).
**Do:** Read the cards and the callout very carefully — this is the part Partners get wrong most often.
**Expect:** Clear understanding that:
- A Business YOU activate yourself is **Production**, not a generation.
- A Partner YOU sponsored is **G1** — you earn override on every Business they activate.
- A Partner that your G1 sponsored is **G2** — smaller override.
- A Partner that your G2 sponsored is **G3** — smallest override.
**Why this matters:** New Partners sometimes count their own activated Businesses as "G1", inflate their projections, and get disappointed. The Commission Calculator separates Production from Downline for the same reason.

### Step 5 — Decide if you're racing for Founding 25
**Where:** Section titled "Founding 25 program" (the two gold-and-white cards).
**Do:** Read both cards. Decide if the $1,000 speed bonus + permanent fee waiver + leaderboard badge is worth pushing for 5 activations in a short window.
**Expect:** You leave the section knowing whether your goal this quarter is "Founding 25 sprint" or "steady recurring growth". Both are valid; the Comp Plan supports both.
**If you want to qualify:** Activate 5 Businesses directly (Production, not downline). Speed counts — first 25 to five lock the rank.

### Step 6 — Run your own scenario in the Calculator
**Where:** Click the "Open Commission Calculator" button in the CTA card at the bottom, OR sidebar → Earn → Commission Calculator.
**Do:** Plug in your realistic activation pace, downline assumptions, and recurring stay-rate. The calculator outputs monthly + annual estimates.
**Expect:** You see a concrete dollar number you're playing for, not just a vague "passive income".
**If the Calculator shows $0:** You haven't entered any Production or Downline numbers yet. Add at least one Business activation to start the math.

### Step 7 — Get your partner link and pitch a Business
**Where:** Click "Pitch Script (60 sec)" or "Get my partner link" in the CTA at the bottom.
**Do:** Copy your partner link (format `getlymx.com/biz-signup.html?ref=YOUR-CODE`) and use it on every Business pitch. Open the Discovery Script for the 60-second elevator version.
**Expect:** When you send a Business owner your link, their signup is attributed to you — that's how the $750 finds its way to your account when they go live.
**If the link doesn't include your code:** You're not signed in as a Partner. Sign in first; the Refer page won't generate your link for non-partner accounts.

## Pair with these playbooks

- [partner-email-setup](partner-email-setup.md) — Connect your `@getlymx.com` email so the prospects you pitch see a branded sender.
- `partner-onboarding` (planned) — The end-to-end "your first 30 days as a Partner" walkthrough.
- `business-onboarding/05-booking-the-call` — Once a Business signs up under you, this is the call that locks in your $750.

## Edits and updates

If economics change (rates, fees, Founding 25 criteria), update BOTH this playbook AND the page (`comp-plan.html`) in the same commit. The playbook should always match the page. If they drift, partners get confused and trust drops.

Source of truth for the underlying numbers lives in memory entries: `project_lymx_economics`, `project_lymx_partner_fees`, `project_lymx_founding_partners`, `project_lymx_network_flywheel`.
