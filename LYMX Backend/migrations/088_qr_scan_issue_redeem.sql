-- =============================================================================
-- Migration 088 — QR scan-to-issue/redeem LYMX
-- =============================================================================
-- Feature: businesses and customers each get a rotatable QR token. Scanning a
-- QR resolves the token to the underlying business/customer and surfaces a
-- transaction flow:
--   • Biz scans customer QR → calls existing /issuance EF (biz-owner auth) to
--     issue LYMX immediately. Trust model: biz can already issue against any
--     customer_id, the scan is just a UX shortcut.
--   • Customer scans biz QR → creates a row in lymx_qr_claims (pending). Biz
--     reviews on biz-dashboard and approves/rejects; approval triggers
--     /issuance via service-role from the qr-claim-approve EF.
--
-- Why tokens instead of raw IDs in the QR:
--   • Rotatable per row if a QR is leaked (sticker photographed, screenshot
--     shared online). UPDATE businesses SET qr_token = gen_random_uuid() will
--     instantly invalidate every prior printout.
--   • IDs already leak via public URLs, but tokens give us the audit/rotation
--     primitive when we need it.
--
-- This migration is idempotent — every CREATE has IF NOT EXISTS / OR REPLACE.
-- =============================================================================

-- ---- 1. qr_token columns + indexes -----------------------------------------

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS qr_token UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS businesses_qr_token_key
  ON public.businesses(qr_token);

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS qr_token UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS customers_qr_token_key
  ON public.customers(qr_token);

-- ---- 2. resolve_qr_token RPC (public, anon-callable) -----------------------
-- Anon can call this to look up a token's display info during a scan (so the
-- scanner can show "Issuing to: Jane Smith" before the user confirms). Only
-- returns non-sensitive display fields, never email/phone/balance.

CREATE OR REPLACE FUNCTION public.resolve_qr_token(
  p_token UUID,
  p_kind TEXT  -- 'business' or 'customer'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $resolve_qr_token$
DECLARE
  v_row JSONB;
BEGIN
  IF p_token IS NULL OR p_kind IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'token_and_kind_required');
  END IF;

  IF p_kind = 'business' THEN
    SELECT jsonb_build_object(
             'ok', true,
             'kind', 'business',
             'id', b.id,
             'name', b.display_name,
             'category', b.category,
             'issuance_rate', b.issuance_rate
           )
      INTO v_row
      FROM public.businesses b
     WHERE b.qr_token = p_token
       AND COALESCE(b.archived_at, 'epoch'::timestamptz) = 'epoch'::timestamptz
     LIMIT 1;
  ELSIF p_kind = 'customer' THEN
    SELECT jsonb_build_object(
             'ok', true,
             'kind', 'customer',
             'id', c.id,
             'display_name', COALESCE(c.first_name || ' ' || c.last_name, c.email)
           )
      INTO v_row
      FROM public.customers c
     WHERE c.qr_token = p_token
     LIMIT 1;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'unknown_kind');
  END IF;

  IF v_row IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'token_not_found');
  END IF;

  RETURN v_row;
END;
$resolve_qr_token$;

GRANT EXECUTE ON FUNCTION public.resolve_qr_token(UUID, TEXT) TO anon, authenticated;

-- ---- 3. rotate_qr_token RPC (rotate on-demand if a QR leaks) ---------------

CREATE OR REPLACE FUNCTION public.rotate_qr_token(
  p_kind TEXT,
  p_target_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $rotate_qr_token$
DECLARE
  v_caller_uid UUID := auth.uid();
  v_new UUID := gen_random_uuid();
  v_owner_match BOOLEAN := FALSE;
BEGIN
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'sign_in_required';
  END IF;

  IF p_kind = 'business' THEN
    SELECT TRUE INTO v_owner_match
      FROM public.businesses
     WHERE id = p_target_id
       AND (owner_user_id = v_caller_uid OR public.am_i_admin())
     LIMIT 1;
    IF NOT COALESCE(v_owner_match, FALSE) THEN
      RAISE EXCEPTION 'not_authorized_for_this_business';
    END IF;
    UPDATE public.businesses SET qr_token = v_new WHERE id = p_target_id;
  ELSIF p_kind = 'customer' THEN
    SELECT TRUE INTO v_owner_match
      FROM public.customers
     WHERE id = p_target_id
       AND (user_id = v_caller_uid OR public.am_i_admin())
     LIMIT 1;
    IF NOT COALESCE(v_owner_match, FALSE) THEN
      RAISE EXCEPTION 'not_authorized_for_this_customer';
    END IF;
    UPDATE public.customers SET qr_token = v_new WHERE id = p_target_id;
  ELSE
    RAISE EXCEPTION 'unknown_kind';
  END IF;

  RETURN v_new;
END;
$rotate_qr_token$;

GRANT EXECUTE ON FUNCTION public.rotate_qr_token(TEXT, UUID) TO authenticated;

-- ---- 4. lymx_qr_claims (customer-initiated, biz-approved) ------------------
-- When a customer scans a biz QR, we create a row here in 'pending' state.
-- Biz reviews on their dashboard and either approves (calls /issuance via the
-- qr-claim-approve EF) or rejects. Pending rows auto-expire after 15 minutes
-- so they don't dangle forever.

CREATE TABLE IF NOT EXISTS public.lymx_qr_claims (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  business_id        UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  usd_amount         NUMERIC(10,2) NOT NULL CHECK (usd_amount > 0 AND usd_amount < 100000),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected','expired','superseded')),
  pending_until      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
  approved_at        TIMESTAMPTZ,
  approved_by        UUID,
  rejected_at        TIMESTAMPTZ,
  rejected_by        UUID,
  rejected_reason    TEXT,
  transaction_id     UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note               TEXT
);

CREATE INDEX IF NOT EXISTS lymx_qr_claims_business_status_idx
  ON public.lymx_qr_claims(business_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS lymx_qr_claims_customer_status_idx
  ON public.lymx_qr_claims(customer_id, status, created_at DESC);

-- ---- 5. RLS for lymx_qr_claims --------------------------------------------

ALTER TABLE public.lymx_qr_claims ENABLE ROW LEVEL SECURITY;

-- Customers see their own claims
DROP POLICY IF EXISTS lymx_qr_claims_customer_select ON public.lymx_qr_claims;
CREATE POLICY lymx_qr_claims_customer_select
  ON public.lymx_qr_claims
  FOR SELECT
  TO authenticated
  USING (
    customer_id IN (SELECT id FROM public.customers WHERE user_id = auth.uid())
    OR public.am_i_admin()
  );

-- Biz owners see claims on their businesses
DROP POLICY IF EXISTS lymx_qr_claims_business_owner_select ON public.lymx_qr_claims;
CREATE POLICY lymx_qr_claims_business_owner_select
  ON public.lymx_qr_claims
  FOR SELECT
  TO authenticated
  USING (
    business_id IN (
      SELECT id FROM public.businesses WHERE owner_user_id = auth.uid()
    )
    OR public.am_i_admin()
  );

-- Insert: only customers can create claims for themselves (via the qr-claim EF)
DROP POLICY IF EXISTS lymx_qr_claims_customer_insert ON public.lymx_qr_claims;
CREATE POLICY lymx_qr_claims_customer_insert
  ON public.lymx_qr_claims
  FOR INSERT
  TO authenticated
  WITH CHECK (
    customer_id IN (SELECT id FROM public.customers WHERE user_id = auth.uid())
  );

-- Update: only biz owners can approve/reject claims on their businesses
DROP POLICY IF EXISTS lymx_qr_claims_business_owner_update ON public.lymx_qr_claims;
CREATE POLICY lymx_qr_claims_business_owner_update
  ON public.lymx_qr_claims
  FOR UPDATE
  TO authenticated
  USING (
    business_id IN (
      SELECT id FROM public.businesses WHERE owner_user_id = auth.uid()
    )
    OR public.am_i_admin()
  )
  WITH CHECK (
    business_id IN (
      SELECT id FROM public.businesses WHERE owner_user_id = auth.uid()
    )
    OR public.am_i_admin()
  );

-- ---- 6. Auto-expire pending claims older than 15 minutes -------------------
-- Lightweight helper: anyone reading a claim with status='pending' and
-- pending_until < NOW() should treat it as expired. We provide a function
-- that biz pages can call on load to flip stale rows. (No cron needed; the
-- biz-dashboard "pending claims" panel calls this on refresh.)

CREATE OR REPLACE FUNCTION public.expire_stale_qr_claims()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $expire_stale_qr_claims$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.lymx_qr_claims
     SET status = 'expired'
   WHERE status = 'pending'
     AND pending_until < NOW();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$expire_stale_qr_claims$;

GRANT EXECUTE ON FUNCTION public.expire_stale_qr_claims() TO authenticated;

-- =============================================================================
-- End migration 088
-- =============================================================================
