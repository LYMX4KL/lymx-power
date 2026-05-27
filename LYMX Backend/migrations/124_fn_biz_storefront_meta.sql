-- =============================================================================
-- Migration 124 — Extend fn_biz_public_meta with storefront fields
-- =============================================================================
-- ROOT CAUSE THIS MIGRATION ADDRESSES (Kenny 2026-05-27)
-- -----------------------------------------------------
-- The "fix the biz-profile right-side hidden" ticket (Dave #5b986813) was
-- BAND-AIDED by tweaking the CSS of two hand-coded demo HTML files
-- (biz-oakline-kitchen.html + biz-brew-and-bean.html). The real root cause is
-- architectural: per-business storefronts should NOT exist as hand-coded
-- HTML files. When a new business signs up and an admin approves them, their
-- public storefront page must auto-exist — no per-biz coding from the team.
--
-- This migration is Phase 1 of the fix:
--   1. Extends fn_biz_public_meta() to return all anon-safe storefront
--      fields (emoji, tagline, description, category, address_line1,
--      contact_phone, website, operating_hours, current_promos, issuance_rate,
--      redemption_rate, redemption_cap_pct, verified_at, created_at).
--   2. Keeps the existing 5 fields (id, slug, display_name, demo_only,
--      approval_status) so prior callers (lymx-biz-actions.js demo guard)
--      keep working — they ignore the new cols.
--   3. Stays SECURITY DEFINER + GRANT EXECUTE to anon + authenticated so the
--      new biz.html storefront template can render without auth.
--
-- INTENTIONALLY EXCLUDED (private):
--   legal_name, contact_email, owner_user_id, organization_id, ein,
--   business_license_number, incorporation_state, entity_type, year_founded,
--   employee_count_range, signup_paid_amount, stripe_connect_account_id,
--   signed_up_by_partner_id, request_more_info_*, intake_completed_at.
--   These are all PII or business-internal data. Storefront has no need.
--
-- The existing function returns 5 columns; this migration drops + recreates
-- with the extended return shape. PostgREST RPC callers that select only
-- the original 5 fields continue to work since extra cols are ignored.
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.fn_biz_public_meta(text);

CREATE OR REPLACE FUNCTION public.fn_biz_public_meta(p_slug text)
RETURNS TABLE (
    -- Original 5 fields (backward compat with mig 094 callers)
    id                  uuid,
    slug                text,
    display_name        text,
    demo_only           boolean,
    approval_status     text,
    -- New storefront fields (anon-safe public-display data only)
    emoji               text,
    tagline             text,
    description         text,
    category            text,
    business_kind       text,
    address_line1       text,
    contact_phone       text,
    website             text,
    operating_hours     jsonb,
    current_promos      jsonb,
    issuance_rate       numeric,
    redemption_rate     numeric,
    redemption_cap_pct  numeric,
    verified_at         timestamptz,
    created_at          timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $fn_meta$
    SELECT
        b.id,
        b.slug,
        b.display_name,
        b.demo_only,
        b.approval_status::text,
        b.emoji,
        b.tagline,
        b.description,
        b.category,
        b.business_kind,
        b.address_line1,
        b.contact_phone,
        b.website,
        b.operating_hours,
        b.current_promos,
        b.issuance_rate,
        b.redemption_rate,
        b.redemption_cap_pct,
        b.verified_at,
        b.created_at
      FROM public.businesses b
     WHERE b.slug = p_slug
       AND b.archived_at IS NULL
     LIMIT 1
$fn_meta$;

COMMENT ON FUNCTION public.fn_biz_public_meta(text) IS
  'SECURITY DEFINER lookup of public-safe business metadata by slug. Returns id, slug, display_name, demo_only, approval_status + storefront fields (emoji, tagline, description, category, address, phone, website, operating_hours, current_promos, LYMX rates, verified_at). Excludes PII (email, owner_user_id, ein, license). Backs both the demo-page guard (lymx-biz-actions.js) AND the new templated public storefront (biz.html). Extended 2026-05-27 in migration 124 from the 5-field original (mig 094) so admin-approved businesses auto-render without per-biz HTML.';

GRANT EXECUTE ON FUNCTION public.fn_biz_public_meta(text) TO anon, authenticated, service_role;

-- Sanity check: the two demo slugs + reachability
DO $sanity_124$
DECLARE
    v_oak  jsonb;
    v_brew jsonb;
BEGIN
    SELECT to_jsonb(t) INTO v_oak  FROM public.fn_biz_public_meta('oakline-kitchen') t;
    SELECT to_jsonb(t) INTO v_brew FROM public.fn_biz_public_meta('brew-and-bean')   t;
    IF v_oak IS NULL THEN
        RAISE WARNING '124 sanity: oakline-kitchen lookup returned NULL — seed missing';
    ELSE
        RAISE NOTICE '124 sanity oakline: emoji=% category=% has_promos=%',
            v_oak->>'emoji', v_oak->>'category', (v_oak->'current_promos' IS NOT NULL);
    END IF;
    IF v_brew IS NULL THEN
        RAISE WARNING '124 sanity: brew-and-bean lookup returned NULL — seed missing';
    ELSE
        RAISE NOTICE '124 sanity brew: emoji=% category=% has_promos=%',
            v_brew->>'emoji', v_brew->>'category', (v_brew->'current_promos' IS NOT NULL);
    END IF;
END $sanity_124$;

COMMIT;
