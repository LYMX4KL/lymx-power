-- =============================================================================
-- LYMX Power — Migration 074: home_office_address column + display fields
-- =============================================================================
-- 2026-05-23 (revised after Kenny correction)
--
-- Kenny's directive: Dave and Rachel SHOULD only be able to clock in from
-- their home address (strict geofence). Earlier draft of this migration
-- flipped remote_allowed to TRUE and widened the geofence — that was wrong.
-- Reverted: remote_allowed stays FALSE by default; geofence radius stays at
-- 200m default; Helen manually enables remote_allowed only for staff who
-- legitimately need to punch from a different location.
--
-- What this migration actually adds:
--   1. staff_roles.home_office_address TEXT — the human-readable address
--      Helen enters via admin-staff-locations.html. Stored alongside the
--      lat/lng so we have an audit record of *where* the geofence anchor
--      points to (Helen pastes "123 Main St" → we geocode to lat/lng but
--      keep the original string for clarity).
--   2. staff_roles.display_name + work_email — defensive backfill so the
--      admin UI can render names + emails without joining auth.users.
--   3. NO change to remote_allowed default (stays FALSE = strict geofence).
--   4. NO change to geofence_radius_m default (stays 200m ≈ one city block).
--   5. NO backfill that opens remote clock-in for everyone.
-- =============================================================================

-- ---------- 1. Add the address column ----------------------------------------
ALTER TABLE public.staff_roles
    ADD COLUMN IF NOT EXISTS home_office_address TEXT;

-- ---------- 2. Display columns (idempotent) ----------------------------------
-- The admin-staff-locations UI uses display_name + work_email if present;
-- add them defensively so the page doesn't break for older deploys.
ALTER TABLE public.staff_roles
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS work_email   TEXT;

-- Backfill display_name + work_email from auth.users when missing
UPDATE public.staff_roles sr
   SET display_name = COALESCE(sr.display_name,
                                u.raw_user_meta_data->>'full_name',
                                split_part(u.email, '@', 1)),
       work_email   = COALESCE(sr.work_email, u.email)
  FROM auth.users u
 WHERE u.id = sr.user_id
   AND (sr.display_name IS NULL OR sr.work_email IS NULL);

-- ---------- 3. Sanity check --------------------------------------------------
DO $sanity$
DECLARE
    v_total       INT;
    v_with_anchor INT;
    v_with_addr   INT;
    v_remote_on   INT;
BEGIN
    SELECT COUNT(*) INTO v_total       FROM public.staff_roles;
    SELECT COUNT(*) INTO v_with_anchor FROM public.staff_roles WHERE home_office_lat IS NOT NULL;
    SELECT COUNT(*) INTO v_with_addr   FROM public.staff_roles WHERE home_office_address IS NOT NULL;
    SELECT COUNT(*) INTO v_remote_on   FROM public.staff_roles WHERE remote_allowed = TRUE;
    RAISE NOTICE 'migration 074 applied | staff_total=% with_anchor=% with_addr=% remote_on=%',
        v_total, v_with_anchor, v_with_addr, v_remote_on;
END
$sanity$;
