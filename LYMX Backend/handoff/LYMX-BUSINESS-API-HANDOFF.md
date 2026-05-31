# LYMX Business Integration API — Handoff (for partner/business engineering teams)

> **Audience:** an external business's engineering team (first consumer: InvestPro PM) building the integration that connects their platform to LYMX.
> **This API is GENERIC** — it is not InvestPro-specific. Any business pushes events to the same contract. InvestPro is just the first.
> **Status:** proposed contract. The LYMX side is being built in parallel; build to this contract so both sides connect cleanly. Open decisions are flagged ⚠️ — resolve before coding.
> Last updated: 2026-05-30.

## 1. The model in one paragraph

LYMX is a central clearing-house rewards network. A business **issues** LYMX to a customer when an "earn event" happens (a fee paid, a signup, a promo), and customers **redeem** LYMX back at the business for value. The business never stores LYMX balances — **LYMX is the system of record**. Your platform pushes events to LYMX's API; LYMX applies the business's configured rules and tracks every balance. At month end LYMX settles in cash with each business. **1 LYMX = $0.01 face value (fixed, never changes).**

## 2. What YOU build vs what LYMX provides

| You (the business) build | LYMX provides |
|---|---|
| Call our API when an earn event occurs (fee paid, agent/vendor signup, promo) | The inbound API + idempotent issuance |
| Send us the customer identity (email/phone) + event type + amount | Per-business rule config (set on LYMX via an intake form — you do NOT build config) |
| Initiate redemptions and apply the returned discount to your invoice/fee | The redemption consent handshake + balance checks |
| Reconcile against our monthly settlement statement | Monthly settlement (cash net via Stripe Connect) |

**You do NOT** compute LYMX amounts, store balances, or decide rates — you send events; LYMX computes per the business's approved config.

## 3. Configuration (done on the LYMX side — context only)

Each business has an **earn-event catalog** configured on LYMX (via an intake form a Partner fills in and the owner approves). Each catalog entry = an `event_type` key + how much it earns (`lymx_per_dollar` and/or `flat_lymx`) + whether it's `redeemable`. The catalog is **extensible** — new event types (promotions, new fee kinds, referral bonuses) are added on LYMX without an API change. **Your integration just sends an `event_type` string that matches a configured, approved entry.** If you send an unconfigured/unapproved `event_type`, the event is rejected with a clear error.

Examples of `event_type` (InvestPro): `fee_admin`, `fee_pm`, `fee_late`, `fee_application`, `agent_signup`, `vendor_signup`, `promo_*`. (`fee_pm` earns but is non-redeemable.)

## 4. Auth

Every request authenticates with the business's **API key** in a header:
```
Authorization: Bearer <SUPABASE_ANON_KEY>
x-lymx-api-key: <your business api_key>     ⚠️ (final header name TBD on LYMX side)
Content-Type: application/json
```
The api_key maps to your `business_partners` row. Keep it server-side; never expose it in a browser.

## 5. Endpoints (proposed contract)

### 5.1 Earn — `POST /functions/v1/business-event`
Call when an earn event occurs.
```jsonc
{
  "event_type": "fee_admin",            // must match an approved catalog entry
  "amount_usd": 200.00,                 // omit/0 for flat events (e.g. agent_signup)
  "customer": {                          // who earns
    "email": "tenant@example.com",
    "phone": "+1702...",                // at least one identifier required
    "external_id": "ip-tenant-12345"    // your stable id for this person
  },
  "external_ref": "ip-ledger-entry-998877",  // YOUR unique id for this event (idempotency)
  "occurred_at": "2026-05-30T18:00:00Z"
}
```
Response:
```jsonc
{ "ok": true, "lymx_issued": 1000, "status": "issued" }      // wallet found + (if required) identity matched
// or  — NO wallet yet: nothing is issued; invite them to join LYMX
{ "ok": false, "status": "no_wallet", "invite_url": "https://getlymx.com/signup?ref=..." }
// or
{ "ok": false, "error": "identity_mismatch" | "event_type_not_configured" | "duplicate" | "wallet_missing_legal_name" }
```
- **Idempotent on `external_ref`** — safe to retry; a repeat returns the original result, never double-issues.
- **Identity match (⚠️ per-business):** for property-management, LYMX requires the wallet owner to match the tenant (matched by email/phone). For retail, no match is required — LYMX credits the presented wallet and relies on anti-fraud. Your platform tells LYMX which mode applies via the business config, not per call.

### 5.2 Redeem — two-step consent handshake (customer must approve)
A business **cannot** unilaterally spend a customer's LYMX. The customer must consent (scan or password-verify). Proposed flow:
1. `POST /functions/v1/business-redeem-intent` `{ customer:{...}, event_type:"fee_admin", max_lymx: 5000, external_ref }` → returns `{ intent_id, approve_url, expires_at }`.
2. You send the customer to `approve_url` (LYMX-hosted) where they log in / password-verify and approve the amount.
3. On approval, LYMX deducts the LYMX and calls your webhook (or you poll `GET .../business-redeem-intent/{intent_id}`) → `{ status:"approved", lymx_used: 1500, discount_usd: 15.00 }`.
4. You apply `discount_usd` to the fee/invoice. **Non-redeemable event types (e.g. `fee_pm`) are rejected.**

### 5.3 Reverse / refund — `POST /functions/v1/business-event-reverse`
`{ external_ref, reason }` → claws back LYMX issued for that event (refunds, chargebacks, voided fees). ⚠️ Define behavior if the customer already spent the earned LYMX.

### 5.4 Balance lookup — `POST /functions/v1/business-customer-balance`
`{ customer:{email|phone} }` → `{ balance_lymx, exists }` (with consent rules). Use to show "you have X LYMX" in your UI.

## 6. Settlement (how the business gets paid)

Per the LYMX clearing house: a business **buys** LYMX it issues at **$0.008/LYMX** (80% of face), and **sells back** redeemed LYMX at **$0.008/LYMX**. Net per calendar month, settled the first business day of the next month via Stripe Connect (LYMX pays you if net positive, invoices you if net negative). ⚠️ **Discount economics:** a customer redeeming 100 LYMX gets $1.00 of value, but you recover $0.80 on buyback — the **$0.20 (20%) gap is your discount expense.** Confirm your fee-discounting math accounts for this.

## 7. Open decisions to resolve before build (⚠️)

1. **Redemption consent UX:** hosted `approve_url` (recommended, OAuth-like) vs customer-generated one-time redeem code entered on your side.
2. **Identity-match key + mismatch handling:** match on email, phone, or both; on mismatch → reject, or hold for manual review?
3. **Unclaimed earns:** confirm `pending_claim` (earn held by email/phone, credited when the person makes a LYMX wallet) — needed because new agents/vendors won't have a wallet yet.
4. **Reversal after spend:** how to handle a refund when the earned LYMX was already redeemed (negative balance? clawback at settlement?).
5. **Redemption value to customer:** face $0.01 (you eat 20%) vs $0.008 (customer gets buyback value). Affects your discount math.
6. **Anti-fraud caps on the API path:** per-customer/day, per-event amount caps, velocity (existing `max_signups_per_hour`, `blocked_email_domains`, `owner_user_ids` hard-block) — confirm they apply here.
7. **Header name + versioning** for the api_key and endpoints.

## 8. First rollout (InvestPro)

Earn on tenant ledger fees (`fee_admin`, `fee_late`, `fee_application`, `fee_pm`), agent + vendor signup (`agent_signup`, `vendor_signup`), expandable to promos. All redeemable **except `fee_pm`** (which still earns). Identity-match REQUIRED (wallet owner = tenant/agent). The PM-fee 50/50 landlord/tenant split stays entirely on InvestPro's side — send LYMX whichever portions were actually paid.

## 9. RESOLVED decisions + hard rules (Kenny, 2026-05-30) — supersede §7

1. **No wallet → no LYMX (no holding).** If the customer has no LYMX wallet at event time, the business issues **nothing**. The API returns `no_wallet` + an `invite_url`; the business reminds/invites the person to sign up for LYMX so they can earn next time. (The earlier `pending_claim` idea is dropped.)
2. **Remote / ecommerce is the target** — not in-person. The redemption consent is a **hosted online approve flow** (customer clicks a LYMX link, logs in / password-verifies, approves the amount). Build for online businesses, not POS scans.
3. **Discount economics ($0.01 face, business recovers $0.008 → business eats 20%) is disclosed on the LYMX website.** The **intake form is sent only AFTER the business signs the contract and pays the signup fee.** So config (catalog + rates) is gated behind contract-signed + fee-paid, then Partner fills → owner approves → live.
4. **Every wallet must carry a real LEGAL NAME.** Wallets are reminded to set/update their legal name **once** (self-service, to avoid manual verification). A wallet **missing a legal name cannot redeem** (`wallet_missing_legal_name`). At redemption a business may ask for proof of ownership; the wallet's legal name must match the customer's ID. This is core anti-fraud.
5. **Reversals/refunds may drive a balance NEGATIVE.** Because identity is pinned to a real legal name, a clawback after the LYMX was already spent leaves a negative balance; the person earns their way back. They **cannot open a second wallet to escape repayment** — enforced by one-wallet-per-person. ⚠️ **New gap:** legal name alone is not unique — uniqueness must be **legal name + phone (and/or DOB)**; define the exact key that blocks a duplicate wallet, else the negative-balance rule is dodgeable.
6. **Collusive-issuance fraud — must gate (high priority).** Pattern: a business fakes transactions, buys + issues LYMX to its own family/insiders, who then **redeem at a DIFFERENT business** — the redeeming business eats the 20%. This is theft from other businesses.
   - **Contractual:** the business contract includes a fraud clause — LYMX has the right to **sue and recover**. (Add to contract.)
   - **Technical signals to monitor:** issuance concentrated to a few recipients, recipients on the issuer's `blocked_email_domains` / `owner_user_ids`, rapid issue-then-redeem-elsewhere, abnormal velocity. Hold/settle-freeze suspicious issuance before month-end payout. ⚠️ **Build a fraud-review hold** so suspicious issuances don't settle until cleared.

## 10. New gaps surfaced by these decisions (resolve before build)
- **A. One-wallet-per-person key** (#5): legal name + phone + DOB? This is the linchpin of the negative-balance + anti-dup model.
- **B. Invite delivery** (#1): does LYMX email the invite, or just return `invite_url` for the business to show? (Default: return the link.)
- **C. Fraud-hold mechanics** (#6): which signals trigger a hold, who reviews, and how it interacts with the monthly settlement freeze.
- **D. Legal-name backfill** (#4): existing wallets created without a legal name must be prompted and blocked from redemption until set — confirm the reminder + gate.

## 11. Redemption channels, claim window & fraud verification (2026-05-30 — refines §9)

**Two redemption channels (build BOTH):**
1. **Hosted-API consent (ecommerce / has a backend, e.g. InvestPro):** §5.2 — business calls redeem-intent, customer approves on a LYMX-hosted page, business applies the discount.
2. **In-app scan + owner-confirm (small business, NO POS/API):** the business owner uses the **LYMX app** to (a) **scan the customer's wallet QR** to connect, (b) **scan/capture the receipt** of the underlying purchase, (c) **confirm** the redemption. The owner MUST confirm because the business bought those LYMX and is selling the redeemed units back to LYMX for real cash. Customer presenting their wallet QR = their consent; owner confirm = approval of the sell-back. (Builds on the mig-088 QR + lymx_qr_claims flow.)

**No-wallet → 24-hour claim window (refines §9.1):** when an earn event hits a person with no wallet, LYMX creates a **provisional claim held for 24 hours** and returns a **reminder/claim link**. Every business gets reminder links to nudge eligible customers; if the person signs up within 24h, the LYMX is credited; after 24h it's **forfeited** (the business is billed only if claimed). Purpose: urgency that grows wallets → more wallets attract more businesses → more businesses attract more wallets (flywheel).

**Fraud freeze (refines §9.6):** a frozen/suspicious issuance is cleared only by **in-person admin verification**. This is treated as serious — it protects both the platform and the businesses, because issuance is paid for by the business and redeemed units are bought back for real money. Suspicious issuances do NOT settle until an admin verifies in person.
