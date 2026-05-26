-- =============================================================================
-- Migration 092 — Phase 0 of biz-onboarding roadmap (2026-05-26)
-- =============================================================================
-- Adds `businesses.demo_only` so we can keep the static demo HTML pages
-- (biz-brew-and-bean.html, biz-oakline-kitchen.html) functional as visual
-- props WITHOUT polluting real merchant listings.
--
-- Root cause this migration addresses:
--   1. Three fake test rows from Dave's QA (slugs `melongs`,
--      `melong-merchandise`, `melong-merchandise-v2`) currently appear in
--      `v_businesses_directory` and any other "all businesses" listing.
--   2. Two static demo HTML pages reference businesses by slug but have NO
--      backing rows, so Save/Reserve/Review wiring (lymx-biz-actions.js)
--      throws "Business Not Found" — root cause behind ticket #9501d43e and
--      part of #026db35c.
--
-- The fix (per audits/BIZ-ONBOARDING-GAPS-2026-05-26.md Phase 4):
--   - Add `demo_only BOOLEAN NOT NULL DEFAULT false` to businesses.
--   - Flip the 3 Dave-test rows to demo_only=true.
--   - INSERT proper rows for `brew-and-bean` + `oakline-kitchen` so backend
--     lookups return sensible data (not 404), while demo_only=true keeps
--     them out of real directory listings.
--   - Recreate `v_businesses_directory` / `fn_businesses_directory` to
--     exclude `demo_only=true` AND `approval_status != 'approved'` (the
--     latter being the gating-on-approval comment that 081 promised but
--     left as a TODO).
--
-- This is a Rule 0 (root-cause-not-band-aid) migration: instead of patching
-- each "Business Not Found" alert site-by-site, we put a real row in the
-- canonical table so EVERY lookup site succeeds, and we use the new flag to
-- keep them invisible from real listings. The frontend then reads
-- `demo_only` from the row and disables transactional actions explicitly,
-- so the demo state is honest (not silently broken).
-- =============================================================================

BEGIN;

-- ─── 1. demo_only column ──────────────────────────────────────────────────
ALTER TABLE public.businesses
    ADD COLUMN IF NOT EXISTS demo_only BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_businesses_demo_only
    ON public.businesses(demo_only)
    WHERE demo_only = true;

COMMENT ON COLUMN public.businesses.demo_only IS
  'True = sample/preview business used as a visual prop (e.g. the static '
  '`biz-brew-and-bean.html` and `biz-oakline-kitchen.html` pages). '
  'Excluded from `v_businesses_directory` and other real-merchant listings. '
  'Frontends MUST read this flag and disable transactional actions '
  '(Reserve table / Save / Write review / Issue LYMX) on demo rows. Added '
  '2026-05-26 in migration 092 as Phase 0 of the biz-onboarding roadmap.';

-- ─── 2. Mark Dave's 3 test rows as demo_only ──────────────────────────────
-- Per audit doc § Phase 1: these 3 rows are pure QA artifacts that have
-- been cluttering the approval queue and directory for weeks.
UPDATE public.businesses
   SET demo_only  = true,
       updated_at = now()
 WHERE slug IN ('melongs', 'melong-merchandise', 'melong-merchandise-v2')
   AND demo_only = false;

-- ─── 3. INSERT demo rows for the two static HTML demo pages ───────────────
-- These INSERTs use approval_status='approved' so the rows are queryable
-- via the post-approval code paths. The AFTER UPDATE trigger that creates
-- the business_partners bridge only fires on UPDATE (035), so an INSERT
-- directly with 'approved' bypasses the partner-bridge creation — that's
-- intentional for demo rows since they have no real partner.
--
-- owner_user_id is left NULL because there is no real owner. Pages that
-- read owner-only data (biz-dashboard.html) will not be reachable for demo
-- rows, and that's correct: nobody should "log in" as Brew & Bean.
INSERT INTO public.businesses (
    legal_name,
    display_name,
    slug,
    category,
    business_kind,
    contact_email,
    approval_status,
    demo_only,
    tagline,
    description,
    emoji,
    address_line1
) VALUES
    (
        'Brew & Bean Coffee Co.',
        'Brew & Bean',
        'brew-and-bean',
        'Cafe / coffee',
        'storefront',
        'demo+brewandbean@lymxpower.com',
        'approved',
        true,
        'Downtown Las Vegas café — sample listing',
        'PREVIEW listing used as a visual example of how a real café would appear on LYMX. Not a real business; no transactions process here.',
        '☕',
        '1245 Las Vegas Blvd S, Las Vegas, NV 89101'
    ),
    (
        'Oakline Kitchen LLC',
        'Oakline Kitchen',
        'oakline-kitchen',
        'Restaurant',
        'storefront',
        'demo+oaklinekitchen@lymxpower.com',
        'approved',
        true,
        'Asian fusion restaurant — sample listing',
        'PREVIEW listing used as a visual example of how a real restaurant would appear on LYMX. Not a real business; no transactions process here.',
        '🍜',
        '915 Las Vegas Blvd S, Las Vegas, NV 89101'
    )
ON CONFLICT (slug) WHERE slug IS NOT NULL DO NOTHING;

-- ─── 4. Rebuild v_businesses_directory with demo_only + approval filter ───
-- Drop the dependent view so CASCADE doesn't cascade unexpectedly, then
-- re-create with the same column shape as 081 but with two additional
-- filters baked in.
DROP VIEW IF EXISTS public.v_businesses_directory;
DROP FUNCTION IF EXISTS public.fn_businesses_directory();

CREATE OR REPLACE FUNCTION public.fn_businesses_directory()
RETURNS TABLE (
    id            uuid,
    display_name  text,
    legal_name    text,
    slug          text,
    business_kind text,
    verified_at   timestamptz,
    created_at    timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $fn_dir$
    SELECT
        b.id,
        b.display_name,
        b.legal_name,
        b.slug,
        b.business_kind,
        b.verified_at,
        b.created_at
      FROM public.businesses b
     WHERE b.archived_at     IS NULL
       AND b.demo_only       = false
       AND b.approval_status = 'approved'
$fn_dir$;

COMMENT ON FUNCTION public.fn_businesses_directory() IS
  'SECURITY DEFINER read of basic discoverable business fields. Backs '
  'v_businesses_directory. Filters: archived_at IS NULL, demo_only = false, '
  'approval_status = ''approved''. Exposes only safe columns (no owner_user_id, '
  'no tax, no internal flags). 2026-05-26: added demo_only + approval gating '
  'per migration 092.';

CREATE VIEW public.v_businesses_directory AS
    SELECT * FROM public.fn_businesses_directory();

COMMENT ON VIEW public.v_businesses_directory IS
  'Public contact-picker view of approved, real businesses. Hides demo_only '
  'rows and any business not yet approved. Use this from any front-end '
  '"search a business" workflow (new-message form, referral picker, '
  'directory listings).';

GRANT SELECT  ON public.v_businesses_directory       TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_businesses_directory() TO anon, authenticated, service_role;

-- ─── 5. Sanity output ─────────────────────────────────────────────────────
DO $sanity_092$
DECLARE
    v_total_real integer;
    v_total_demo integer;
    v_dir_count  integer;
    v_dave_demos integer;
    v_static_pages integer;
BEGIN
    SELECT count(*) INTO v_total_real FROM public.businesses WHERE demo_only = false;
    SELECT count(*) INTO v_total_demo FROM public.businesses WHERE demo_only = true;
    SELECT count(*) INTO v_dir_count  FROM public.v_businesses_directory;

    SELECT count(*) INTO v_dave_demos
      FROM public.businesses
     WHERE slug IN ('melongs','melong-merchandise','melong-merchandise-v2')
       AND demo_only = true;

    SELECT count(*) INTO v_static_pages
      FROM public.businesses
     WHERE slug IN ('brew-and-bean','oakline-kitchen')
       AND demo_only = true;

    RAISE NOTICE 'businesses: % real, % demo. directory exposes % rows. Dave demos flagged: %/3. Static-page demos seeded: %/2.',
        v_total_real, v_total_demo, v_dir_count, v_dave_demos, v_static_pages;

    IF v_dave_demos < 3 THEN
        RAISE WARNING 'Expected 3 Dave-test rows flagged demo_only; got %. Slug list may have drifted.', v_dave_demos;
    END IF;
    IF v_static_pages < 2 THEN
        RAISE WARNING 'Expected 2 static-page demo rows; got %. Either ON CONFLICT skipped them (already existed) or insert failed.', v_static_pages;
    END IF;
END;
$sanity_092$;

COMMIT;

-- =============================================================================
-- Verification queries (run manually after apply)
-- =============================================================================
-- SELECT slug, display_name, approval_status, demo_only
--   FROM public.businesses
--  ORDER BY demo_only, created_at;
--
-- SELECT slug, display_name FROM public.v_businesses_directory ORDER BY slug;
--   ⇒ Should NOT include melongs, melong-merchandise, melong-merchandise-v2,
--     brew-and-bean, or oakline-kitchen.
-- =============================================================================
