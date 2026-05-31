# Stripe Live Launch — Timeline + Dependencies

**Status as of 2026-05-17:** Code shipped. Schema in place. **NOT yet live** — blocked on bank/EIN/Stripe approvals.

---

## The blocking dependencies (in order)

### 1. Helen — business bank account for LYMX Power Inc.
- Whatever bank you're going with, the account must be:
  - In the legal name of **LYMX Power Inc.** (or whatever the registered entity name is)
  - Tied to the EIN (not Kenny's personal SSN)
  - Eligible for ACH receive (almost all US business accounts are)
- **Time:** 1–5 business days depending on the bank
- **Kenny:** email Helen the checklist below (drafted further down this doc)

### 2. Kenny — EIN if not already in hand
- If LYMX Power Inc. is incorporated but has no EIN: apply at https://www.irs.gov/businesses/small-businesses-self-employed/apply-for-an-employer-identification-number-ein-online
- Takes ~10 min online, free. Get the EIN immediately on submission.
- **Time:** <1 hour, today

### 3. Kenny — create Stripe account
- Go to https://dashboard.stripe.com/register
- Sign up as "LYMX Power Inc." — use:
  - Business name: LYMX Power Inc.
  - EIN: (the one from step 2)
  - Bank: (the one from step 1, when ready)
  - Owner identity: your driver's license or passport
- Stripe verifies the business — **3 to 7 days** typically.
- **You can develop in TEST MODE while waiting** — but real money / real payouts requires this verification to complete.

### 4. Kenny — apply for Stripe Connect platform approval
- THIS IS THE LONGEST POLE.
- LYMX is a **platform** (we pay other businesses, not just charge customers), so Stripe requires a separate platform application.
- After your business account is verified, go to: https://dashboard.stripe.com/connect/applications/new
- Submit the application using the copy in this doc (drafted below)
- Approval timeline: **1–2 weeks** typical for a marketplace like LYMX. Could be longer if Stripe asks for follow-up info (be ready to respond fast).

### 5. Kenny — configure Stripe in Supabase (the 30-min step)
- After Connect approval, follow STRIPE-SETUP-GUIDE.md on your Desktop:
  - Get sk_live_... and add as STRIPE_SECRET_KEY in Supabase Edge Function secrets
  - Configure webhook in Stripe dashboard pointing at /functions/v1/stripe-webhook
  - Add the whsec_... value as STRIPE_WEBHOOK_SECRET
- Edge Functions are already deployable (in batch-17).

### 6. Smoke test with one real business
- Have one Founding 25 business (Brew & Bean? InvestPro?) try the Stripe connect flow with REAL bank info.
- Confirm:
  - Connect onboarding completes
  - The account.updated webhook fires
  - businesses.stripe_payouts_enabled flips to true
  - biz-payouts.html shows the green "live" state

### 7. Open the floodgates
- Email all approved businesses with the Stripe Connect link
- Add a homepage banner: "Stripe payouts now live"

---

## Total realistic timeline

**Optimistic (everything goes smoothly):** 8 days from today
**Realistic:** 14–21 days from today

What's outside our control: bank verification time, Stripe identity verification, Stripe Connect application approval. These are not optimizable.

What we DO control: how fast Helen + Kenny finish their pieces, and how completely we answer Stripe's questions when they ask.

---

## Drafts you can send today

### Email to Helen (subject: LYMX bank account — checklist to unblock Stripe)

```
Hi Helen,

We need the LYMX Power Inc. business bank account fully set up before we can flip on Stripe payouts. Here's exactly what we need:

THE ACCOUNT
  • Account name: LYMX Power Inc. (in the legal entity name, NOT in Kenny's personal name)
  • Account type: Business checking
  • EIN tied to the account: (whatever LYMX Power Inc.'s EIN is — if we don't have one yet, I'll apply for it today and send it over)
  • Capabilities needed:
      - Receive ACH (almost all US business checking accounts have this)
      - Routing + account number that we can paste into Stripe

WHEN YOU'RE DONE
Send me the routing number + account number via a secure channel (Signal, encrypted email — NOT plain Gmail).

WHY IT MATTERS
Without this account, Stripe won't approve our merchant verification, and we can't accept money from businesses or pay them out for redemptions. This is the single biggest blocker between us and revenue.

Timeline matters: even after the bank is open, Stripe takes 3–7 days to verify, then 1–2 weeks for their Connect platform application. Every day matters.

If your bank wants tax filings, articles of incorporation, or other paperwork, let me know what's missing and I'll send it.

Thanks,
Kenny
```

### Stripe Connect platform application copy (paste into the Stripe form)

```
PLATFORM NAME
LYMX

WEBSITE
https://getlymx.com

WHAT YOUR PLATFORM DOES
LYMX is a customer loyalty rewards network. Customers earn LYMX (a redeemable loyalty credit, 1 LYMX = $0.01) at participating local businesses, then spend those LYMX at ANY participating business on the network. We are not a bank, not a payment processor, and not a stored-value account — LYMX is a promotional rewards instrument governed by network participation rules.

HOW STRIPE CONNECT FITS IN
We use Stripe Connect to:
  1. CHARGE businesses a $199/month subscription + per-LYMX-issued fees ($0.01 per LYMX they award their customers). Standard Stripe Subscriptions + Invoices.
  2. PAY businesses USD when a customer who earned LYMX elsewhere redeems those LYMX at their store. Stripe Connect Transfers, settled weekly.

We are using DESTINATION CHARGES. LYMX is the merchant of record for end-customer interactions; connected businesses receive transfers from us.

CONNECTED ACCOUNT TYPE
Stripe Express (with onboarding via AccountLink). Connected accounts are small US-based local businesses (cafes, retail, EV charging, real estate, salons).

EXPECTED VOLUME (first 12 months)
  • Year 1 conservative: 25 connected businesses, $50K total volume
  • Year 1 stretch: 100 connected businesses, $250K total volume

PROHIBITED CATEGORIES
We do NOT onboard: adult content, gambling, firearms, regulated cannabis (we may add cannabis-friendly businesses if Stripe allows in a later phase), or any business prohibited by Stripe's Restricted Businesses list. Vetting happens via our admin approval workflow (admin-business-applications.html).

CUSTOMER FUNDS
LYMX does NOT hold customer money. Customers don't deposit USD with LYMX; they earn LYMX from real business transactions and redeem them at other businesses. Stripe's role is purely to settle the inter-business cash flow.

DISPUTE HANDLING
Customer disputes about LYMX rewards (e.g., "I didn't get the LYMX I was promised") are handled by LYMX directly through our feedback portal. Stripe-side chargebacks (which would be rare; we don't charge customers directly) go to LYMX as the merchant of record on the original Business invoice.

POINT OF CONTACT
  • Kenny Lin · kenny@lymxpower.com · Founder
  • Helen Chen · helen@getlymx.com · CFO (finance + compliance)
```

---

## What I shipped today to make the wait easier

- `biz-payouts.html` now shows a clear "Coming soon — waiting on Stripe approval (1–2 weeks)" banner so approved businesses see the right thing when they navigate to Payouts.
- The Stripe Edge Function code is in GitHub, ready to deploy the day live keys are configured. No more code work blocks the launch.
- `STRIPE-SETUP-GUIDE.md` on your Desktop has the exact 8-step procedure for the day Stripe approves us.

— Kenny
