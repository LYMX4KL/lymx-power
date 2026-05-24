-- =============================================================================
-- LYMX Power — Migration 073: Multi-identifier login (alt_login_identifiers)
-- =============================================================================
-- 2026-05-23
--
-- ARCHITECTURE-RULES Rule 0 (root cause, not band-aid):
--   Today's "gate keeping" bug — pw-reset emails never arrive — has two
--   stacked root causes:
--     (a) Users sign up with personal email but their auth account ends up
--         using a *@getlymx.com address, so /recover sends to a company
--         email that must forward through Cloudflare Email Routing. When
--         Cloudflare's destination isn't verified, email is silently
--         dropped. Helen, Kenny both stuck here.
--     (b) Users try "Forgot password?" with an identifier their auth
--         account doesn't know (their personal email, their phone, OR
--         their company email — only one of those is stored on auth.users),
--         and /recover returns 200 silently with no email sent.
--
-- The architectural fix Kenny asked for (2026-05-23):
--   "all partners/staffs should be able login with phone#, personal email
--    when they sign up, company email provided when they become partner"
--
-- This migration:
--   1. Adds alt_login_identifiers table mapping any of (phone, personal
--      email, company email) to the underlying auth user.
--   2. Adds a SECURITY DEFINER lookup function resolve_login_identifier
--      that frontend + Edge Functions call to translate any identifier
--      into auth.users.id + primary email + primary phone.
--   3. Backfills from auth.users + partners + partner_emails.
--   4. Adds a trigger so future partner_emails inserts auto-register the
--      company email as an alt identifier.
--   5. SWAPS auth.users.email for any user whose current email is
--      *@getlymx.com to use partner.contact_email instead. After this swap,
--      pw-reset emails land in the user's real personal inbox via Resend
--      directly — no Cloudflare dependency.
--
-- Idempotent: re-running this migration is a no-op (uses ON CONFLICT DO
-- NOTHING + COALESCE patterns throughout).
-- =============================================================================

-- ---------- 1. Table ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.alt_login_identifiers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    identifier_type TEXT NOT NULL CHECK (identifier_type IN ('phone','personal_email','company_email')),
    identifier_value TEXT NOT NULL,
    -- normalized form used for lookups (lowercase email; +E.164 phone)
    identifier_norm  TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- the auth row's "primary" identifier is also mirrored here for uniform lookup
    is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
    -- if this came from a partner_email row, link it for cleanup-on-delete
    partner_email_id UUID REFERENCES public.partner_emails(id) ON DELETE CASCADE
);

-- One identifier can map to AT MOST ONE auth account.
CREATE UNIQUE INDEX IF NOT EXISTS alt_login_identifiers_norm_uidx
    ON public.alt_login_identifiers (identifier_norm);

CREATE INDEX IF NOT EXISTS alt_login_identifiers_user_idx
    ON public.alt_login_identifiers (auth_user_id);

ALTER TABLE public.alt_login_identifiers ENABLE ROW LEVEL SECURITY;

-- Users can read their own alt identifiers (so the "my identities" UI works).
DROP POLICY IF EXISTS alt_login_identifiers_self_select ON public.alt_login_identifiers;
CREATE POLICY alt_login_identifiers_self_select ON public.alt_login_identifiers
    FOR SELECT
    USING (auth.uid() = auth_user_id);

-- Inserts/deletes happen via SECURITY DEFINER RPCs or service role.
DROP POLICY IF EXISTS alt_login_identifiers_admin_all ON public.alt_login_identifiers;
CREATE POLICY alt_login_identifiers_admin_all ON public.alt_login_identifiers
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.staff_roles sr
            WHERE sr.user_id = auth.uid()
              AND sr.role IN ('admin','tech','support')
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.staff_roles sr
            WHERE sr.user_id = auth.uid()
              AND sr.role IN ('admin','tech','support')
        )
    );


-- ---------- 2. Normalizer helpers --------------------------------------------

CREATE OR REPLACE FUNCTION public.norm_login_identifier(v TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $norm$
BEGIN
    IF v IS NULL THEN RETURN NULL; END IF;
    -- Strip whitespace
    v := trim(v);
    IF v = '' THEN RETURN NULL; END IF;
    -- Email: lowercase
    IF v LIKE '%@%' THEN
        RETURN lower(v);
    END IF;
    -- Phone: keep digits + leading +; assume US (+1) if 10 digits, raw
    DECLARE
        digits TEXT := regexp_replace(v, '[^0-9]', '', 'g');
    BEGIN
        IF length(digits) = 10 THEN
            RETURN '+1' || digits;
        ELSIF length(digits) = 11 AND substr(digits, 1, 1) = '1' THEN
            RETURN '+' || digits;
        ELSIF length(digits) >= 10 THEN
            RETURN '+' || digits;
        ELSE
            RETURN lower(v); -- not a recognized phone; treat as raw identifier
        END IF;
    END;
END
$norm$;


-- ---------- 3. Lookup RPC (used by frontend + EF) ----------------------------

DROP FUNCTION IF EXISTS public.resolve_login_identifier(TEXT);

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
    v_norm TEXT;
    v_uid  UUID;
    v_email TEXT;
    v_phone TEXT;
    v_type  TEXT;
BEGIN
    v_norm := public.norm_login_identifier(p_identifier);
    IF v_norm IS NULL THEN
        RETURN;
    END IF;

    -- 1. Try alt_login_identifiers (covers backfilled + new aliases)
    SELECT a.auth_user_id, a.identifier_type
      INTO v_uid, v_type
      FROM public.alt_login_identifiers a
     WHERE a.identifier_norm = v_norm
     LIMIT 1;

    -- 2. Try auth.users.email directly (in case backfill missed)
    IF v_uid IS NULL THEN
        SELECT u.id
          INTO v_uid
          FROM auth.users u
         WHERE lower(u.email) = v_norm
         LIMIT 1;
        IF v_uid IS NOT NULL THEN v_type := 'personal_email'; END IF;
    END IF;

    -- 3. Try auth.users.phone
    IF v_uid IS NULL THEN
        SELECT u.id
          INTO v_uid
          FROM auth.users u
         WHERE u.phone = v_norm
         LIMIT 1;
        IF v_uid IS NOT NULL THEN v_type := 'phone'; END IF;
    END IF;

    IF v_uid IS NULL THEN
        RETURN;
    END IF;

    SELECT u.email, u.phone INTO v_email, v_phone
      FROM auth.users u WHERE u.id = v_uid;

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


-- ---------- 4. Backfill: mirror auth.users primary + register company emails -

-- 4a. Personal emails (current auth.users.email values that are NOT @getlymx.com)
INSERT INTO public.alt_login_identifiers (auth_user_id, identifier_type, identifier_value, identifier_norm, is_primary)
SELECT  u.id,
        'personal_email',
        u.email,
        lower(u.email),
        TRUE
  FROM  auth.users u
 WHERE  u.email IS NOT NULL
   AND  u.email NOT ILIKE '%@getlymx.com'
   AND  u.email NOT ILIKE '%@lymxpower.com'
ON CONFLICT (identifier_norm) DO NOTHING;

-- 4b. Phone numbers
INSERT INTO public.alt_login_identifiers (auth_user_id, identifier_type, identifier_value, identifier_norm, is_primary)
SELECT  u.id,
        'phone',
        u.phone,
        public.norm_login_identifier(u.phone),
        TRUE
  FROM  auth.users u
 WHERE  u.phone IS NOT NULL
   AND  u.phone <> ''
ON CONFLICT (identifier_norm) DO NOTHING;

-- 4c. Company emails from partner_emails (linked to a partner whose user_id we know)
-- partners.id != auth_user_id in this schema; we link partners → auth via partners.user_id.
INSERT INTO public.alt_login_identifiers (auth_user_id, identifier_type, identifier_value, identifier_norm, partner_email_id)
SELECT  p.user_id,
        'company_email',
        pe.full_email,
        lower(pe.full_email),
        pe.id
  FROM  public.partner_emails pe
  JOIN  public.partners p ON p.id = pe.partner_id
 WHERE  p.user_id IS NOT NULL
   AND  pe.full_email IS NOT NULL
   AND  pe.status IN ('active','provisioning','pending')
ON CONFLICT (identifier_norm) DO NOTHING;

-- 4d. Personal emails ALSO from partners.contact_email (covers the case where
--     the user's auth.users.email is the company email but their real personal
--     email is stored in partners.contact_email).
INSERT INTO public.alt_login_identifiers (auth_user_id, identifier_type, identifier_value, identifier_norm)
SELECT  p.user_id,
        'personal_email',
        p.contact_email,
        lower(p.contact_email)
  FROM  public.partners p
 WHERE  p.user_id IS NOT NULL
   AND  p.contact_email IS NOT NULL
   AND  p.contact_email NOT ILIKE '%@getlymx.com'
   AND  p.contact_email NOT ILIKE '%@lymxpower.com'
ON CONFLICT (identifier_norm) DO NOTHING;


-- ---------- 5. SWAP auth.users.email when current value is @getlymx.com ------
--
-- This is the structural fix that unblocks pw-reset for everyone. After this
-- swap, /auth/v1/recover sends emails to the user's PERSONAL inbox via Resend
-- directly (no Cloudflare forwarding required). The company @getlymx.com
-- address still works for inbound mail forwarding — it's just no longer the
-- "auth" email.
--
-- We CAN write to auth.users directly because this migration runs as the
-- postgres role inside the SQL editor (superuser context).

UPDATE auth.users u
   SET email = lower(p.contact_email),
       email_confirmed_at = COALESCE(u.email_confirmed_at, NOW())  -- preserve confirmation
  FROM public.partners p
 WHERE u.id = p.user_id
   AND p.contact_email IS NOT NULL
   AND p.contact_email NOT ILIKE '%@getlymx.com'
   AND p.contact_email NOT ILIKE '%@lymxpower.com'
   AND u.email ILIKE '%@getlymx.com'
   -- Don't swap if another auth.user already uses that personal email
   AND NOT EXISTS (
       SELECT 1 FROM auth.users u2
        WHERE u2.id <> u.id
          AND lower(u2.email) = lower(p.contact_email)
   );


-- ---------- 6. Trigger: auto-register future partner_emails as company alias --

CREATE OR REPLACE FUNCTION public.trg_partner_emails_register_alt()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $trg$
DECLARE
    v_uid UUID;
BEGIN
    SELECT user_id INTO v_uid FROM public.partners WHERE id = NEW.partner_id;
    IF v_uid IS NULL THEN
        RETURN NEW;
    END IF;
    INSERT INTO public.alt_login_identifiers (auth_user_id, identifier_type, identifier_value, identifier_norm, partner_email_id)
    VALUES (v_uid, 'company_email', NEW.full_email, lower(NEW.full_email), NEW.id)
    ON CONFLICT (identifier_norm) DO NOTHING;
    RETURN NEW;
END
$trg$;

DROP TRIGGER IF EXISTS partner_emails_register_alt ON public.partner_emails;
CREATE TRIGGER partner_emails_register_alt
AFTER INSERT ON public.partner_emails
FOR EACH ROW
EXECUTE FUNCTION public.trg_partner_emails_register_alt();


-- ---------- 7. Sanity reporting ----------------------------------------------

DO $sanity$
DECLARE
    v_count_all   INTEGER;
    v_count_phone INTEGER;
    v_count_pers  INTEGER;
    v_count_co    INTEGER;
    v_swapped     INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count_all FROM public.alt_login_identifiers;
    SELECT COUNT(*) INTO v_count_phone FROM public.alt_login_identifiers WHERE identifier_type='phone';
    SELECT COUNT(*) INTO v_count_pers  FROM public.alt_login_identifiers WHERE identifier_type='personal_email';
    SELECT COUNT(*) INTO v_count_co    FROM public.alt_login_identifiers WHERE identifier_type='company_email';
    SELECT COUNT(*) INTO v_swapped FROM auth.users WHERE email NOT ILIKE '%@getlymx.com';
    RAISE NOTICE 'migration 073 applied | alt_identifiers total=% (phone=% personal=% company=%) | auth.users not-@getlymx=%',
        v_count_all, v_count_phone, v_count_pers, v_count_co, v_swapped;
END
$sanity$;
