-- Migration 032: fix lymx_issuances column names in review→LYMX trigger
-- ---------------------------------------------------------------------------
-- Bug found during end-to-end test 2026-05-16:
-- The trigger fn_award_review_lymx (created in 030 / replaced in 031) inserts
-- into public.lymx_issuances using column names 'amount' and 'source', but the
-- real schema (from migration 012) uses 'amount_lymx' and 'reason'.
--
-- Approving a pending review silently rolled back the UPDATE because the trigger
-- raised "column does not exist".
--
-- This migration:
--   1. Adds 'review' as a valid value to the reason CHECK constraint.
--   2. Rewrites fn_award_review_lymx with correct column names + adds the
--      required lymx_cost_cents / business_cost_cents (both default 0 for now,
--      since review rewards are funded by LYMX, not by a business).
-- ---------------------------------------------------------------------------

-- ===== 1. extend the reason CHECK to include 'review' =====================
ALTER TABLE public.lymx_issuances
  DROP CONSTRAINT IF EXISTS lymx_issuances_reason_check;
ALTER TABLE public.lymx_issuances
  ADD CONSTRAINT lymx_issuances_reason_check
  CHECK (reason IN ('signup_bonus','transaction','referral','manual','correction','promo','review'));

-- ===== 2. rewrite the trigger with correct column names ===================
CREATE OR REPLACE FUNCTION public.fn_award_review_lymx()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  already_issued bigint;
BEGIN
  IF NEW.verification_status <> 'verified' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.verification_status = 'verified' THEN
    RETURN NEW;
  END IF;

  -- Idempotency guard: don't issue twice for the same review.
  SELECT COUNT(*) INTO already_issued
    FROM public.lymx_issuances
   WHERE recipient_user_id = NEW.reviewer_user_id
     AND reason            = 'review'
     AND transaction_id    = NEW.id::text;
  IF already_issued > 0 THEN RETURN NEW; END IF;

  INSERT INTO public.lymx_issuances (
    recipient_user_id,
    amount_lymx,
    reason,
    transaction_id,
    transaction_method,
    lymx_cost_cents,
    business_cost_cents,
    verified,
    admin_status
  )
  VALUES (
    NEW.reviewer_user_id,
    100,
    'review',
    NEW.id::text,
    'admin',
    0,    -- LYMX absorbs the cost — review rewards are platform-funded
    0,    -- no business billing for review rewards
    true,
    'auto'
  );
  RETURN NEW;
END $$;

-- (trigger itself was already created in migration 031, no need to recreate)

-- ===== 3. result ===========================================================
SELECT 'migration 032 applied' AS status,
       (SELECT COUNT(*) FROM pg_constraint
         WHERE conrelid = 'public.lymx_issuances'::regclass
           AND conname  = 'lymx_issuances_reason_check') AS check_constraint_exists;
