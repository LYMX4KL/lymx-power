# LYMX Business API — Integration Guide

> One-page spec for any business that wants to plug into the LYMX rewards
> network. This is what we'll send to InvestPro's developer, and to every
> future business that wants to integrate.

---

## 1. What this gets your business

When you send a customer (or a tenant, or an applicant) to LYMX, they:

1. Land on a co-branded page: `https://getlymx.com/welcome.html?biz=<your-slug>`
2. Create a free LYMX account (60 seconds — email + password)
3. Get their **welcome bonus credited instantly** to their wallet:
   - **100 LYMX from LYMX** (our customer-acquisition cost)
   - **50 LYMX from your business** (you get billed for this — see §5)
4. Start earning more LYMX at every LYMX Business they visit
5. Can spend their LYMX at any other LYMX Business (including yours)

For your business, this means:
- You're now part of a **shared loyalty network** instead of running your own program
- Every new LYMX customer becomes a sales opportunity — they can spend their LYMX at your business
- You get **attribution** — you'll see how many of your invitees signed up

---

## 2. Onboarding (one-time setup)

Send an email to `kenny@lymxpower.com` with:
- Your **business name** (legal + display)
- Your **logo URL** (PNG/SVG, transparent background, max 200×60px ideal)
- Your **primary brand color** (hex, e.g. `#1F4FC1`)
- Your **contact email** for invoicing

LYMX will:
- Assign you a **`<slug>`** (e.g. `investpro` for InvestPro Realty)
- Generate your **API key** (rotate any time via dashboard)
- Configure your **bonus split** (default: 100 LYMX from LYMX + 50 from you)
- Set your **billing rate** (default: 1¢ per LYMX, so 50 LYMX = $0.50)

---

## 3. The invite URL (what you put in your emails)

```
https://getlymx.com/welcome.html?biz=<your-slug>
```

For example, InvestPro Realty's URL is:

```
https://getlymx.com/welcome.html?biz=investpro
```

Drop that URL into your existing tenant / owner / customer invitation
emails. We handle everything from there: branded landing page, signup,
bonus crediting, attribution tracking.

### Optional: per-recipient tracking tokens

If you want to know exactly **which tenant** signed up (not just "someone from
InvestPro signed up"), append a token to the URL:

```
https://getlymx.com/welcome.html?biz=investpro&token=tenant_12345
```

The token is recorded in `signup_attributions.signup_token`, so you can later
query: "Did `tenant_12345` ever sign up?" That's the attribution model.

---

## 4. Anti-fraud rules (we enforce these)

To protect everyone from abuse — and to keep your billing predictable —
the LYMX network enforces:

1. **No self-issuance.** A business cannot issue LYMX to a wallet linked to
   its own owners or staff. (We track this via `business_partners.owner_user_ids`
   and `business_partners.blocked_email_domains`.)
2. **Idempotent issuance.** Re-running the same `idempotency_key` for the
   same business returns the original record — no duplicate bonuses.
3. **Velocity caps.** Max signups per hour per business (default: 100).
   Adjust per business as you grow.
4. **High-value flag.** Any single issuance ≥ 500 LYMX is auto-flagged
   for admin review.
5. **Repeat-to-same-wallet flag.** Repeat issuances to the same wallet
   within 7 days are flagged.
6. **Off-hours flag.** Issuances between midnight–6am Pacific are flagged.

Flagged issuances aren't blocked — they're routed to **admin review**.
Kenny approves them within a business day. If you're sending a legit bulk
batch, just let us know ahead of time and we'll raise your velocity limit.

---

## 5. Billing

We bill businesses **monthly in arrears** for all auto-approved issuances.

Example for InvestPro:
- 200 tenant/owner signups in month 1
- Each signup = 50 LYMX billed × $0.01 per LYMX = **$0.50 per signup**
- Month 1 invoice: **$100.00** (200 signups × $0.50)

We invoice on the 1st of each month for the prior month's activity.

You can see your real-time tally and unbilled balance at:
`https://getlymx.com/admin-businesses.html` (after we provision your account).

---

## 6. Programmatic API (optional, advanced)

If you want to issue LYMX programmatically — for example, on every rent
payment, not just signups — your dev can call:

### Endpoint

```
POST https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/business-signup-bonus
```

### Headers

```
Content-Type: application/json
X-LYMX-Api-Key: <your_api_key>
```

### Body

```json
{
  "user_id": "8d3e...",         // LYMX user_id of the customer
  "business_slug": "investpro",
  "idempotency_key": "rent-2026-05-tenant-123",
  "landing_url": "https://investprorealty.net/portal/rent-paid",
  "user_agent": "InvestPro/1.0"
}
```

For non-signup rewards (rent payments, etc.), you'll also need:

- A `reason` field (`transaction` instead of `signup_bonus`)
- A `transaction_id` field (your internal payment ID)
- A `transaction_amount_cents` field (so we can verify the LYMX/$ ratio is sane)
- An issuance rate (default 5 LYMX per $1, so a $1000 rent payment = 5000 LYMX)

Those endpoints will be added in API v2 (coming soon).

### Response (200)

```json
{
  "success": true,
  "issuance_id": "abc...",
  "amount_lymx": 150,
  "lymx_portion": 100,
  "business_portion": 50,
  "admin_status": "auto",
  "fraud_flags": [],
  "wallet_credited": true
}
```

### Failure modes

| Status | Meaning | What to do |
|---|---|---|
| `403` blocked | Recipient is on the business's owner/blocked list | Don't retry. Investigate. |
| `409` duplicate | Same `idempotency_key` already used | Re-fetch the original issuance. |
| `429` rate limit | Velocity cap exceeded | Slow down or request a higher cap. |
| `503` admin review | Flagged for manual review | Bonus will land within 1 business day. |

---

## 7. What happens if I send LYMX to my own staff/owner?

The system **blocks it at the database level**:

```
ERROR: FRAUD BLOCK: Cannot issue LYMX to a business owner
```

No bonus is credited. No billing is generated. The attempt is logged for
audit. If a customer ends up working for your business later, contact
Kenny to update the blocklist.

---

## 8. Questions / changes

- **Kenny Lin** — `kenny@lymxpower.com` (marketing) · `kenny.lin@getlymx.com` (transactional)
- **GitHub** — github.com/LYMX4KL/lymx-power
- **API status** — getlymx.com/api-status.html

This spec is versioned. Current version: **1.0** · Last updated: 2026-05-13
