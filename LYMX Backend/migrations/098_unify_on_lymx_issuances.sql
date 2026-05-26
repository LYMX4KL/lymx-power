-- =============================================================================
-- Migration 098 — Module 5 of biz-onboarding roadmap: Unify on lymx_issuances
-- =============================================================================
-- Per audit § Step 6 / Module 5 — the LOAD-BEARING fix.
--
-- The audit found two parallel issuance pipelines:
--   - CANONICAL: lymx_issuances (51 production rows; v_my_lymx_balance reads it)
--   - ORPHAN:    transactions + wallets (0 rows; the original `issuance` EF
--                writes here, but nothing reads from these tables and they
--                require pre-existing wallet rows so the EF 404s in practice)
--
-- Module 5 unifies on lymx_issuances. This migration:
--
--   1. Expands `lymx_issuances.reason` CHECK to allow 'redemption'. Redemption
--      rows have NEGATIVE amount_lymx; `available_lymx` then naturally
--      subtracts them via SUM().
--
--   2. Updates `v_my_lymx_balance` to expose:
--      - `total_earned`     — sum of POSITIVE issuance rows (excluding redemption)
--      - `total_redeemed`   — sum of NEGATIVE redemption rows as positive int
--      - `available_lymx`   — net SUM(amount_lymx) over auto/approved rows
--      Keeps the existing bonus/pending/signup_count columns for back-compat.
--
--   3. Creates `customer_redemptions` backward-compat view so the customer
--      dashboard's hard-coded `fetch /rest/v1/customer_redemptions` queries
--      (3 of them per audit Phase 5) stop 404-ing and return a real list.
--
--   4. Adds an index on (business_id, idempotency_key) for fast EF idempotency
--      lookups on POS replays.
--
--   5. Comments the `transactions` and `wallets` tables as DEPRECATED. They
--      stay around so any FK references survive, but no new code writes to
--      them. A future migration will drop them once we confirm zero readers.
--
-- The issuance EF + redemption EF are rewritten alongside this migration to
-- write canonically to lymx_issuances.
-- =============================================================================

BEGIN;

-- ─── 1. Expand allowed reasons ──────────────────────────────────────────────
ALTER TABLE public.lymx_issuances
    DROP CONSTRAINT IF EXISTS lymx_issuances_reason_check;
ALTER TABLE public.lymx_issuances
    ADD  CONSTRAINT lymx_issuances_reason_check
    CHECK (reason IN (
        'signup_bonus',
        'transaction',
        'referral',
        'manual',
        'correction',
        'promo',
        'review',
        'redemption'    -- new in Module 5: NEGATIVE amount_lymx rows
    ));

-- ─── 2. v_my_lymx_balance — expose earned/redeemed/available cleanly ────────
-- The existing view (last touched in migration 091) computed `bonus_lymx`
-- with a reason whitelist that excluded 'redemption' — so redemption rows
-- would be invisible AND wouldn't subtract from the displayed balance.
-- The new view:
--   * `available_lymx` = SUM(amount_lymx) over auto/approved rows. With
--     negative redemption rows, this naturally yields the current spendable
--     balance.
--   * `total_earned`   = SUM where amount_lymx > 0 (everything they've ever
--     received).
--   * `total_redeemed` = -SUM where reason='redemption' (positive int).
--   * Existing columns retained so customer-dashboard.html keeps rendering.

CREATE OR REPLACE VIEW public.v_my_lymx_balance AS
SELECT
    li.recipient_user_id                AS user_id,
    -- Spendable balance — auto/approved rows only; redemption rows are negative
    -- and naturally subtract.
    COALESCE(SUM(li.amount_lymx) FILTER (WHERE li.admin_status IN ('auto','approved')), 0)::int  AS available_lymx,
    -- Module 5 additions
    COALESCE(SUM(li.amount_lymx) FILTER (WHERE li.amount_lymx > 0 AND li.admin_status IN ('auto','approved')), 0)::int AS total_earned,
    COALESCE(-SUM(li.amount_lymx) FILTER (WHERE li.reason = 'redemption' AND li.admin_status IN ('auto','approved')), 0)::int AS total_redeemed,
    -- Legacy columns kept for back-compat with customer-dashboard.html etc.
    COALESCE(SUM(li.amount_lymx) FILTER (WHERE li.reason IN ('signup_bonus','transaction','referral','manual','promo','correction','review')), 0)::int AS bonus_lymx,
    COALESCE(SUM(li.amount_lymx) FILTER (WHERE li.admin_status = 'pending_review'), 0)::int      AS pending_lymx,
    COUNT(*) FILTER (WHERE li.reason = 'signup_bonus')::int                                       AS signup_bonus_count,
    COUNT(*) FILTER (WHERE li.reason = 'redemption' AND li.admin_status IN ('auto','approved'))::int AS redemption_count,
    MIN(li.created_at)                  AS first_issued_at,
    MAX(li.created_at)                  AS last_issued_at,
    MAX(li.created_at) FILTER (WHERE li.reason = 'redemption' AND li.admin_status IN ('auto','approved')) AS last_redeemed_at
  FROM public.lymx_issuances li
 WHERE li.recipient_user_id = auth.uid()  -- single-user only; never expand
 GROUP BY li.recipient_user_id;

GRANT SELECT ON public.v_my_lymx_balance TO authenticated;

COMMENT ON VIEW public.v_my_lymx_balance IS
  'Single-user view of the current caller''s LYMX balance. available_lymx is the spendable total (negative redemption rows naturally subtract). total_earned + total_redeemed are exposed separately for dashboards that want to show both. SECURITY: filters strictly by auth.uid() — never exposes another user''s balance.';

-- ─── 3. customer_redemptions backward-compat view ───────────────────────────
-- Per audit Phase 5, customer-dashboard.html makes 3 calls to
-- /rest/v1/customer_redemptions — a table that doesn't exist. With Module 5
-- redemptions live in lymx_issuances WHERE reason='redemption'. Surface them
-- as a view named after the URL the page already fetches, with a clean
-- column shape, so the dashboard's "Spent this month" and "Lifetime visits"
-- stats stop returning 0 (the empty-catch behind the 404 was hiding it).

DROP VIEW IF EXISTS public.customer_redemptions CASCADE;
CREATE VIEW public.customer_redemptions
WITH (security_invoker = on)
AS
SELECT
    li.id,
    li.recipient_user_id            AS customer_user_id,
    li.business_id,
    li.issuing_user_id              AS processed_by_user_id,
    -- Redemption rows have negative amount_lymx; expose as positive.
    (-li.amount_lymx)::int          AS lymx_amount,
    li.transaction_amount_cents     AS usd_value_cents,
    li.transaction_method,
    li.idempotency_key,
    li.admin_status,
    li.admin_notes,
    li.created_at,
    li.updated_at
  FROM public.lymx_issuances li
 WHERE li.reason = 'redemption';

GRANT SELECT ON public.customer_redemptions TO authenticated;

COMMENT ON VIEW public.customer_redemptions IS
  'Backward-compat view for customer-dashboard.html / customer-history.html. Sits on top of lymx_issuances WHERE reason=''redemption''. amount_lymx in the underlying table is NEGATIVE; this view exposes it as POSITIVE for UI convenience. SECURITY INVOKER so RLS on lymx_issuances applies (customer sees their own only).';

-- ─── 4. Idempotency index ───────────────────────────────────────────────────
-- The issuance EF uses (business_id, idempotency_key) to dedupe POS replays.
-- Without an index, a busy POS could double-issue under concurrent retries.
CREATE INDEX IF NOT EXISTS lymx_issuances_biz_idempotency_idx
    ON public.lymx_issuances(business_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Unique constraint scoped to (business_id, idempotency_key) so concurrent
-- inserts collide instead of silently double-crediting. NULLs allowed
-- (legacy rows have idempotency_key set but the constraint is per-biz).
CREATE UNIQUE INDEX IF NOT EXISTS lymx_issuances_biz_idempotency_uniq
    ON public.lymx_issuances(business_id, idempotency_key)
    WHERE business_id IS NOT NULL AND idempotency_key IS NOT NULL;

-- ─── 5. Mark transactions + wallets as deprecated ───────────────────────────
DO $deprecation_comments$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname='transactions' AND relnamespace='public'::regnamespace) THEN
        EXECUTE $$COMMENT ON TABLE public.transactions IS
          'DEPRECATED 2026-05-26 by Module 5 of the biz-onboarding roadmap. Pre-Module-5 the `issuance` EF wrote here, but nothing read from this table. All issuance + redemption rows now live in public.lymx_issuances. This table is retained briefly so any latent FK references survive; a future migration will DROP it once we confirm zero readers.'$$;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname='wallets' AND relnamespace='public'::regnamespace) THEN
        EXECUTE $$COMMENT ON TABLE public.wallets IS
          'DEPRECATED 2026-05-26 by Module 5 of the biz-onboarding roadmap. The wallets table required pre-existing rows (404 on first transaction) and was never lazily created. Balance is now computed from lymx_issuances via v_my_lymx_balance. This table is retained briefly so any latent FK references survive; future migration will DROP it.'$$;
    END IF;
END $deprecation_comments$;

-- ─── 6. Sanity ──────────────────────────────────────────────────────────────
DO $sanity_098$
DECLARE
    v_constraint_ok boolean;
    v_view_def      text;
    v_redempt_view  boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname='lymx_issuances_reason_check'
           AND pg_get_constraintdef(oid) LIKE '%redemption%'
    ) INTO v_constraint_ok;
    SELECT view_definition INTO v_view_def
      FROM information_schema.views
     WHERE table_schema='public' AND table_name='v_my_lymx_balance';
    SELECT EXISTS (
        SELECT 1 FROM information_schema.views
         WHERE table_schema='public' AND table_name='customer_redemptions'
    ) INTO v_redempt_view;

    RAISE NOTICE 'Module 5 migration 098: constraint_ok=% view_has_total_earned=% customer_redemptions_view=%',
        v_constraint_ok,
        v_view_def IS NOT NULL AND v_view_def LIKE '%total_earned%',
        v_redempt_view;

    IF NOT v_constraint_ok THEN
        RAISE EXCEPTION 'Migration 098 failed: redemption not in reason CHECK';
    END IF;
    IF NOT v_redempt_view THEN
        RAISE EXCEPTION 'Migration 098 failed: customer_redemptions view did not create';
    END IF;
END $sanity_098$;

COMMIT;
