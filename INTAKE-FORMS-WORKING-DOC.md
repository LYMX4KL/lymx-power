# LYMX Intake Forms — Working Doc

**Status:** In progress — collaboration session 2026-05-04.

**Author:** Kenny + AI pair, started 2026-05-03 EOD.

**Process rule:** Design the doc first, get alignment, THEN code (migration → form endpoints → UI).

**Companion file:** `INTAKE-FORM-FEE-SCENARIOS.xlsx` — the canonical list of fee scenarios with default LYMX-per-deal inputs.

---

## 0. Locked decisions (2026-05-04)

These are the foundational calls that govern the rest of the design. Don't revisit without explicit reason.

### 0.1 The two-tier firm / agent model (mid-session reframe)

**Form A and Form B map to firms vs individuals — NOT to "simple business vs IC." Important nuance:**

- **Tier 1 = Firms.** Brokerages, insurance firms, law offices, title/escrow companies. They sign up FIRST via **Form B**. Their fee structure is the 20 firm-level scenarios (Excel) PLUS a config for how they reward their own hanging agents/staff with LYMX (onboarding, monthly performance, marketing, admin stipends, etc.). Firms = parent organizations.

- **Tier 2 = Individual agents** (realtors, insurance agents, mortgage brokers, attorney associates) who hang their license with a firm. They sign up via **Form A** — the SAME form as a regular storefront like a cafe — because their personal fee structure is "menu-style" flat-rate, not multi-scenario. They issue LYMX to (a) their consumer clients and (b) their own coordinators / marketing staff (a mini-employer pattern, scaled down from the firm's).

- **Form A also serves**: plain storefronts (cafe, retail), and self-employed professionals with no parent firm.

- **Hard dependency**: a firm must be on LYMX before its agents can sign up. Form A's "I'm an agent at a firm" path forces the applicant to pick from the dropdown of already-LYMX-registered firms. Agents whose firms aren't on the platform yet see "Ask your firm to sign up first."

- **The 20 fee scenarios in the Excel are FIRM-LEVEL.** They fire on the firm's customer-facing transactions. Individual agents on Form A use a simpler flat-rate / menu model on top.

### 0.2 Issuance & economics
2. **Issuance economics are unchanged.** Businesses BUY LYMX at 80% of face value when they issue. Customers redeem it. The platform buys LYMX back from the redeeming Business at the same 80%. The IC's commission revenue is what funds their LYMX issuance, but the platform mechanics don't care where the dollars come from.
3. **Issuance format = Fixed LYMX per deal type.** Each IC sets their own fixed LYMX amount per fee scenario at signup (e.g. "every buy-side close issues 50,000 LYMX to the buyer"). This does NOT scale with deal size — a $300K home and a $3M home both issue the same LYMX to the buyer for that IC. Simplest to communicate to consumers.
4. **v1 scope: 4 IC professions** — real estate (residential + commercial), insurance, mortgage, title/escrow.
5. **Multi-recipient model = one row per (event, recipient).** PM renewal isn't `{event: pm_renewal, owner_lymx: X, tenant_lymx: Y}`; it's two separate rows: `pm_renewal_to_owner` + `pm_renewal_to_tenant`. Each row in the scenarios table is a single fee event, single recipient, single LYMX amount. Cleanest schema, easiest to add new scenarios.
6. **Buyer agent rebate is its own scenario,** distinct from buy-side closing — kept for the marketing framing.
7. **PM renewal splits LYMX** between owner share and tenant share (per #5, that's two rows).
8. **Mortgage YSP deferred to v2.** Drop from v1 — borrower didn't pay it directly, model gets muddy.
9. **Commercial sale + closing/escrow fee = both buyer and seller** get LYMX (per #5, two rows each).
10. **Title insurance has two rows** — buyer-paid market and seller-paid market. Recipient = whoever paid.

**v1 scenario count: 20** (across 4 firm types — these are FIRM-level events). See companion XLSX for the full list.

### 0.3 Form A / Form B mechanics

11. **Sensitive data deferred to post-approval.** SSN/EIN and ACH banking details are NOT collected on the intake form. After we approve the applicant, a separate "set up payouts" flow handles it (likely Stripe Connect).
12. **Form A firm-linkage required for agent sub-flow.** When Form A applicant selects "I'm an agent at a firm," the firm dropdown is required and limited to LYMX-registered firms.
13. **Form B agent-rewards = preset menu.** Firm picks from preset reward categories (onboarding, monthly performance, marketing, etc.) and sets a fixed LYMX amount per category. Each grant is firm-discretionary (firm clicks "Grant" in their dashboard with a category label). No automatic performance-tied rules in v1.
14. **Practice categories on Form A = self-selected.** Multi-select checkboxes (residential sales, commercial leasing, etc.) determine which scenarios show up in the agent's eventual issuance config.
15. **Agent rewards v1 menu = 8 preset categories** (see Excel "Agent Rewards" tab):
    - Onboarding bonus
    - Monthly performance
    - Closed-deal recognition
    - Recruiting / prospecting efforts (agent's client recruitment subsidy)
    - Admin / coordinator / marketing-staff stipend
    - Training / CE completion
    - Holiday / anniversary
    - Recruit-an-agent referral
16. **Recurring/scheduled grants deferred to v2.** v1 = firm clicks "Grant" with a category each time. Learn what firms actually use, automate the patterns later.

### 0.4 Verification & approval

17. **License verification = hybrid.** Trust the license number at intake (low friction), then run a verification check before first payout. Stripe Connect's KYC catches a lot of this naturally; per-state license API integration is v2.
18. **Approval workflow = manual review for all in v1.** Every applicant goes into a queue. Catches fraud/typos/edge cases. Once we have pattern recognition, automate the easy cases.
19. **Custom reward categories = preset + "Other (specify)".** v1 has the 8 presets plus a free-text "Other" option per grant. Firms can describe one-off reward reasons. We don't allow firms to define new persistent categories yet.

---

## 1. The big picture

LYMX is a unified webapp serving the full network. Every actor on the Business side signs up via one of two intake forms — which one depends on whether they're a parent organization (Firm) or an individual operator.

| Actor | Examples | Form | Why this form |
|---|---|---|---|
| Customer | Tenant, subscriber, owner accumulating LYMX | (Customer signup — separate, not in scope here) | — |
| **Firm** (parent organization) | Brokerage, insurance firm, law office, title/escrow company | **Form B** | Multi-scenario fee structure (20 firm-level events) + agent rewards config |
| **Storefront** (simple business) | Cafe, restaurant, retail, gym | **Form A** | One flat per-$ issuance rate |
| **Agent at a firm** (individual licensed pro hanging license with a Firm) | Realtor, insurance agent, mortgage broker, attorney associate | **Form A** | Their personal fees are menu-style flat-rate, simpler than firm's |
| **Self-employed professional** (no parent firm) | Solo CPA, freelance designer, consultant | **Form A** | Custom services menu, set own rates |

**Critical sequencing (lock #0.1):** A Firm MUST be on LYMX before any of its hanging agents can sign up. Agents on Form A pick their firm from a dropdown limited to LYMX-registered firms.

Both forms feed into the same `businesses` table — every entity that issues LYMX is a Business in the schema, regardless of size or form. The schema supports three different issuance modes: flat-rate, scenario-based (firm), and custom services menu.

---

## 2. Form A — Storefront / Agent / Self-employed intake

For any individual operator: storefronts, agents hanging at a firm, self-employed pros.

### 2.0 — Form structure

The form opens with a **business type discriminator** that branches the rest of the form into one of three modes. This single field controls which fields are shown and which issuance mode applies.

```
Q: What kind of business are you signing up?
   ( ) Storefront / retail business           → Mode 1: Flat per-$ rate
   ( ) Licensed agent at a firm               → Mode 2: Scenario menu
   ( ) Self-employed professional / no firm   → Mode 3: Custom services
```

### 2.1 — Owner identity (all modes)

| Field | Type | Required | Notes |
|---|---|---|---|
| Full legal name | text | yes | |
| Email | email | yes | becomes login |
| Phone | tel | yes | for OTP / contact |
| Date of birth | date | yes | needed for KYC at payout |

### 2.2 — Business identity (all modes)

| Field | Type | Required | Notes |
|---|---|---|---|
| Business legal name | text | yes | sole prop = owner's name |
| DBA / trade name | text | optional | |
| Business category | select | yes | drives homepage feature placement |
| Website / social | url | optional | |

**NOT collected at intake** (per lock #11): SSN/ITIN, EIN, full bank/ACH details. These come post-approval via Stripe Connect.

### 2.3 — Mode 1: Storefront fields

| Field | Type | Required | Notes |
|---|---|---|---|
| Primary location address | address | yes | |
| Multi-location? | boolean | yes | if yes, additional location subform |
| Hours of operation | structured | optional | per-day open/close |
| **Issuance rate** (flat per $1) | number | yes | e.g. 5 LYMX per $1 spent |
| Storefront photo | image | optional | post-approval acceptable, drives homepage feature |

### 2.4 — Mode 2: Agent-at-a-firm fields

| Field | Type | Required | Notes |
|---|---|---|---|
| **Parent Firm** | dropdown | yes | limited to LYMX-registered firms (lock #12) |
| License number | text | yes | trust at intake, verify before payout (lock #17) |
| License state | select | yes | |
| License expiration | date | yes | |
| **Practice categories** | multi-select | yes | residential sales, commercial sales, leasing, PM, etc. (lock #14) |
| Service area | text/multi | optional | counties or metros |
| **Issuance scenarios** (per-category rates) | structured | yes | one row per scenario the agent enables, with fixed LYMX per deal |
| **Agent reward grants to own staff** (optional) | structured | optional | mini version of Form B's agent rewards — for the agent's own coordinator/admin/marketing person |
| Agent photo / headshot | image | optional | drives directory listing |

**Note on agent issuance:** The agent inherits their parent Firm's fee structure as a starting template, but sets their *own* fixed LYMX amount per scenario. Two agents at the same firm can issue different amounts. (Lock #3: fixed LYMX per deal, does not scale with deal size.)

### 2.5 — Mode 3: Self-employed professional fields

| Field | Type | Required | Notes |
|---|---|---|---|
| Profession / specialty | text | yes | |
| License number (if licensed) | text | conditional | required if state-licensed |
| License state / expiration | select / date | conditional | |
| Service area | text | optional | |
| **Custom services menu** | structured | yes | list of services they offer + LYMX issuance per service |
| Service photo / portfolio | image | optional | |

The **custom services menu** is a repeatable block:
```
Service name        | Price (USD) | LYMX issued per booking
"60-min consult"    | $150        | 1500
"Project audit"     | $500        | 5000
...
```

### 2.6 — Referring partner (all modes)

| Field | Type | Required | Notes |
|---|---|---|---|
| Referring partner code | text | optional | triggers $500 sign-up bonus credit to the named partner |

### 2.7 — Terms acceptance (all modes)

| Field | Type | Required | Notes |
|---|---|---|---|
| Accept Terms of Service | checkbox | yes | versioned, store ToS version + timestamp |
| E-signature (typed full name) | text | yes | matches owner identity name |
| Date acknowledged | auto | yes | server-set |

### 2.8 — Deferred to post-approval (NOT on Form A)

After manual review approves the applicant, a separate "set up payouts" flow collects:
- SSN/ITIN
- EIN (if entity)
- W-9
- Bank account / ACH (handled by Stripe Connect)
- License verification API check (before first payout)

---

## 3. Form B — Firm intake

For brokerages, insurance firms, law offices, title/escrow companies. The Firm is the parent organization for hanging agents and is responsible for the firm-level fee structure (20 scenarios) plus the agent rewards configuration.

### 3.1 — Principal contact identity

| Field | Type | Required | Notes |
|---|---|---|---|
| Principal full name | text | yes | designated broker / managing partner / firm principal |
| Title at firm | text | yes | "Designated Broker", "Managing Partner", etc. |
| Email | email | yes | becomes admin login |
| Phone | tel | yes | |
| Date of birth | date | yes | needed for firm KYC at payout |

### 3.2 — Firm identity

| Field | Type | Required | Notes |
|---|---|---|---|
| **Firm legal name** | text | yes | as registered |
| DBA / trade name | text | optional | |
| **Firm type** | select | yes | Real estate brokerage / Insurance firm / Mortgage company / Title-escrow / Law office / Other |
| Firm formation state | select | yes | |
| Firm website | url | optional | |
| Year founded | number | optional | trust signal |
| **Firm license number** | text | yes | the firm's own license, distinct from individual agent licenses |
| Firm license state | select | yes | |
| Firm license expiration | date | yes | |

**NOT collected at intake** (per lock #11): EIN, full bank/ACH details, ownership SSNs. Deferred to Stripe Connect post-approval.

### 3.3 — Locations / branches

Repeatable block — at least one required.

| Field | Type | Required | Notes |
|---|---|---|---|
| Branch address | address | yes | |
| Is this the headquarters? | boolean | yes | exactly one HQ |
| Branch phone | tel | optional | |
| Manager / branch principal | text | optional | the local broker-of-record |

### 3.4 — Fee scenarios config (the 20 firm-level events)

This is the heart of Form B. The firm enables the scenarios that apply to their business and sets a fixed LYMX-per-deal amount for each enabled scenario.

The full list of 20 scenarios lives in the companion XLSX (`INTAKE-FORM-FEE-SCENARIOS.xlsx`). Each row is a single (event, recipient) pair (lock #5).

**UI pattern:** scenarios grouped by firm type. At signup, only scenarios matching the selected firm type (3.2) are pre-shown; others are collapsed under "Show more / cross-discipline scenarios."

| Per-scenario field | Type | Required | Notes |
|---|---|---|---|
| Enabled | checkbox | yes | defaults to on for the firm's own type |
| LYMX per deal | number | yes-if-enabled | fixed amount, does not scale with deal size |
| Notes (internal) | text | optional | firm-facing memo |

**Locked scenarios in v1 (20 total):**

- **Real Estate Residential (8):** `resi_buy_to_buyer`, `resi_sell_to_seller`, `resi_lease_to_tenant`, `resi_buyer_rebate_to_buyer`, `resi_pm_monthly_to_owner`, `resi_pm_leasing_to_owner`, `resi_pm_renewal_to_owner`, `resi_pm_renewal_to_tenant`
- **Real Estate Commercial (4):** `comm_tenant_rep_to_tenant`, `comm_landlord_rep_to_landlord`, `comm_sale_to_buyer`, `comm_sale_to_seller`
- **Insurance (2):** `ins_new_to_holder`, `ins_renewal_to_holder`
- **Mortgage (2):** `mort_orig_to_borrower`, `mort_refi_to_borrower`
- **Title / Closing (4):** `title_buyer_paid_to_buyer`, `title_seller_paid_to_seller`, `closing_fee_to_buyer`, `closing_fee_to_seller`

(Mortgage YSP deferred to v2 per lock #8.)

### 3.5 — Agent rewards config (firm → its hanging agents)

Firm sets a default LYMX amount per reward category. These are firm-discretionary grants — when the firm wants to reward an agent, the firm clicks "Grant" in their dashboard and picks a category (lock #13). No automatic / scheduled grants in v1 (lock #16).

**8 preset categories (lock #15):**

| Category key | Display label | Default LYMX (firm sets) |
|---|---|---|
| `agent_onboarding` | Onboarding bonus | _____ |
| `agent_monthly_perf` | Monthly performance | _____ |
| `agent_deal_close` | Closed-deal recognition | _____ |
| `agent_prospecting` | Recruiting / prospecting (agent's client recruitment subsidy) | _____ |
| `agent_admin_stipend` | Admin / coordinator / marketing stipend | _____ |
| `agent_training` | Training / CE completion | _____ |
| `agent_holiday` | Holiday / anniversary | _____ |
| `agent_referral` | Recruit-an-agent referral | _____ |

Plus a free-text "Other (specify)" option per individual grant (lock #19) — firm describes the one-off reason at grant time. v1 does NOT let firms define new persistent categories.

### 3.6 — Marketing / homepage feature

| Field | Type | Required | Notes |
|---|---|---|---|
| Firm logo | image | optional | drives homepage feature, agent pages |
| Office photo | image | optional | |
| Tagline | text | optional | for directory listing |

### 3.7 — Referring partner

| Field | Type | Required | Notes |
|---|---|---|---|
| Referring partner code | text | optional | $500 sign-up bonus to named partner |

### 3.8 — Terms acceptance

| Field | Type | Required | Notes |
|---|---|---|---|
| Accept Terms of Service (firm version) | checkbox | yes | versioned |
| E-signature (typed full name of principal) | text | yes | matches 3.1 |
| Title / authority confirmation | text | yes | "I certify I am authorized to bind the firm" |
| Date acknowledged | auto | yes | server-set |

### 3.9 — Deferred to post-approval (NOT on Form B)

Same pattern as Form A — collected after manual review approves:
- EIN
- Owner / officer SSN(s) for KYC
- W-9
- Firm bank account / ACH (Stripe Connect)
- Firm license verification API check (before first payout)

---

## 4. Shared / cross-form

Things that apply to both Form A and Form B:

- **Customer-side webapp** (out of scope here): tenants, subscribers, owners earn/hold/redeem LYMX from any participating Business. Intake forms are for the Business side only.
- **Approval workflow:** all v1 applicants land in a manual review queue (lock #18). Pattern recognition + auto-approval comes later.
- **Once approved**, both forms produce the same downstream artifacts:
  - `businesses` row (with `business_kind`: `firm` | `storefront` | `agent_at_firm` | `self_employed`)
  - `business_locations` row(s)
  - `business_subscriptions` row (3-month trial)
  - `business_issuance_scenarios` row(s) (one per enabled scenario, see Section 5)
  - `firm_agent_links` row (only for `agent_at_firm`, FK to parent Firm — see Section 5)
  - `firm_agent_reward_config` rows (only for Firm, per-category default amount)
  - Optional `partner_commissions` row (if referring partner named) — $500 sign-up bonus credit
- **Both forms hit the same `business-signup` Edge Function**, with a discriminated union body schema:
  ```ts
  type SignupBody =
    | { kind: 'storefront', ... }
    | { kind: 'agent_at_firm', firm_id: uuid, license: {...}, scenarios: [...] }
    | { kind: 'self_employed', services: [...] }
    | { kind: 'firm', firm_type: '...', scenarios: [...], agent_rewards: {...} }
  ```

---

## 5. Schema implications

**Decision (locked):** Use **Option A — relational tables.** We need to query "all businesses with scenario X enabled" and surface per-scenario rates in the customer-facing app, so JSONB doesn't cut it.

### 5.1 — Migration 006 — Issuance scenarios + firm/agent linkage

```sql
-- Discriminator on businesses (additive)
alter table businesses
    add column business_kind text not null default 'storefront'
        check (business_kind in ('firm', 'storefront', 'agent_at_firm', 'self_employed'));

-- Per-business per-scenario issuance amount
create table business_issuance_scenarios (
    id uuid primary key default gen_random_uuid(),
    business_id uuid not null references businesses(id) on delete cascade,
    scenario_key text not null,        -- 'resi_buy_to_buyer', 'pm_renewal_to_owner', etc.
    enabled boolean not null default true,
    lymx_per_deal numeric not null,    -- fixed amount (lock #3)
    notes text,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    unique (business_id, scenario_key)
);
create index on business_issuance_scenarios (scenario_key) where enabled;
create index on business_issuance_scenarios (business_id);

-- Self-employed custom services (Form A Mode 3)
create table business_custom_services (
    id uuid primary key default gen_random_uuid(),
    business_id uuid not null references businesses(id) on delete cascade,
    service_name text not null,
    price_usd numeric,                 -- optional, informational
    lymx_per_booking numeric not null,
    enabled boolean not null default true,
    created_at timestamptz default now()
);

-- Firm <-> Agent linkage (Form A Mode 2 only)
create table firm_agent_links (
    id uuid primary key default gen_random_uuid(),
    firm_id uuid not null references businesses(id) on delete restrict,
    agent_id uuid not null references businesses(id) on delete cascade,
    license_number text not null,
    license_state text not null,
    license_expires_on date not null,
    license_verified_at timestamptz,    -- null until verified pre-payout (lock #17)
    practice_categories text[] not null default '{}',
    active boolean not null default true,
    created_at timestamptz default now(),
    unique (firm_id, agent_id)
);
create index on firm_agent_links (firm_id) where active;
create index on firm_agent_links (agent_id);

-- Firm's default agent-reward amounts per preset category
create table firm_agent_reward_config (
    id uuid primary key default gen_random_uuid(),
    firm_id uuid not null references businesses(id) on delete cascade,
    category_key text not null,         -- 'agent_onboarding' etc. (lock #15)
    default_lymx numeric,               -- nullable = firm hasn't set this category
    enabled boolean not null default true,
    created_at timestamptz default now(),
    unique (firm_id, category_key)
);

-- Actual reward grants from firm to agent (when firm clicks "Grant")
create table firm_agent_reward_grants (
    id uuid primary key default gen_random_uuid(),
    firm_id uuid not null references businesses(id) on delete restrict,
    agent_id uuid not null references businesses(id) on delete restrict,
    category_key text not null,         -- one of the 8 presets OR 'other'
    custom_reason text,                 -- required when category_key = 'other' (lock #19)
    lymx_amount numeric not null,
    granted_at timestamptz not null default now(),
    granted_by uuid,                    -- auth user who clicked Grant
    transaction_id uuid references transactions(id)
);
create index on firm_agent_reward_grants (firm_id, granted_at desc);
create index on firm_agent_reward_grants (agent_id, granted_at desc);
```

RLS policies follow the same pattern as the existing tables (firm sees its own rows, agent sees its links/grants where they're the recipient, service_role bypasses).

### 5.2 — Why this shape

- **One row per (event, recipient)** in `business_issuance_scenarios` matches lock #5 and keeps queries flat ("find all scenarios firing on a residential closing" = simple WHERE).
- **`firm_agent_links`** is a many-to-many in disguise (one agent could in principle hang at multiple firms, though we lock to one in v1 — schema doesn't preclude later).
- **Reward config vs grants** are separated so the firm can update its default amounts without rewriting historical grants.

---

## 6. Open questions / TODOs

- [ ] **Kenny review:** read sections 2 and 3 end-to-end and flag any field that's wrong, missing, or in the wrong mode.
- [ ] **Mode 2 inheritance:** when an agent signs up, do we auto-clone the firm's per-scenario rates as the agent's defaults (with the agent free to override), or start them blank? (Recommend: pre-fill from firm, agent can edit.)
- [ ] **Multi-license agents** (real estate AND insurance, or hanging at two firms): defer to v2 — v1 = one firm + one license per agent.
- [ ] **Firm with self-owned production arm** (eXp model): the firm can ALSO be its own first agent — handled by the firm signing up via Form B then re-signing the principal as Form A Mode 2. Confirm this is the v1 plan.
- [ ] **License-verification API**: which provider per state? Defer to first-payout flow design (lock #17 says hybrid).
- [ ] **Customer signup flow** (out of scope here): note that the intake design assumes the customer flow will resolve `customer_id` for issuance — track in a separate working doc.
- [ ] **Schema migration**: when ready to write code, this becomes migration `006_intake_forms.sql`. Check it doesn't conflict with `005_*` (whatever that ends up being).
- [ ] **Form rendering**: branched fields per mode = build with React state machine or one form per mode? (Recommend: one form, conditional rendering, single API call.)

---

*Document started 2026-05-03. Section 0 (locked decisions) closed 2026-05-04. Sections 1-6 drafted 2026-05-04 — pending Kenny review before code.*
