# Stripe Connect setup — what to do in the Stripe dashboard

Date: 2026-05-17 · For Kenny (or Helen)

This guide gets the Stripe side of LYMX Connect wired up so businesses can connect their bank and receive payouts. Time: ~30 minutes.

---

## Why we need this

When a business approves a customer redemption (customer earned LYMX elsewhere, spent it here), LYMX owes that business actual USD. We pay them via Stripe Connect. We also charge businesses their $199/mo subscription via Stripe.

---

## Step 1 — Create / log in to your Stripe account

1. Go to https://dashboard.stripe.com/register (or login if you already have an account)
2. Sign up as **"LYMX Power Inc."** (or whatever the legal entity is)
3. Activate the account by providing business info Stripe asks for. This takes ~10 min and they may take 1-3 business days to verify.

**While waiting, you can develop in TEST MODE** — top-right toggle in the dashboard. Test mode lets you build the integration without real money or Stripe verification.

---

## Step 2 — Enable Stripe Connect

1. In the Stripe dashboard, go to **Connect** in the left sidebar (or https://dashboard.stripe.com/connect)
2. Click **"Get started"**. Pick:
   - Platform type: **"Direct charges + transfers"** or **"Destination charges"** — for LYMX we want **destination charges** (LYMX is the merchant of record, businesses are sub-merchants)
   - Country: **United States**
3. Fill in the platform profile. Stripe will ask for things like:
   - Platform name: **LYMX**
   - Platform URL: **https://getlymx.com**
   - Industry: **Rewards / loyalty program**
   - What you charge: **$199/month subscription + per-transaction billing**

---

## Step 3 — Get your API keys

1. In the dashboard, top-right: toggle to **Test mode** for now.
2. Go to **Developers → API keys** (or https://dashboard.stripe.com/test/apikeys)
3. Copy two values:
   - **Publishable key** (`pk_test_...`) — safe in frontend code
   - **Secret key** (`sk_test_...`) — DO NOT put this anywhere public

Once you're ready to go live (after Stripe verification), repeat in Live mode for `sk_live_...`.

---

## Step 4 — Add the secret keys to Supabase

1. Open https://supabase.com/dashboard/project/apffootxzfwmtyjlnteo/settings/functions
2. Scroll to **Edge Function secrets**
3. Add (one at a time, click "Save" after each):

   | Name | Value |
   |---|---|
   | `STRIPE_SECRET_KEY` | `sk_test_...` (or `sk_live_...` once live) |
   | `STRIPE_CONNECT_RETURN_URL` | `https://getlymx.com/biz-payouts.html?status=ok` |
   | `STRIPE_CONNECT_REFRESH_URL` | `https://getlymx.com/biz-payouts.html?status=refresh` |
   | `STRIPE_WEBHOOK_SECRET` | (we'll get this in step 6) |

---

## Step 5 — Deploy the new Edge Functions

These are in batch-16 (already pushed):

1. Go to **Edge Functions** in Supabase dashboard.
2. **For `stripe-connect-onboarding`:**
   - Click **+ Add new function**
   - Name: `stripe-connect-onboarding`
   - Paste contents of `LYMX Backend/functions/stripe-connect-onboarding/index.ts`
   - Click **Deploy**

3. **For `stripe-webhook`:**
   - Click **+ Add new function**
   - Name: `stripe-webhook`
   - Paste contents of `LYMX Backend/functions/stripe-webhook/index.ts`
   - Click **Deploy**

---

## Step 6 — Tell Stripe where to send webhooks

1. In Stripe dashboard, go to **Developers → Webhooks** (https://dashboard.stripe.com/test/webhooks for test mode)
2. Click **+ Add endpoint**
3. **Endpoint URL:** `https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/stripe-webhook`
4. **Listen to:** Click **+ Select events** → check:
   - `account.updated`
   - `account.application.deauthorized`
   - `invoice.paid`
   - `invoice.payment_failed`
5. Click **Add endpoint**
6. On the new endpoint's page, find the **Signing secret** (starts with `whsec_...`) — click **Reveal**, copy it.
7. Go back to Supabase Edge Function secrets, paste the `whsec_...` value into `STRIPE_WEBHOOK_SECRET`.

Repeat for **Connect events** specifically — Stripe has a separate Connect webhook section:
- https://dashboard.stripe.com/test/connect/webhooks
- Add the same endpoint, listen to `account.updated` and `account.application.deauthorized`

---

## Step 7 — Run migration 036

In Supabase SQL editor, paste from:
`https://raw.githubusercontent.com/LYMX4KL/lymx-power/main/LYMX%20Backend/migrations/036_stripe_connect.sql`

Or paste the content from `LYMX Backend/migrations/036_stripe_connect.sql` directly. Click Run.

Expected: `migration 036 applied | new_stripe_columns: 7`.

---

## Step 8 — Test it end-to-end (in test mode)

1. Open https://getlymx.com/biz-payouts.html signed in as a business owner whose application has been **approved**.
2. Click **"Connect Stripe →"**.
3. You'll be redirected to Stripe Connect's onboarding flow.
4. Use **Stripe test bank info**:
   - Routing: `110000000`
   - Account: `000123456789`
   - SSN: `000-00-0000` (test SSN)
   - Address: any US address
5. Submit. Stripe redirects you back to `biz-payouts.html?status=ok`.
6. The webhook fires `account.updated`, which writes `stripe_payouts_enabled=true` to the businesses row.
7. Reload `biz-payouts.html` — should show the green "Stripe payouts are LIVE" banner.

---

## What's still TODO (Phase 6 — not in this batch)

- **Charge the $199/mo subscription** — needs a Stripe Subscription created when business is approved. Today nothing is charged.
- **Auto-billing per-LYMX-issuance** — `business_billing` table from migration 012 tracks the cents owed, but no Stripe invoice is generated. Today this is manual.
- **Weekly transfer to businesses** — for redemptions. Today no transfers happen. Need a cron / scheduled function that aggregates `business_billing` (or a settlements table) and creates Stripe Transfer objects.

These three are the next build after Phase 5 lands.

---

## Troubleshooting

**"STRIPE_SECRET_KEY not configured"** — secret isn't set in Supabase. Step 4.

**Webhook signature failure (401 in logs)** — `STRIPE_WEBHOOK_SECRET` doesn't match. Check Step 6 again; signing secrets are different for test vs live, and different for the platform endpoint vs Connect endpoint.

**Stripe says "this country isn't supported"** — for non-US businesses we need to extend the Edge Function to accept a `country` param. v1 is US-only.

**"You don't own a business yet"** — biz-payouts.html requires `businesses.owner_user_id` to match the signed-in user. Make sure the test business signed up with the same email/account.

---

## Quick reference

- Stripe dashboard: https://dashboard.stripe.com
- Test cards: https://stripe.com/docs/testing
- Connect docs: https://stripe.com/docs/connect
- Our webhook endpoint: `https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/stripe-webhook`

— Kenny
