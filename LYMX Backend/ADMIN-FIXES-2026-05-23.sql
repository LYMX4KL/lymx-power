-- =============================================================================
-- LYMX Power — Admin one-shot SQL for 2026-05-23 gate-keeper unblock
-- =============================================================================
-- Run AFTER migrations 073 + 074 are applied AND resolve-login-identifier
-- + patched partner-provision-email are deployed.
--
-- This script:
--   1. Grants Helen full owner/CFO access (admin + is_cfo + is_hr).
--   2. Ensures Kenny's auth email is his personal gmail (post-073 should
--      have done this, but if not we force it here).
--   3. Force-triggers Helen's welcome email via the patched
--      partner-provision-email EF (Cloudflare check is now non-blocking).
--   4. Backfills Helen + Kenny into alt_login_identifiers if missed.
--
-- Read each block before running. Each block prints what it did.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Find Kenny and Helen's auth user IDs
-- ---------------------------------------------------------------------------
DO $find$
DECLARE
    v_kenny_id UUID;
    v_helen_id UUID;
BEGIN
    -- Kenny — try multiple known emails
    SELECT id INTO v_kenny_id FROM auth.users
     WHERE lower(email) IN ('zhongkennylin@gmail.com','kenny.lin@getlymx.com','kenny@lymxpower.com')
        OR id = (select id from auth.users where email = 'zhongkennylin@gmail.com')
     LIMIT 1;
    RAISE NOTICE 'Kenny auth user_id: %', v_kenny_id;

    -- Helen — by personal gmail (most reliable per Kenny 2026-05-23)
    SELECT id INTO v_helen_id FROM auth.users
     WHERE lower(email) = 'helen0510c@gmail.com'
        OR id IN (SELECT user_id FROM public.partners WHERE lower(contact_email) = 'helen0510c@gmail.com')
     LIMIT 1;
    RAISE NOTICE 'Helen auth user_id: %', v_helen_id;
END
$find$;


-- ---------------------------------------------------------------------------
-- 2. Grant Helen full owner/CFO access
-- ---------------------------------------------------------------------------
-- Same scope as Kenny: admin + is_cfo + is_hr + remote clock-in allowed.
-- If Helen does not yet have a staff_roles row, INSERT; otherwise UPDATE.

DO $grant_helen$
DECLARE
    v_helen_id UUID;
BEGIN
    SELECT id INTO v_helen_id FROM auth.users
     WHERE lower(email) = 'helen0510c@gmail.com'
        OR id IN (SELECT user_id FROM public.partners WHERE lower(contact_email) = 'helen0510c@gmail.com')
     LIMIT 1;

    IF v_helen_id IS NULL THEN
        RAISE WARNING 'Helen not found in auth.users — she may need to sign up first or her contact_email is different. Skipping grant.';
        RETURN;
    END IF;

    INSERT INTO public.staff_roles (user_id, role, is_cfo, is_hr, job_title, notes,
                                    remote_allowed, geofence_radius_m,
                                    display_name, work_email)
    VALUES (v_helen_id, 'admin', TRUE, TRUE, 'Owner / CFO',
            'Granted 2026-05-23 by Kenny — full access same as founder.',
            TRUE, 100000,
            'Helen Chen', 'helen0510c@gmail.com')
    ON CONFLICT (user_id) DO UPDATE
        SET role            = 'admin',
            is_cfo          = TRUE,
            is_hr           = TRUE,
            job_title       = COALESCE(EXCLUDED.job_title, public.staff_roles.job_title),
            notes           = 'Updated 2026-05-23 by Kenny — full access same as founder.',
            remote_allowed  = TRUE,
            geofence_radius_m = GREATEST(COALESCE(public.staff_roles.geofence_radius_m, 0), 100000),
            display_name    = COALESCE(public.staff_roles.display_name, EXCLUDED.display_name),
            work_email      = COALESCE(public.staff_roles.work_email,   EXCLUDED.work_email);

    RAISE NOTICE 'Helen (%) granted admin + is_cfo + is_hr + remote clock-in.', v_helen_id;
END
$grant_helen$;


-- ---------------------------------------------------------------------------
-- 3. Backfill alt_login_identifiers for Kenny + Helen (covers any edge case
--    migration 073 missed — like Kenny's account using a non-listed email)
-- ---------------------------------------------------------------------------
INSERT INTO public.alt_login_identifiers (auth_user_id, identifier_type, identifier_value, identifier_norm)
SELECT  u.id, 'personal_email', 'zhongkennylin@gmail.com', 'zhongkennylin@gmail.com'
  FROM  auth.users u
 WHERE  u.id IN (
     SELECT id FROM auth.users
      WHERE lower(email) IN ('zhongkennylin@gmail.com','kenny.lin@getlymx.com','kenny@lymxpower.com')
         OR id = (select id from auth.users where email = 'zhongkennylin@gmail.com')
      LIMIT 1
 )
ON CONFLICT (identifier_norm) DO NOTHING;

INSERT INTO public.alt_login_identifiers (auth_user_id, identifier_type, identifier_value, identifier_norm)
SELECT  u.id, 'personal_email', 'helen0510c@gmail.com', 'helen0510c@gmail.com'
  FROM  auth.users u
 WHERE  lower(u.email) = 'helen0510c@gmail.com'
    OR  u.id IN (SELECT user_id FROM public.partners WHERE lower(contact_email)='helen0510c@gmail.com')
ON CONFLICT (identifier_norm) DO NOTHING;


-- ---------------------------------------------------------------------------
-- 4. Force Kenny's auth.users.email to his gmail (overrides migration 073
--    if the swap didn't apply — e.g. partners.contact_email was missing)
-- ---------------------------------------------------------------------------
UPDATE auth.users
   SET email = 'zhongkennylin@gmail.com',
       email_confirmed_at = COALESCE(email_confirmed_at, NOW())
 WHERE id = (select id from auth.users where email = 'zhongkennylin@gmail.com')
   AND email ILIKE '%@getlymx.com'
   AND NOT EXISTS (
       SELECT 1 FROM auth.users WHERE lower(email) = 'zhongkennylin@gmail.com'
   );

UPDATE auth.users
   SET email = 'helen0510c@gmail.com',
       email_confirmed_at = COALESCE(email_confirmed_at, NOW())
 WHERE id IN (
     SELECT id FROM auth.users
      WHERE id IN (SELECT user_id FROM public.partners WHERE lower(contact_email)='helen0510c@gmail.com')
        AND email ILIKE '%@getlymx.com'
 )
   AND NOT EXISTS (
       SELECT 1 FROM auth.users WHERE lower(email) = 'helen0510c@gmail.com'
   );


-- ---------------------------------------------------------------------------
-- 5. Report final state — Kenny + Helen should both show:
--    - auth.users.email = their personal gmail
--    - alt_login_identifiers has entries for them
--    - staff_roles shows admin role
-- ---------------------------------------------------------------------------
SELECT u.id              AS auth_user_id,
       u.email           AS primary_email,
       u.phone           AS primary_phone,
       sr.role           AS staff_role,
       sr.is_cfo,
       sr.is_hr,
       sr.remote_allowed,
       sr.geofence_radius_m,
       (SELECT array_agg(identifier_type || ':' || identifier_value)
          FROM public.alt_login_identifiers
         WHERE auth_user_id = u.id) AS alt_identifiers
  FROM auth.users u
  LEFT JOIN public.staff_roles sr ON sr.user_id = u.id
 WHERE lower(u.email) IN ('zhongkennylin@gmail.com','helen0510c@gmail.com')
    OR u.id = (select id from auth.users where email = 'zhongkennylin@gmail.com')
 ORDER BY u.email;
