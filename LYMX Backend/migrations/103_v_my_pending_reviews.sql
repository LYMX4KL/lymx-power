-- =============================================================================
-- Migration 103 — Module 8: v_my_pending_reviews (Pending Reviews customer view)
-- =============================================================================
-- 2026-05-26 (session pt3, after Cluster A/C drain).
--
-- WHY THIS MIGRATION EXISTS
-- ----------------------------------------------------------------------------
-- Today customer-dashboard.html shows a "Pending reviews" card with HARDCODED
-- placeholder rows ("Brew & Bean Café · Visited yesterday · earn +100 LYMX",
-- plus 2 more). Late JS replaces these with a "no visits waiting" empty state,
-- so signed-in customers ALWAYS see the empty state — even users with real
-- LYMX-earning visits that they haven't reviewed yet. Rachel ticket #98fcfa23
-- ("Pending Review — no link") is the user-visible symptom.
--
-- ROOT CAUSE
-- ----------------------------------------------------------------------------
-- The page never had a real backing query. The "Pending reviews" idea was
-- mocked in HTML but no view existed for the frontend to read from. Per
-- audit Phase 5, this was tagged as "backend-blocked" and parked until
-- Module 8.
--
-- WHAT THIS MIGRATION DOES
-- ----------------------------------------------------------------------------
-- Creates `v_my_pending_reviews` — a single-user view that lists every
-- business where the current user (auth.uid()) has earned LYMX from a
-- visit/transaction AND has not yet written a review for that business.
--
-- The view joins three tables:
--   * `lymx_issuances`  — where the visit was recorded (filter: positive
--                         amount, auto/approved status, business_id present,
--                         reason is a real visit not a redemption / review)
--   * `businesses`      — for slug/display_name/emoji/category (filter:
--                         not archived, not demo_only, has a slug)
--   * `reviews`         — to EXCLUDE businesses the user has already
--                         reviewed (compared by business_slug)
--
-- One row per (user, business) pair where there is at least one qualifying
-- visit and zero existing reviews. The view always scopes to auth.uid() so
-- it never leaks data across users — safe to expose to all authenticated
-- callers.
--
-- WHY `WITH (security_invoker = on)`
-- ----------------------------------------------------------------------------
-- Postgres 15+. Without this, the view runs with the OWNER's privileges and
-- bypasses RLS on the underlying tables. We want RLS to enforce: the user
-- only sees rows where auth.uid() matches. Setting security_invoker = on
-- means each SELECT through the view runs with the caller's RLS context,
-- matching what we already do in v_my_lymx_balance and other v_my_* views.
--
-- WHY NO HARDCODED USER IDs
-- ----------------------------------------------------------------------------
-- Per Rule 0 (ARCHITECTURE-RULES.md) — every WHERE clause keys on auth.uid()
-- or on JOINed table columns, never on a literal UUID. The verify DO block
-- below tests invariants (view shape + permissions + zero-row behavior on a
-- caller with no visits) rather than naming specific test users.
--
-- INVERSE / ROLLBACK
-- ----------------------------------------------------------------------------
-- `DROP VIEW IF EXISTS public.v_my_pending_reviews;` (idempotent).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Create / replace the view
-- -----------------------------------------------------------------------------
-- Drop first to allow column-shape changes on re-run; CREATE OR REPLACE
-- alone refuses to add or remove columns once a view exists.
DROP VIEW IF EXISTS public.v_my_pending_reviews;

CREATE VIEW public.v_my_pending_reviews
WITH (security_invoker = on) AS
WITH my_visits AS (
    -- Every business where the caller earned LYMX via a real visit.
    -- Excludes:
    --   * NULL business_id (signup_bonus_review without an associated biz)
    --   * negative amount rows (redemptions)
    --   * pending_review / rejected issuance rows (not yet credited)
    --   * reason='review' (the bonus AFTER reviewing — already a review)
    --   * reason='redemption' (filtered by amount > 0 already, belt+suspenders)
    SELECT
        li.business_id,
        COUNT(*)::int                       AS visit_count,
        MAX(li.created_at)                  AS last_visit_at,
        COALESCE(SUM(li.amount_lymx), 0)::int AS lymx_earned_here
      FROM public.lymx_issuances li
     WHERE li.recipient_user_id = auth.uid()
       AND li.business_id IS NOT NULL
       AND li.admin_status IN ('auto', 'approved')
       AND li.amount_lymx > 0
       AND li.reason IN ('transaction', 'signup_bonus', 'referral', 'manual', 'promo')
     GROUP BY li.business_id
),
my_reviewed_slugs AS (
    -- Every business the caller has ALREADY reviewed. Keyed on slug because
    -- public.reviews stores business_slug (text), not business_id.
    SELECT DISTINCT r.business_slug
      FROM public.reviews r
     WHERE r.reviewer_user_id = auth.uid()
       AND r.business_slug IS NOT NULL
)
SELECT
    v.business_id,
    b.slug                                AS business_slug,
    b.display_name                        AS business_name,
    COALESCE(b.emoji, '🏪')                AS business_emoji,
    b.category,
    v.visit_count,
    v.last_visit_at,
    v.lymx_earned_here,
    100                                   AS potential_reward_lymx
  FROM my_visits v
  JOIN public.businesses b ON b.id = v.business_id
 WHERE b.archived_at IS NULL
   AND COALESCE(b.demo_only, false) = false
   AND b.slug IS NOT NULL
   AND b.slug NOT IN (SELECT business_slug FROM my_reviewed_slugs)
 ORDER BY v.last_visit_at DESC;

COMMENT ON VIEW public.v_my_pending_reviews IS
    'Module 8: pending-review prompts for the customer dashboard. One row per business the caller has visited and not yet reviewed. Scoped to auth.uid() via WHERE clauses; security_invoker=on enforces underlying table RLS.';

GRANT SELECT ON public.v_my_pending_reviews TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. Helpful indexes on the underlying tables (idempotent, narrow)
-- -----------------------------------------------------------------------------
-- The view groups lymx_issuances by (recipient_user_id, business_id) filtered
-- by admin_status + reason. Existing indexes are by recipient and by
-- (business_id, idempotency_key). Add a partial index optimized for THIS
-- view's hot path — small, write-cheap, dramatically faster lookups for
-- customers with many issuances at many businesses.
CREATE INDEX IF NOT EXISTS idx_lymx_issuances_visit_lookup
    ON public.lymx_issuances (recipient_user_id, business_id)
    WHERE business_id IS NOT NULL
      AND amount_lymx > 0
      AND admin_status IN ('auto', 'approved');

-- The view's NOT-IN excludes already-reviewed business_slugs for the caller.
-- reviews already has idx_reviews_reviewer (reviewer_user_id, created_at desc)
-- from migration 030, which serves this lookup.

-- -----------------------------------------------------------------------------
-- 3. Verification DO block — tests invariants, never named users
-- -----------------------------------------------------------------------------
-- Per ARCHITECTURE-RULES.md Rule 0, the verification asserts shape and
-- permissions rather than naming specific test accounts. The view's
-- behavior is driven entirely by auth.uid() and the joined tables, so the
-- right invariants to check are:
--   1. The view exists.
--   2. The view is owned correctly and authenticated has SELECT.
--   3. The view returns zero rows when called with no auth context
--      (DO blocks run as the migration owner, auth.uid() is NULL, so the
--      CTE filter on recipient_user_id = auth.uid() yields zero rows and
--      the whole view should return zero — no leakage).
--   4. The column shape matches what customer-dashboard.html expects.
do $verify_103$
declare
    v_view_exists       boolean;
    v_has_select        boolean;
    v_row_count_no_auth int;
    v_required_cols     text[] := ARRAY[
        'business_id', 'business_slug', 'business_name', 'business_emoji',
        'category', 'visit_count', 'last_visit_at', 'lymx_earned_here',
        'potential_reward_lymx'
    ];
    v_missing_cols      text[];
begin
    -- 1. View exists.
    select exists (
        select 1 from pg_views
         where schemaname = 'public' and viewname = 'v_my_pending_reviews'
    ) into v_view_exists;
    if not v_view_exists then
        raise exception '103 verify: v_my_pending_reviews was not created';
    end if;

    -- 2. authenticated has SELECT on it.
    select has_table_privilege('authenticated', 'public.v_my_pending_reviews', 'SELECT')
      into v_has_select;
    if not v_has_select then
        raise exception '103 verify: authenticated role does not have SELECT on v_my_pending_reviews';
    end if;

    -- 3. Zero rows under no-auth context (the DO block runs without auth.uid()).
    --    The view filters by recipient_user_id = auth.uid(); a NULL auth.uid()
    --    yields zero rows, which is what we want — no leakage when the view
    --    is queried without a session.
    execute 'select count(*) from public.v_my_pending_reviews' into v_row_count_no_auth;
    if v_row_count_no_auth <> 0 then
        raise exception '103 verify: v_my_pending_reviews returned % rows under no-auth context — expected 0 (potential RLS / auth.uid() leak)', v_row_count_no_auth;
    end if;

    -- 4. Column shape matches the frontend contract.
    select array_agg(c)
      into v_missing_cols
      from unnest(v_required_cols) c
     where not exists (
        select 1 from information_schema.columns ic
         where ic.table_schema = 'public'
           and ic.table_name   = 'v_my_pending_reviews'
           and ic.column_name  = c
     );
    if v_missing_cols is not null and array_length(v_missing_cols, 1) > 0 then
        raise exception '103 verify: v_my_pending_reviews is missing required columns: %', array_to_string(v_missing_cols, ', ');
    end if;

    raise notice '103 verify: invariants hold — view exists, authenticated has SELECT, no-auth returns 0 rows, all 9 required columns present.';
end $verify_103$;

COMMIT;
