-- =============================================================================
-- Migration 100 — Module 5 follow-up: lymx_issuances constraint set
-- =============================================================================
-- Captures the three inline constraint changes that surfaced during Module 5
-- E2E verification (2026-05-26):
--
--   1. transaction_method CHECK — pre-Module-5 whitelist was {webhook, admin,
--      signup, manual}. POS issuance ('pos') and redemption flows ('redemption')
--      hit the constraint. Whitelist now includes pos, qr, app, review,
--      referral, redemption alongside the originals.
--
--   2. amount_lymx CHECK — pre-Module-5 implicit "must be > 0". Redemption rows
--      need NEGATIVE amount_lymx so SUM() naturally subtracts. New CHECK:
--      negative iff reason='redemption', positive otherwise.
--
--   3. business_id FK — pre-Module-5 referenced public.business_partners only.
--      Modern issuance EF passes public.businesses.id. Trigger
--      guard_lymx_issuance (migration 099) now validates against both tables;
--      the literal FK constraint is dropped so cross-table inserts succeed.
-- =============================================================================

BEGIN;

-- ─── 1. transaction_method whitelist ────────────────────────────────────────
ALTER TABLE public.lymx_issuances
    DROP CONSTRAINT IF EXISTS lymx_issuances_transaction_method_check;
ALTER TABLE public.lymx_issuances
    ADD  CONSTRAINT lymx_issuances_transaction_method_check
    CHECK (transaction_method IS NULL OR transaction_method = ANY (ARRAY[
        'webhook',
        'admin',
        'signup',
        'manual',
        'pos',          -- Module 5: POS issuance
        'qr',           -- QR scan flow
        'app',          -- in-app issuance
        'review',       -- review-bonus issuance
        'referral',     -- referral bonus
        'redemption'    -- redemption rows
    ]::text[]));

-- ─── 2. amount_lymx sign-by-reason ──────────────────────────────────────────
ALTER TABLE public.lymx_issuances
    DROP CONSTRAINT IF EXISTS lymx_issuances_amount_lymx_check;
ALTER TABLE public.lymx_issuances
    ADD  CONSTRAINT lymx_issuances_amount_lymx_check
    CHECK (
        (reason  = 'redemption' AND amount_lymx < 0)
        OR (reason <> 'redemption' AND amount_lymx > 0)
    );

-- ─── 3. Drop legacy business_id FK ──────────────────────────────────────────
ALTER TABLE public.lymx_issuances DROP CONSTRAINT IF EXISTS lymx_issuances_business_id_fkey;
-- (guard_lymx_issuance trigger from migration 099 validates business_id against
--  both public.businesses and public.business_partners — no DB FK needed.)

-- ─── Sanity ─────────────────────────────────────────────────────────────────
DO $sanity_100$
DECLARE
    v_method_ok boolean;
    v_amount_ok boolean;
    v_fk_gone   boolean;
BEGIN
    SELECT pg_get_constraintdef(oid) LIKE '%''pos''%' FROM pg_constraint
     WHERE conname = 'lymx_issuances_transaction_method_check'
    INTO v_method_ok;
    SELECT pg_get_constraintdef(oid) LIKE '%amount_lymx < 0%' FROM pg_constraint
     WHERE conname = 'lymx_issuances_amount_lymx_check'
    INTO v_amount_ok;
    SELECT NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'lymx_issuances_business_id_fkey'
    ) INTO v_fk_gone;

    RAISE NOTICE 'Module 5 migration 100: method_whitelist_has_pos=% amount_sign_by_reason=% legacy_fk_dropped=%',
        v_method_ok, v_amount_ok, v_fk_gone;

    IF NOT v_method_ok OR NOT v_amount_ok OR NOT v_fk_gone THEN
        RAISE EXCEPTION 'Migration 100 sanity failed (method=%, amount=%, fk_gone=%)',
            v_method_ok, v_amount_ok, v_fk_gone;
    END IF;
END $sanity_100$;

COMMIT;
