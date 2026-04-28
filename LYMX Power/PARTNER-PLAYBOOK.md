# LYMX Partner Motivation Playbook

*Drafted April 27, 2026 — revised April 28, 2026 with Kenny's feedback*

---

## What this is

A comprehensive map of every lever that motivates Partners to (1) join, (2) actively recruit Businesses, and (3) stay long-term. Use this to decide which pieces to build first. The order they're listed here is roughly the order they matter to a typical Partner — money first, but the others compound.

Six categories:

1. **Money** — direct economic incentives
2. **Status & tiers** — progression and identity
3. **Territory & Territory Leaders** — the city-operator model
4. **Tools** — content and infrastructure that lowers friction
5. **Recognition & community** — non-monetary rewards
6. **Career path** — how Partners advance over years

---

## 1. Money

### Locked-in commission structure (4 layers deep)

LYMX is in the business of selling LYMX promotional credit units to Businesses (at 80% of face value, when issued) and buying them back (at the same 80%, when redeemed). Partner LYMX commissions are calculated as a percentage of the unit-sale revenue LYMX earns from Businesses in the Partner's tree — we can only pay commissions out of revenue we actually earn.

| Source | Cash on monthly subscription | LYMX on unit-sale revenue |
|---|---|---|
| **Direct** — Businesses you personally recruit | **9%** of $199 = **$17.91/mo** per Business | **9%** of LYMX's unit-sale revenue from that Business, paid in LYMX |
| **G1** — Businesses recruited by Partners YOU recruited | **3%** = $5.97/mo | **3%** of unit-sale revenue, in LYMX |
| **G2** — Businesses recruited by Partners 2 levels deep | **2%** = $3.98/mo | **2%** of unit-sale revenue, in LYMX |
| **G3** — Businesses recruited by Partners 3 levels deep | **1%** = $1.99/mo | **1%** of unit-sale revenue, in LYMX |

**LYMX is network-spendable, not cash.** Cash commissions (sign-up bonus + monthly subscription %) are paid via ACH. LYMX commissions credit to the Partner's LYMX balance and are spendable at any LYMX Business in the network. Not convertible to cash.

Plus the **$500 cash sign-up bonus** per direct activation, paid in two installments:
- **$250 at day 7** after Business activates
- **$250 at day 30** (Business must still be active)

The 7/30 split is anti-fraud insurance — if a Business signs up and immediately churns, LYMX only paid out half.

### What to consider adding

- **Speed of regular payout.** Move from monthly to **weekly** for ongoing commissions (Bronze) and **daily** for Platinum tier. Most networks pay monthly; LYMX wins recruiters by paying fast.
- **Annual loyalty bonus.** Any Partner who stays **actively recruiting** for 12+ months gets a $500 LYMX grant on their anniversary. Costs LYMX little, signals long-term partnership.
- **Volume kickers.** Any Partner who hits 5 direct activations in a quarter gets an extra $500 cash bonus on top.
- **Holiday accelerator.** December: 1.5× sign-up bonus ($750 instead of $500). Drives end-of-year recruiting.

---

## 2. Status & tiers

### The four-tier ladder

| Tier | Threshold | What they unlock |
|---|---|---|
| **Bronze** | 1+ active direct Business | Founding badge, content hub access, basic CRM |
| **Silver** | 5+ active direct OR 15+ in tree | $200/mo co-op marketing budget, priority lead routing in metro, "Silver" badge on listing |
| **Gold** | 15+ active direct OR 50+ in tree | Featured on getlymx.com Partners page, monthly Partner Council seat, **+1% override boost** on direct, custom email (e.g., maya@getlymx.com) |
| **Platinum** | 40+ active direct OR 150+ in tree | Quarterly all-expenses-paid summit, **stock option grant track** (TBD structure), Master Partner candidacy, **+2% override boost** |

**Note on Platinum stock options:** Kenny's preference is stock options rather than direct equity grants. Mechanism still TBD — typical structures: ISO/NSO grants vesting over 2–4 years, with quantity tied to volume and tenure. Need legal counsel before finalizing.

### Why this works

- Public ladder with concrete unlocks gives Partners a visible "next milestone."
- "I'm a Gold Partner" becomes part of their identity — they don't quit easily.
- Self-segregating: serious Partners climb fast; tire-kickers stay Bronze.
- Mostly self-funded — most unlocks are perks LYMX provides at low cost.

### Implementation

- Show current tier on `rep-dashboard.html` near the top.
- Show progress toward next tier ("3 more direct activations to Silver").
- Add `partner-tiers.html` page explaining all four tiers publicly — recruiting tool itself.

---

## 3. Territory & Territory Leaders

### The vision (per Kenny)

A **Territory Leader** is a Partner who commits real time and money to dominate a metro: opens a local office, hosts road shows and live presentations, trains new Partners, runs Business demos. In exchange, they earn an **additional override on every Business in their territory** — including ones recruited by other Partners.

Critically: **other Partners' commissions are not affected.** A Partner who recruits a Las Vegas Business still earns their full 9% direct + tree overrides. The Territory Leader's % is on TOP, paid by LYMX out of platform margin.

This turns the Territory Leader into a real local business operator. They have skin in the game and a strong reason to invest in their city.

### Three phases

#### Phase 1 (now → first 50 Businesses)

- **No formal territories.** Anyone recruits anywhere.
- **First-mover protection** is automatic via the MGC tree — the Partner who recruits a Business has them as direct forever.
- **Founding Partner badge** for the first 25 Partners.

#### Phase 2 (50 → 500 Businesses)

- **City Champion (lightweight)**: Any Partner with 5+ active direct Businesses in a single metro becomes the City Champion. Recognition only — featured on homepage's "Powered by LYMX in [city]" callout, $200/mo co-op marketing budget, first right of refusal on inbound metro leads, custom email like `maya@sacramento.getlymx.com`. No exclusivity — others can still recruit in the city.

#### Phase 3 (500+ Businesses)

- **Territory Leader (full)**: Platinum-tier Partners can apply to become Territory Leader for a city. Commitments:
  - Open a physical local office (or co-working space)
  - Host monthly road show / demo event open to all partners and prospect Businesses
  - Run quarterly partner training sessions
  - Pay annual fee or hit volume quota (e.g., 30 Business activations/year in their metro)

  Benefits:
  - **+3% override on every Business** in the territory's monthly fee — even ones recruited by Partners outside their tree. Paid by LYMX, not deducted from other Partners' commissions.
  - 100% of inbound metro leads route to the Territory Leader for distribution
  - Custom email like `maya-territory@sacramento.getlymx.com`
  - Public branding as "Las Vegas Territory Leader"
  - Their office staff can deliver Business onboarding (per the Activation Kit, see §7) — relieving them of training duties Partners typically dislike
  - Right to host paid local events featuring LYMX brand

  This makes the Territory Leader a real local business owner. They invest their own money to grow the territory; LYMX pays them back via the +3% override on city-wide activity.

### Why this beats strict territories

- New Partners aren't locked out by accident of geography.
- Active recruiters get City Champion recognition without locking out competitors.
- Top operators eventually get exclusive economic upside (Territory Leader) — by earning it through real commitment.
- Other Partners' commissions are never reduced.

---

## 4. Tools (content hub + CRM)

This is where Partners drop out fastest if you don't help them. The single most valuable thing you can give a Partner is **a script and a slide deck so they don't have to invent the pitch themselves.**

### The Partner Sales Kit (delivered in a content hub)

**Cold-outreach assets:**
- 30-second elevator pitch (memorized version + written)
- 1-page leave-behind PDF (front: value prop, back: economics)
- Email templates (3 versions: warm intro, cold reach, follow-up)
- Text/SMS templates for scheduling demos
- Phone script with objection handlers ("LYMX vs. cryptocurrency," "what about my existing loyalty program?")

**Demo assets:**
- 10-slide pitch deck (.pptx + Google Slides)
- 30-second explainer video
- Sample Business Activation Kit they can show on a phone

**Closing assets:**
- Standard Partner Agreement (Google Docs link)
- FAQ for hesitant Businesses (legal/compliance, opt-out, comparison vs. ads)
- "First 30 days" success guide for new Businesses

### CRM

A simple lightweight tool inside the Partner portal:
- Add a prospect (name, business, contact, status)
- Status pipeline: Cold → Warmed → Demo Scheduled → In Trial → Activated → Inactive
- Notes per prospect, last contact date
- Reminder system: "follow up with X in 7 days"
- Auto-pull activated prospects into the Partner's tree

### Training (delivered through Territory Leader offices, per Kenny)

A 30-min video course at `partner-academy.html`:
- Module 1: How LYMX works (10 min)
- Module 2: Common objections and how to handle them (10 min)
- Module 3: How to run a 15-minute Business demo (10 min)
- Quiz at end. Pass = "Certified Partner" badge.

In Phase 3, Territory Leaders run live training sessions in their cities. Partners attend in-person; Territory Leader's office staff coach individual Partners. Removes the training burden from LYMX HQ and from Partners who dislike training others themselves.

---

## 5. Recognition & community

### Public recognition
- **Leaderboard** on `rep-dashboard.html` (already built — top recruiters this month, network-wide)
- **Monthly newsletter spotlight** — feature one Partner's story per issue, with photo and quote
- **Founding Partner badge** for the first 25 — permanent, public on profile
- **Tier badges & Champion badges** as described above

### Private community
- **Partner Slack/Discord** — invite-only, segmented by tier (Bronze in one channel, Silver+ in another)
- **Monthly Partner Calls** — 30-min Zoom, you (Kenny) share roadmap + answer questions
- **Quarterly Partner Summit** — Gold+ tier, in-person event in Las Vegas (or Territory Leader's city)

### Public-facing
- A `partners.html` page on the public site listing top Partners (opt-in) with their photo, metro, and tier/Champion/Territory Leader status. Partners get a real digital business card.

---

## 6. Career path

The Partners who stay 5+ years are the ones who feel like they're building toward something, not just earning commissions. Set this up clearly:

```
Bronze Partner          (1+ direct active)
   ↓
Silver Partner          (5+ direct)
   ↓
Gold Partner            (15+ direct)
   ↓
Platinum Partner        (40+ direct)
   ↓
Master Partner          (invited, top ~10 nationwide)
   - Stock option grant (TBD structure)
   - Advisory Board seat
   - Direct line to founder
   - Quarterly summit attendance
   ↓
Territory Leader        (city-by-city application, Phase 3+)
   - +3% override on every Business in their territory
   - Local office, road shows, training
   - Featured branding
   ↓
Regional Director       (full-time role, W-2, base + override)
```

Path from Platinum → Master is invitation-only. Master → Territory Leader is application. Territory Leader → Regional Director is mutual decision (becomes a real LYMX employee, runs a region).

This makes a Partner feel like they're building a career, not running a side hustle.

---

## 7. The "Activation Kit" — what the $250 setup fee delivers

What does the $250 setup fee actually pay for? Here's a strong "Activation Kit" that justifies $250:

- **Public listing on getlymx.com** (live within 24h)
- **Business portal access** with dashboard, settlement preview, transaction history
- **10,000 LYMX promotional credit** ($100 value) the Business can issue to their first 50 customers as a launch promo
- **Branded counter QR code + window decal** — printed and shipped, real physical materials with the business's name + LYMX logo
- **30-min onboarding call** delivered by LYMX Partner Success — *or* by the Territory Leader's office staff in Phase 3 (per Kenny — Partners typically dislike training duties; Territory Leader's staff handles it)
- **First-30-days success guide** PDF with checklists
- **POS integration support** (depending on POS, ~30 min hands-on)

Total LYMX cost to deliver: ~$30–50 (the 10,000 LYMX promo is bookkeeping, not real cost). Net margin from $250 setup fee: ~$200.

---

## 8. Operational nuts and bolts

These are smaller but matter:

- **Payout speed**: weekly (default), daily (Platinum tier).
- **Real-time dashboard transparency**: every commission appears in the Partner's dashboard the same day the Business transaction clears.
- **No clawbacks** unless fraud. If a Business cancels in month 4, the Partner keeps the $500 sign-up. (The 7/30 split already protects against immediate-churn fraud.)
- **1099-NEC issued** by January 31 each year for the prior tax year.
- **Direct deposit only** — ACH preferred over checks.
- **24-hour onboarding** for new Partners — sign up, complete W-9 + agreement, get access to the Sales Kit and CRM same day.

---

## 9. The Founding 25 program (earned, not claimed)

Use scarcity AND merit. Founding 25 status is **earned**: the first 25 Partners to hit **5 Direct Business activations** get lifetime perks. This stops Business owners from claiming the Founding badge for free, taking all 25 spots, and never actually recruiting.

**To qualify**: First 25 Partners network-wide to reach 5 activated Direct Businesses.

**What they get**:
- Permanent **"Founding Partner"** badge on profile (visible forever)
- **1.5× sign-up bonuses on activations beyond their 5th** for the next 90 days ($750 instead of $500 per activation)
- **+2% extra Direct override forever** (so 11% instead of 9% on Direct Businesses' fees)
- **Lifetime quarterly summit invite** (regardless of tier)
- **Direct WhatsApp line** to Kenny for first 6 months
- Public recognition on the homepage and in the Partner directory

After the Founding 25 are claimed, the program closes. May reopen as "Founding 100" later if growth warrants.

**Why this works**:
- Filters: only people who actually go out and recruit qualify. Tire-kickers don't get the badge.
- Status is a real signal: "Founding Partner" means "they brought 5+ Businesses in the early days"
- Creates competition: first-to-five wins
- Aligns incentives: LYMX's growth depends on activations, so the perk is given for activations
- Prevents the badge from being diluted by people who joined and did nothing

---

## 10. Decision matrix — what to build first

In order of impact ÷ effort:

| Priority | Build | Why first | Effort |
|---|---|---|---|
| 1 | **Tier ladder + tier display on rep-dashboard** | Cheap. Adds identity. Self-funds via tier unlocks. | ~1 page, 2 hrs of editing |
| 2 | **Content hub** (sales kit) | Removes #1 reason Partners fail to recruit ("don't know what to say") | ~1 page + 5 markdown sales-kit assets |
| 3 | **City Champion + Territory Leader rules document** | Solves territory question; sets up Phase 3 | ~1 markdown doc, public on partners.html |
| 4 | **Founding Partner program promo** | Time-limited urgency for early adopters | ~1 banner on rep-dashboard + business.html |
| 5 | **Calculator update for 4-layer commissions** | Reflects new structure (9/3/2/1) | ~30 min edit to projection.html |
| 6 | **Partner CRM** | Helps active Partners; doesn't help inactive ones | Bigger build, ~1 dedicated page |
| 7 | **Partner Academy training** | Important but not urgent | Multi-week project |
| 8 | **Master Partner stock option program** | Needs legal counsel; defer | Phase 2+ |

---

## 11. Recommended sequence for next session

If we only do 4 things:

1. **Update the calculator (`projection.html`)** to reflect the 4-layer commission structure (9% direct + 3% G1-partner-recruits + 2% G2 + 1% G3) and the $250+$250 split sign-up bonus.
2. **Lock in the tier ladder** in the rep-dashboard with progress-toward-next-tier indicator.
3. **Write the Founding Partner program** (with 1.5× bonus + lifetime override boost) as a 90-day launch window. Banner on rep-dashboard + business.html.
4. **Build the content hub** with at minimum: 1-page leave-behind PDF, email templates, FAQ.

Everything else (CRM, Academy, formal Territory Leader, Master Partner stock options) can wait until Phase 2.

---

## Decisions captured (from Kenny's feedback)

- ✅ **Tier criteria**: 1/5/15/40 direct active Businesses (agreed)
- ✅ **Founding Partner cap**: 25 (start), expand up to 100 if traction warrants
- ✅ **City Champion budget**: $200/mo per Champion (agreed as recurring cost)
- 🟡 **Master Partner equity**: Stock options instead of direct equity grants — structure TBD with legal counsel
- ✅ **Tier override boosts**: +1% at Gold, +2% at Platinum (kept as-is)
- ✅ **Commission structure**: 9% direct / 3% G1-partner-recruits / 2% G2 / 1% G3
- ✅ **Sign-up bonus**: $500 split as $250 day-7 + $250 day-30 (anti-fraud)
- ✅ **Holiday accelerator**: $750 (not $1,000)
- ✅ **Founding Partner bonus**: 1.5× = $750 (not 2× = $1,000)
- ✅ **Activation Kit**: 10,000 LYMX ($100 value) + window decal + Territory Leader office training delegation

---

*End of revised playbook. Ready to build whichever sections you want to tackle next.*
