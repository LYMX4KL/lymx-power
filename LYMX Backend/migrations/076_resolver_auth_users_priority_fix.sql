-- =============================================================================
-- LYMX Power — Migration 076: Resolver prefers auth.users.email over aliases
-- =============================================================================
-- 2026-05-23 (hotfix on top of 073)
--
-- Root-cause bug surfaced during live verify:
--   Migration 073's backfill registered partners.contact_email values into
--   alt_login_identifiers as personal_email aliases. Some test partner rows
--   (Dave's, in particular) had Kenny's personal gmail as their contact_email
--   — so 'zhongkennylin@gmail.com' got registered as Dave's alias. When the
--   admin script swapped Kenny's auth.users.email to 'zhongkennylin@gmail.com'
--   (the right thing to do), the resolver still returned Dave because it
--   checked alt_login_identifiers FIRST.
--
-- Architectural fix (per Rule 0 — root cause, not band-aid):
--   auth.users.email is the canonical identifier — anyone whose
--   alt_login_identifiers entry collides with someone else's PRIMARY auth
--   email had a "borrowed" alias that became invalid when the primary owner
--   claimed it.
--
-- This migration:
--   1. Rewrites resolve_login_identifier RPC to check auth.users.email
--      FIRST, then auth.users.phone, then alt_login_identifiers (alias
--      table is last resort, not first).
--   2. Cleans up the alt_login_identifiers table: any row whose
--      identifier_norm matches an existing auth.users.email of a DIFFERENT
--      user gets DELETED (the primary owner wins).
--   3. Re-inserts canonical rows for every auth.users.email + phone so
--      the alias table mirrors the auth state.
-- =============================================================================

-- ---------- 1. Clean up conflicting alias rows -------------------------------
DELETE FROM public.alt_login_identifiers a
 USING auth.users u
 WHERE a.identifier_norm = lower(u.email)
   AND a.auth_user_id <> u.id;

DELETE FROM public.alt_login_identifiers a
 USING auth.users u
 WHERE u.phone IS NOT NULL
   AND a.identifier_norm = public.norm_login_identifier(u.phone)
   AND a.auth_user_id <> u.id;


-- ---------- 2. Re-mirror auth.users primary identifiers ----------------------
INSERT INTO public.alt_login_identifiers (auth_user_id, identifier_type, identifier_value, identifier_norm, is_primary)
SELECT u.id, 'personal_email', u.email, lower(u.email), TRUE
  FROM auth.users u
 WHERE u.email IS NOT NULL
   AND u.email NOT ILIKE '%@getlymx.com'
   AND u.email NOT ILIKE '%@lymxpower.com'
ON CONFLICT (identifier_norm) DO UPDATE
    SET auth_user_id = EXCLUDED.auth_user_id,
        is_primary   = TRUE;

INSERT INTO public.alt_login_identifiers (auth_user_id, identifier_type, identifier_value, identifier_norm, is_primary)
SELECT u.id, 'phone', u.phone, public.norm_login_identifier(u.phone), TRUE
  FROM auth.users u
 WHERE u.phone IS NOT NULL AND u.phone <> ''
ON CONFLICT (identifier_norm) DO UPDATE
    SET auth_user_id = EXCLUDED.auth_user_id,
        is_primary   = TRUE;


-- ---------- 3. Rewrite resolver with correct priority ------------------------
CREATE OR REPLACE FUNCTION public.resolve_login_identifier(p_identifier TEXT)
RETURNS TABLE (
    auth_user_id  UUID,
    primary_email TEXT,
    primary_phone TEXT,
    matched_type  TEXT,
    matched_value TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $body$
DECLARE
    v_norm  TEXT;
    v_uid   UUID;
    v_email TEXT;
    v_phone TEXT;
    v_type  TEXT;
BEGIN
    v_norm := public.norm_login_identifier(p_identifier);
    IF v_norm IS NULL THEN
        RETURN;
    END IF;

    -- 1. auth.users.email is canonical — always wins
    SELECT u.id INTO v_uid FROM auth.users u WHERE lower(u.email) = v_norm LIMIT 1;
    IF v_uid IS NOT NULL THEN v_type := 'personal_email'; END IF;

    -- 2. auth.users.phone
    IF v_uid IS NULL THEN
        SELECT u.id INTO v_uid FROM auth.users u WHERE u.phone = v_norm LIMIT 1;
        IF v_uid IS NOT NULL THEN v_type := 'phone'; END IF;
    END IF;

    -- 3. alt_login_identifiers — only consulted when the identifier is NOT
    --    someone's primary email/phone (e.g. company_email aliases)
    IF v_uid IS NULL THEN
        SELECT a.auth_user_id, a.identifier_type
          INTO v_uid, v_type
          FROM public.alt_login_identifiers a
         WHERE a.identifier_norm = v_norm
         LIMIT 1;
    END IF;

    IF v_uid IS NULL THEN
        RETURN;
    END IF;

    SELECT u.email, u.phone INTO v_email, v_phone FROM auth.users u WHERE u.id = v_uid;

    auth_user_id  := v_uid;
    primary_email := v_email;
    primary_phone := v_phone;
    matched_type  := v_type;
    matched_value := v_norm;
    RETURN NEXT;
END
$body$;

REVOKE ALL ON FUNCTION public.resolve_login_identifier(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_login_identifier(TEXT) TO anon, authenticated, service_role;


-- ---------- 4. Verify the canonical pair --------------------------------------
SELECT 'Kenny lookup'                  AS test,
       (SELECT auth_user_id::TEXT || ' / ' || primary_email
          FROM public.resolve_login_identifier('zhongkennylin@gmail.com')) AS result
UNION ALL
SELECT 'Helen lookup',
       (SELECT auth_user_id::TEXT || ' / ' || primary_email
          FROM public.resolve_login_identifier('helen0510c@gmail.com'))
UNION ALL
SELECT 'Kenny via company email',
       (SELECT auth_user_id::TEXT || ' / ' || primary_email
          FROM public.resolve_login_identifier('kenny.lin@getlymx.com'));
