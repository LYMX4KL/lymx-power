-- Migration 036: Stripe Connect payouts wiring
-- ---------------------------------------------------------------------------
-- Phase 5 of LAUNCH-READY-RUNBOOK. Adds the columns needed to track each
-- Business's Stripe Connect Express account state.
--
-- Two directions of money:
--   1. Business → LYMX: monthly subscription ($199/mo after 3-mo trial) +
--      per-LYMX-issuance billing ($0.01 per LYMX they issued).
--      Charged via Stripe Subscriptions / Invoices.
--   2. LYMX → Business: customer redemptions (when a customer uses LYMX
--      earned elsewhere at this Business). Paid via Stripe Connect transfers.
--
-- This migration only adds schema. Edge Functions + UI are in batch-16:
--   * stripe-connect-onboarding: creates an AccountLink for a Business owner
--   * stripe-webhook: receives account.updated + invoice.* events
--   * biz-payouts.html: the page a Business owner lands on to connect Stripe
-- ---------------------------------------------------------------------------

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id text,
  ADD COLUMN IF NOT EXISTS stripe_customer_id        text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id    text,
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_details_submitted  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_last_synced_at     timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_businesses_stripe_connect ON public.businesses(stripe_connect_account_id) WHERE stripe_connect_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_businesses_stripe_payouts_enabled ON public.businesses(stripe_payouts_enabled) WHERE stripe_payouts_enabled = false;

-- ===== Stripe webhook event log (for replay + debugging) ===================
CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text NOT NULL UNIQUE,
  event_type      text NOT NULL,
  account_id      text,
  payload         jsonb NOT NULL,
  processed_at    timestamptz,
  processing_error text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_unprocessed ON public.stripe_webhook_events(processed_at) WHERE processed_at IS NULL;

-- ===== RLS ==================================================================
-- Owner can read their own business's Stripe state (already in scope of existing biz RLS)
-- Admin can read webhook events
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stripe_webhook_admin ON public.stripe_webhook_events;
CREATE POLICY stripe_webhook_admin ON public.stripe_webhook_events
  FOR SELECT TO authenticated USING (public.am_i_admin());

GRANT SELECT ON public.stripe_webhook_events TO authenticated;

-- ===== Result ==============================================================
SELECT 'migration 036 applied' AS status,
       (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_schema='public' AND table_name='businesses'
           AND column_name LIKE 'stripe_%') AS new_stripe_columns;
