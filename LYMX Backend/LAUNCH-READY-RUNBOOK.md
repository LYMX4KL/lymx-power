# Launch-ready runbook (2026-05-08)

> Step-by-step plan to go from "site is up + backend is deployed" to "Fellora + InvestPro Realty are live LYMX Businesses with real customer wallets and partner payouts." Estimated total work: 4–6 focused hours spread across 2–3 sessions.

## What's already done (today)

- ✅ Fix P0–P3 bugs from Dave's QA. Site live at https://getlymx.com.
- ✅ `lymx-config.js` + `lymx-auth.js` shared scripts in `LYMX Power/`.
- ✅ `login.html` wired to real Supabase Auth (sign-in tab + sign-up tab).
- ✅ `customer-dashboard.html` wired — fetches real wallet balance + recent activity from backend.
- ✅ `biz-dashboard.html` wired — fetches the Business name, this-month LYMX issued/redeemed, and unique customer count.
- ✅ All Sign-in pages route to `login.html` (no more auth bypass).

## Phase 0 — Paste the anon key (5 minutes, blocks everything else)

Until the anon key is in `lymx-config.js`, all the new wiring will fail with a clear console warning.

1. Open https://supabase.com/dashboard/project/apffootxzfwmtyjlnteo/settings/api
2. Find the **"anon public"** key (NOT `service_role`). It's safe to embed in client code.
3. Open `LYMX Power/lymx-config.js` in a text editor:
   ```js
   window.LYMX_CONFIG = {
     SUPABASE_URL: 'https://apffootxzfwmtyjlnteo.supabase.co',
     SUPABASE_ANON_KEY: 'REPLACE_WITH_ANON_KEY'   // ← paste here
   };
   ```
4. Same for `biz-signup.html` — search for `REPLACE_WITH_ANON_KEY` and paste the same key.
5. Push to GitHub (the Add file → Upload files flow we used today).

After Netlify deploys, sign-in / sign-up / dashboard data will start working live.

---

## Phase 1 — Onboard Fellora as a LYMX Business (15 minutes)

Fellora becomes a Business in the LYMX network. After this, customers can earn LYMX from Fellora purchases.

### Step 1.1 — Decide owner credentials

Pick:
- **Owner email:** the email you want to use to sign in as "Fellora's Business owner". Suggested: `business@thefellora.com` or `kenny+fellora@gmail.com` (Gmail+alias works).
- **Password:** strong, 10+ chars. Save in 1Password under "LYMX Business owner — Fellora".

### Step 1.2 — Run the signup

In PowerShell (after pasting the anon key in Phase 0):

```powershell
$ANON = "<paste anon key>"
$body = @{
  kind = "storefront"
  owner_email = "business@thefellora.com"
  owner_password = "<strong-password>"
  legal_name = "Fellora LLC"
  display_name = "Fellora"
  category = "ecommerce"
  contact_email = "hello@thefellora.com"
  contact_phone = "+1<phone>"
  issuance_rate = 5
  location = @{
    name = "HQ"
    street = "<your street>"
    city = "<city>"
    state = "<state>"
    zip = "<zip>"
  }
} | ConvertTo-Json -Compress

Invoke-RestMethod `
  -Uri "https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/business-signup" `
  -Method POST `
  -Headers @{ "Authorization" = "Bearer $ANON"; "apikey" = $ANON; "Content-Type" = "application/json" } `
  -Body $body
```

Expected response: `{ "user_id": "...", "business_id": "...", "location_id": "...", "subscription_id": "..." }`. **Save the `business_id` — you'll need it for the Fellora server-side code in Phase 3.**

### Step 1.3 — Verify

Sign in at https://getlymx.com/login.html with the email + password you just used. The page should redirect you to `biz-dashboard.html` with "Fellora" in the header and zeroed metrics. That confirms end-to-end auth + business lookup is working.

---

## Phase 2 — Onboard InvestPro Realty (15 minutes)

Same flow, different category.

```powershell
$body = @{
  kind = "storefront"
  owner_email = "business@investpro-realty.com"
  owner_password = "<strong-password>"
  legal_name = "InvestPro Realty LLC"
  display_name = "InvestPro Realty"
  category = "real_estate"
  contact_email = "hello@investpro-realty.com"
  contact_phone = "+1<phone>"
  issuance_rate = 5     # the actual conversion rule (5 LYMX per $100 of rent) is enforced server-side at issuance time, not via this rate
  location = @{
    name = "Main office"
    street = "<your street>"
    city = "<city>"
    state = "<state>"
    zip = "<zip>"
  }
} | ConvertTo-Json -Compress

Invoke-RestMethod `
  -Uri "https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/business-signup" `
  -Method POST `
  -Headers @{ "Authorization" = "Bearer $ANON"; "apikey" = $ANON; "Content-Type" = "application/json" } `
  -Body $body
```

Save the `business_id`.

> **Note on issuance rate for real estate:** the `issuance_rate` in the `businesses` table is a default; the actual LYMX issued per transaction is computed at `issuance` time from the request body. For Fellora (retail), `lymx_per_dollar = 5`. For InvestPro (rent), the public messaging is "5 LYMX per $100" — that's `lymx_per_dollar = 0.05` effectively. The frontend message stays "5 LYMX per $100" but the math at issuance time is `floor(usd_amount * 0.05)`.

---

## Phase 3 — Wire Fellora's checkout → LYMX issuance (60–90 minutes)

When a customer buys at thefellora.com, Fellora's Next.js server calls LYMX's `issuance` endpoint to credit the customer's LYMX wallet for that Business.

### Step 3.1 — Get a service-role-style auth token for server-to-server

Two options:

**Option A — use the LYMX Business owner's JWT** (cleaner, more auditable):
- After Fellora's Business owner signs in to `getlymx.com/login.html` once, capture the resulting JWT.
- Issue calls with `Authorization: Bearer <jwt>`.
- Tokens expire — refresh logic needed.

**Option B — use the LYMX `service_role` key** (simpler, no expiry):
- Find the service_role key at https://supabase.com/dashboard/project/apffootxzfwmtyjlnteo/settings/api
- Store as a Vercel/Netlify env var on Fellora's deployment: `LYMX_SERVICE_ROLE_KEY=eyJ...`
- Issue calls with `Authorization: Bearer <service_role>`.

Option B is recommended for v1.

### Step 3.2 — Add the issuance call to Fellora's checkout completion handler

In Fellora's Next.js repo (`Gemini/1-123partners/fellora/app/api/checkout/...` — wherever the order completion lives), add this server action:

```typescript
// app/api/checkout/lymx-credit/route.ts (or wherever your order completes)
async function creditLymxAfterPurchase(opts: {
  customerLymxUserId: string;          // the customer's LYMX auth.users.id (see "linking accounts" below)
  usdAmount: number;
  posExternalId: string;               // your order ID — used for idempotency
}) {
  const FELLORA_BIZ_ID = process.env.LYMX_FELLORA_BIZ_ID!;  // saved from Phase 1
  const LYMX_SERVICE_ROLE = process.env.LYMX_SERVICE_ROLE_KEY!;

  const res = await fetch(
    'https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/issuance',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LYMX_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        business_id: FELLORA_BIZ_ID,
        customer_user_id: opts.customerLymxUserId,
        usd_amount: opts.usdAmount,
        pos_external_id: opts.posExternalId,
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    console.error('[LYMX issuance] failed', err);
    // Don't block the order — log + retry async
    return { ok: false, error: err };
  }
  return { ok: true, result: await res.json() };
}
```

Call this after the order is confirmed paid (Stripe/PayPal webhook handler, or wherever your "order succeeded" code lives).

### Step 3.3 — Linking Fellora customer accounts to LYMX customer accounts

The harder problem: how does Fellora know the customer's `LYMX auth.users.id`?

**Simplest v1 approach — share the auth pool.** If Fellora is willing to use Supabase Auth on the same project, both apps share user IDs. You'd point Fellora's Supabase client at the LYMX project (or migrate Fellora to use it). One auth, two apps.

**v1.5 approach — per-customer link table.** Add a `customer_external_links` table on the LYMX side:
```sql
create table public.customer_external_links (
  customer_id uuid references public.customers(id) on delete cascade,
  partner_app text not null,                       -- 'fellora' | 'investpro'
  external_user_id text not null,
  linked_at timestamptz default now(),
  primary key (customer_id, partner_app)
);
```
Fellora calls a new edge function `link-external-customer` after a customer signs in for the first time, passing their Fellora user ID + LYMX OAuth code (one-tap "Connect your LYMX account" button on Fellora).

For v1 of launch, **stick with the share-auth approach** — fewer moving parts.

### Step 3.4 — Smoke test

In Fellora's checkout flow staging environment, simulate an order. Then verify:

```sql
-- Run in the LYMX Supabase SQL editor
select t.*, b.display_name as business
from public.transactions t
join public.businesses b on b.id = t.business_id
where b.display_name = 'Fellora'
order by t.created_at desc
limit 5;
```

You should see a fresh `issuance` row.

---

## Phase 4 — Wire InvestPro Realty rent → LYMX issuance (60–90 min)

Same pattern as Phase 3, but the trigger is rent collection in the InvestPro PM website (the property-management portal). When a tenant pays rent, the PM backend calls LYMX issuance.

```typescript
// In InvestPro PM's payment-completed handler:
await fetch('.../functions/v1/issuance', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${process.env.LYMX_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    business_id: process.env.LYMX_INVESTPRO_BIZ_ID,
    customer_user_id: tenant.lymxUserId,           // resolved via the shared-auth or link-table approach
    usd_amount: payment.usd_amount,
    pos_external_id: payment.id,                   // rent payment ID for idempotency
    lymx_per_dollar: 0.05                          // override the default 5/$1 with the 5/$100 rule
  }),
});
```

Note the `lymx_per_dollar: 0.05` override — that enforces "5 LYMX per $100 of rent."

---

## Phase 5 — Partner payouts (real money to partners)

The `settlement` Edge Function already bundles partner commissions into payable rows. What's missing is the actual money movement.

### Step 5.1 — Decide payment provider

| Option | Pros | Cons | Recommendation |
|---|---|---|---|
| **Stripe Connect** | Automated ACH to partner bank accounts. Standard for marketplaces. Handles 1099s. | $2/payout fee. KYC/onboarding for partners. | **Recommended for v1** |
| **Manual ACH via Mercury/Chase** | No fees per payout. | Manual work each cycle. Doesn't scale past ~25 partners. | OK for the Founding 25 only |
| **Virtual cards (Lithic/Marqeta)** | Instant. | More complex to integrate. | Defer to v2 |

### Step 5.2 — Stripe Connect integration plan

1. Create a Stripe account + enable Connect at https://dashboard.stripe.com/settings/connect
2. Choose **Express accounts** (Stripe-hosted onboarding for partners — they fill out their own KYC)
3. New migration `007_partner_payouts.sql`:
   ```sql
   alter table public.partners
     add column stripe_connect_account_id text,
     add column stripe_connect_onboarded_at timestamptz;
   ```
4. New endpoint `partner-payout-link` — generates a Stripe onboarding URL for the partner to set up bank info.
5. New endpoint `process-settlement-payout` — service-role only — iterates `settlements` rows for a payout cycle and issues Stripe transfers.
6. Add a "Payouts" section to `rep-dashboard.html` showing pending settlements + a "Connect bank account" CTA.

Estimated build: 4–6 hours. Worth doing properly because partner trust depends on getting paid reliably.

### Step 5.3 — Manual stopgap for the Founding 25

Until Stripe Connect is live, the manual flow is:

1. Run the existing `settlement` Edge Function each Monday for the prior week.
2. Export the resulting `settlements` rows as a CSV from the Supabase dashboard.
3. Use Mercury or Chase business banking to ACH each partner's amount.
4. Mark each row as `paid_at = now()` in the `settlements` table.

You can run this for the first 4–6 weeks while building the Stripe integration.

---

## Phase 6 — Pre-launch smoke test (60 min)

Run through this end-to-end checklist before announcing.

- [ ] **Customer signup** at /login.html → email arrives → confirm → land in /customer-dashboard.html → see "0 LYMX, no wallets yet"
- [ ] **First purchase at Fellora** → Fellora server calls issuance → LYMX wallet credit appears in customer-dashboard within 2 seconds
- [ ] **Second purchase at InvestPro** → another wallet appears (LYMX is non-transferable across Businesses, so 2 wallets)
- [ ] **Customer redemption at Fellora** → 80% rule enforced (max 80% of bill paid via LYMX)
- [ ] **Business signup** at /biz-signup.html → land in /biz-dashboard.html → metrics show real numbers
- [ ] **Partner referral** → partner signs up via /partner-signup.html → referral code is generated → Business signs up with that code → partner's commission row appears in `partner_commissions` table
- [ ] **Settlement** → run settlement function for current week → settlements row appears for the partner

---

## Phase 7 — Launch checklist

Once Phases 1–6 are green:

- [ ] Send Founding 25 partner invitations from `@lymxpower.com` cold-email infra (already set up — see `project_lymx_marketing_domains.md`)
- [ ] Make sure Fellora homepage links to `getlymx.com/customer-signup.html` ("Earn LYMX rewards on this purchase" CTA at checkout)
- [ ] Make sure InvestPro Realty homepage same
- [ ] Stripe Connect onboarding emails go out to first wave of partners
- [ ] Set up basic monitoring: Supabase log alerts on Edge Function error rates, Netlify deploy notifications
- [ ] First press release / blog post / social posts ready to go

---

## Quick reference — what's where

| Concern | Location | Notes |
|---|---|---|
| Frontend deploy | https://getlymx.com via Netlify | Auto-deploys from `LYMX4KL/lymx-power` `main` |
| Backend / database | https://supabase.com/dashboard/project/apffootxzfwmtyjlnteo | Pro tier |
| Edge Functions | Same Supabase dashboard → Functions | `business-signup`, `customer-wallet-create`, `issuance`, `redemption`, `transfer`, `settlement`, partner-email triplet |
| Migrations | `Gemini/LYMX Backend/migrations/` | Run in numeric order via Supabase SQL editor |
| Anon key | Supabase Settings → API | Public, safe to embed in client code |
| Service-role key | Same page | **Server-only**. Never put in frontend code or commit to git |
| Email infrastructure | Cloudflare + AWS SES + Resend (Fellora account) | See `PARTNER-EMAIL-SETUP.md` |
| Partner email auto-provision | `partner-provision-email` Edge Function | Auto-creates `firstname.lastname@getlymx.com` for new partners |

If anything in this runbook is unclear, the canonical README is `Gemini/LYMX Backend/README.md`.
