# LYMX Redeem & Remit Plan — instant redeem, no per-transaction money rail
**Date:** 2026-05-31 · **Project:** LYMX Power (`apffootxzfwmtyjlnteo`)

> Companion to `project_lymx_instant_issue_redeem_model` (memory) and
> `14-Project Modules/reference/LYMX-BUSINESS-API-HANDOFF.md`.

---

## 1. The problem in one line
A customer redeems LYMX to pay down a business's bill. The redemption must show on
the **business's ledger/POS** so the customer pays less — **without** us touching the
business's code and **without** paying a third-party processor on every transaction.

## 2. The core truth (why there are only two real options)
You can only change a business's ledger balance two ways:
1. **Move real cash to them per redemption** (Stripe Connect transfer). → Rejected:
   per-transaction processor fees make it uneconomic.
2. **Send them a signal they post themselves** (a feed/statement their side reconciles
   into the ledger as a payment). → This is the model. ~Zero marginal cost; real cash
   nets once a month via the existing settlement rail.

So redemption is **not** a real-time money movement. It is an **instant internal credit
on our side + a published redemption record the business's side applies as a payment.**

## 3. Answering the two options you raised

**"Push data back via the same API?"** — No. Their API is **read-only by design**: they
expose, we pull. We never write into their system. The boundary stays clean and
symmetric: **each side exposes a read-only feed; the other side pulls it.**
- They expose their **fee feed** → we pull it → we issue LYMX.
- We expose a **redemptions feed** → they pull it → they post the payment.

**"Business account portal connects to their POS/ledger as a payment they accept?"** —
Yes, this is the *consumption* side of that same feed. The business treats **LYMX as a
tender type** ("paid by LYMX rewards"). Their POS/accounting reconciliation reads our
redemptions feed and **posts a LYMX payment against the matching invoice**, exactly the
way it would post a Stripe or cash payment. How each business consumes it is *their*
choice and *their* code (live API pull, scheduled statement import, or manual post in
the portal) — we provide the data and the portal view, never their integration.

**Recommendation:** the **symmetric read-feed** model. It mirrors earn exactly, costs
nothing per transaction, and keeps us 100% out of their code.

## 4. The flow (all LYMX-side unless noted)
1. **Connect to bill.** Customer enters/scans the invoice ref in their LYMX wallet (or
   LYMX pulls their open bills by customer-ref from the business feed on demand). We
   live-pull that transaction to confirm amount, that it's unpaid, and **identity-match**
   the wallet's legal name to the bill's customer (anti-fraud; no legal name = no redeem).
2. **Apply + deduct (instant).** Customer applies LYMX up to the full bill. We write a
   redemption row in the canonical ledger (negative `lymx_issuances`) — balance drops
   immediately. Value at face $0.01/LYMX.
3. **Credit the business (instant, internal).** We credit the redeemed dollars to the
   business's LYMX account ledger — what we owe them. No cash moves now.
4. **Publish to the redemptions feed (instant).** The redemption appears on our
   read-only `GET /…/redemptions?since=…` feed and in the business portal, keyed to the
   invoice ref.
5. **Business posts the payment (their side).** Their POS/ledger reconciliation reads the
   feed and applies a LYMX-tender payment to the invoice → invoice shows paid-down →
   customer pays only the remainder through the business's normal checkout.
6. **Net settle monthly (existing rail).** Real cash nets once a month: LYMX buys the
   redeemed units back from the business at $0.008/LYMX (the 20% gap vs face is the
   business's discount expense). One payout, not thousands. No per-transaction fee.

## 5. What we build (LYMX side) — proposed migrations + EFs
- **`business_redemptions` ledger** (or reuse `business_redeem_intents` + a settled
  state): one row per redemption — business_id, invoice/external_ref, customer, lymx_used,
  usd_cents, status, settlement_id.
- **`business_account_ledger`**: running credit of what LYMX owes each business from
  redemptions (feeds the monthly net settlement that already exists, mig 105/106).
- **`redeem` EF** (`business-redeem` / extend `business-redeem-intent`): connect→
  identity-match→deduct→credit→record. Synchronous, <1s.
- **`business-redemptions-feed` EF**: read-only `since`-cursor feed of redemptions for a
  business (api-key auth, mirror of how their fee feed works for us).
- **Business portal view**: redemptions list + export, so a business with no API can
  still apply them.
- **Reuses:** `lymx_issuances` (negative rows), Stripe Connect + `business-settlement-run`
  (105/106) for the monthly net, identity/legal-name + fraud-freeze guards from the handoff.

## 6. Open items to confirm before build
- **Legal-name uniqueness key** for one-wallet-per-person (legal name + phone + DOB?) —
  the linchpin of the negative-balance/anti-dup rule (handoff §10A).
- **Redemption cap** = up to full bill (confirmed 2026-05-31).
- **Reversal/refund** path when a redeemed fee is later refunded (clawback → possible
  negative balance; person earns back; cannot open a 2nd wallet to escape).
- **Per-business consumption**: for InvestPro specifically, their side re-enables a
  `lymx_redemptions` reconciliation (their code, not ours; `db/336` had dropped it).

## 7. Non-negotiables (carried from this session)
- We never touch a business's code. They expose read-only data; we pull and process.
- Business does nothing beyond exposing data + showing its bill + (its choice) consuming
  our redemptions feed.
- Issue + redeem settle instantly on our side; cron is reconciliation only.
- No per-transaction third-party money rail; cash nets monthly via existing settlement.
