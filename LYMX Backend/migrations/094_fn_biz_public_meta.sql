-- =============================================================================
-- Migration 094 — fn_biz_public_meta (hotfix for demo gate visibility)
-- =============================================================================
-- ROOT CAUSE
-- ----------
-- Migration 092 added `businesses.demo_only` and the demo guard on
-- biz-brew-and-bean.html / biz-oakline-kitchen.html. The Phase 0 frontend
-- wiring (lymx-biz-actions.js / lymx-reviews.js) tried to read demo_only
-- via a direct PostgREST query:
--
--   GET /rest/v1/businesses?slug=eq.X&select=id,demo_only,display_name
--
-- with only the anon apikey (no Authorization bearer). PostgREST evaluated
-- the request under the anon role and RLS rejected it ("permission denied
-- for table businesses", HTTP 401). Result: every demo lookup silently
-- returned null, the PREVIEW banner never injected, and the Save/Reserve/
-- Review demo guards never fired.
--
-- WHY THIS HAPPENED
-- -----------------
-- public.businesses has no anon-readable policy by design (owner emails +
-- contact phone + EIN are private). Previously the demo pages didn't read
-- businesses at all (hardcoded HTML); the new demo guard introduced the
-- first anon read attempt.
--
-- THE FIX
-- -------
-- Add a SECURITY DEFINER RPC `fn_biz_public_meta(p_slug text)` that returns
-- ONLY the public-safe fields needed by the demo guard:
--   - id (uuid)
--   - demo_only (boolean)
--   - display_name (text)
--   - approval_status (text — useful for future "not yet approved" UX)
--
-- No owner_user_id, no contact_email, no contact_phone, no tax info, no
-- internal flags. The function bypasses RLS once via SECURITY DEFINER but
-- the column whitelist is the access control.
--
-- Grant EXECUTE to anon + authenticated + service_role.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_biz_public_meta(p_slug text)
RETURNS TABLE (
    id              uuid,
    slug            text,
    display_name    text,
    demo_only       boolean,
    approval_status text
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
        b.approval_status::text
      FROM public.businesses b
     WHERE b.slug = p_slug
       AND b.archived_at IS NULL
     LIMIT 1
$fn_meta$;

COMMENT ON FUNCTION public.fn_biz_public_meta(text) IS
  'SECURITY DEFINER lookup of public-safe business metadata by slug. Returns id, slug, display_name, demo_only, approval_status only — no PII. Backs the demo-page guard in lymx-biz-actions.js (Save / Reserve / Review refuse on demo_only=true rows) and the PREVIEW banner injection. Added 2026-05-26 in migration 094 as a hotfix after migration 092''s Phase 0 demo guard failed silently against anon RLS.';

GRANT EXECUTE ON FUNCTION public.fn_biz_public_meta(text) TO anon, authenticated, service_role;

-- Sanity output: confirm rows are reachable for the two demo slugs.
DO $sanity_094$
DECLARE
    v_brew jsonb;
    v_oak  jsonb;
BEGIN
    SELECT to_jsonb(t) INTO v_brew FROM public.fn_biz_public_meta('brew-and-bean')   t;
    SELECT to_jsonb(t) INTO v_oak  FROM public.fn_biz_public_meta('oakline-kitchen') t;

    RAISE NOTICE 'fn_biz_public_meta(brew-and-bean): %', COALESCE(v_brew::text, 'NULL (row missing — re-check migration 092 applied)');
    RAISE NOTICE 'fn_biz_public_meta(oakline-kitchen): %', COALESCE(v_oak::text,  'NULL (row missing — re-check migration 092 applied)');

    IF v_brew IS NULL OR v_oak IS NULL THEN
        RAISE WARNING 'One or both demo rows missing — migration 092 may not have run, or the INSERT was skipped by ON CONFLICT. Verify with: SELECT slug, demo_only FROM businesses WHERE slug IN (''brew-and-bean'',''oakline-kitchen'');';
    END IF;
END $sanity_094$;

COMMIT;
