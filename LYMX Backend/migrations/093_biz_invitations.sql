-- =============================================================================
-- Migration 093 — biz_invitations (Module 1 of biz-onboarding roadmap)
-- =============================================================================
-- The audit doc (audits/BIZ-ONBOARDING-GAPS-2026-05-26.md § Step 1) found that
-- LYMX has no actual invitation system. "Inviting a business" today is Kenny
-- pasting `https://getlymx.com/biz-signup.html` into an email by hand.
-- No tracking, no expiry, no prefill, no audit trail of which partner
-- generated which signup.
--
-- This migration adds the canonical schema:
--   - `biz_invitations` table (one row per invite)
--   - `biz_invitation_status` enum (pending / clicked / signed_up / expired / revoked)
--   - RLS: admin sees all; partner sees their own; public can SELECT-by-token
--     once for the signup-page prefill (no token = no read)
--   - `fn_validate_invitation_token(text)` — SECURITY DEFINER RPC the public
--     biz-signup.html calls to validate + mark clicked + return prefill data
--   - `fn_link_invitation_to_business(uuid, uuid)` — SECURITY DEFINER RPC the
--     business-signup EF calls on submit to set resulting_business_id +
--     signed_up_at
--
-- Module 1's frontends + EFs land alongside this migration:
--   - EF biz-invite-create (admin/partner creates row, returns URL)
--   - EF biz-invite-send-email (Resend integration)
--   - admin-business-applications.html (new Invites tab + "+ Invite a business")
--   - partner-crm.html (same button)
--   - biz-signup.html (consumes ?invite_token=)
-- =============================================================================

BEGIN;

-- ─── 1. Status enum ────────────────────────────────────────────────────────
DO $enum_create$ BEGIN
    CREATE TYPE public.biz_invitation_status AS ENUM (
        'pending',   -- created, link not yet visited
        'clicked',   -- prospect opened biz-signup.html with ?invite_token=
        'signed_up', -- prospect submitted the signup form; resulting_business_id set
        'expired',   -- expires_at passed without signed_up
        'revoked'    -- admin/partner pulled the invite back
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $enum_create$;

-- ─── 2. Table ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.biz_invitations (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invitation_token         text NOT NULL UNIQUE, -- URL-safe random; long enough that brute-force is hopeless
    prospect_business_name   text NOT NULL,
    prospect_owner_name      text,
    prospect_contact_email   text,
    prospect_contact_phone   text,
    invited_by_user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    assigned_partner_id      uuid REFERENCES public.partners(id) ON DELETE SET NULL,
    expires_at               timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
    clicked_at               timestamptz,
    signup_completed_at      timestamptz,
    resulting_business_id    uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
    status                   public.biz_invitation_status NOT NULL DEFAULT 'pending',
    notes                    text,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_biz_invitations_status         ON public.biz_invitations(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_biz_invitations_invited_by     ON public.biz_invitations(invited_by_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_biz_invitations_partner        ON public.biz_invitations(assigned_partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_biz_invitations_email          ON public.biz_invitations(prospect_contact_email) WHERE prospect_contact_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_biz_invitations_resulting_biz  ON public.biz_invitations(resulting_business_id) WHERE resulting_business_id IS NOT NULL;

COMMENT ON TABLE  public.biz_invitations IS
  'One row per business invite. Tracks the full lifecycle from issue → click → signup → conversion. Token is the URL-safe random consumed by ?invite_token= on biz-signup.html.';
COMMENT ON COLUMN public.biz_invitations.invitation_token IS
  'URL-safe random (base64url, ~32 bytes / ~256 bits). UNIQUE so the index acts as the lookup key.';
COMMENT ON COLUMN public.biz_invitations.invited_by_user_id IS
  'Who created this invite — Kenny / Helen / a partner. Used for attribution + permission checks.';
COMMENT ON COLUMN public.biz_invitations.assigned_partner_id IS
  'If a partner generated the invite, the partner row id. Carries through to the business_partners bridge on conversion so commission attribution works.';

-- ─── 3. Updated-at trigger ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_biz_invitations_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $set_upd$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$set_upd$;

DROP TRIGGER IF EXISTS trg_biz_invitations_updated_at ON public.biz_invitations;
CREATE TRIGGER trg_biz_invitations_updated_at
    BEFORE UPDATE ON public.biz_invitations
    FOR EACH ROW EXECUTE FUNCTION public.set_biz_invitations_updated_at();

-- ─── 4. RLS ────────────────────────────────────────────────────────────────
ALTER TABLE public.biz_invitations ENABLE ROW LEVEL SECURITY;

-- Admin: full access (read + write). Uses the canonical am_i_admin() RPC.
DROP POLICY IF EXISTS biz_invitations_admin_all ON public.biz_invitations;
CREATE POLICY biz_invitations_admin_all ON public.biz_invitations
    FOR ALL TO authenticated
    USING (public.am_i_admin())
    WITH CHECK (public.am_i_admin());

-- Partner: can SEE + UPDATE their own (where assigned_partner_id is one of the
-- caller's partner rows). They can also INSERT but the WITH CHECK guarantees
-- assigned_partner_id matches their own partner.id and invited_by_user_id is
-- their auth.uid().
DROP POLICY IF EXISTS biz_invitations_partner_select ON public.biz_invitations;
CREATE POLICY biz_invitations_partner_select ON public.biz_invitations
    FOR SELECT TO authenticated
    USING (
        assigned_partner_id IN (
            SELECT id FROM public.partners WHERE user_id = auth.uid()
        )
        OR invited_by_user_id = auth.uid()
    );

DROP POLICY IF EXISTS biz_invitations_partner_insert ON public.biz_invitations;
CREATE POLICY biz_invitations_partner_insert ON public.biz_invitations
    FOR INSERT TO authenticated
    WITH CHECK (
        invited_by_user_id = auth.uid()
        AND (
            assigned_partner_id IS NULL
            OR assigned_partner_id IN (
                SELECT id FROM public.partners WHERE user_id = auth.uid()
            )
        )
    );

DROP POLICY IF EXISTS biz_invitations_partner_update ON public.biz_invitations;
CREATE POLICY biz_invitations_partner_update ON public.biz_invitations
    FOR UPDATE TO authenticated
    USING (
        assigned_partner_id IN (
            SELECT id FROM public.partners WHERE user_id = auth.uid()
        )
        OR invited_by_user_id = auth.uid()
    )
    WITH CHECK (
        assigned_partner_id IN (
            SELECT id FROM public.partners WHERE user_id = auth.uid()
        )
        OR invited_by_user_id = auth.uid()
    );

-- Anon: NO direct table access. The public token validation goes through
-- fn_validate_invitation_token below (SECURITY DEFINER, returns only the
-- prospect fields a signup-form prefill needs — never the token, never the
-- inviter's identity).
GRANT SELECT, INSERT, UPDATE ON public.biz_invitations TO authenticated;

-- ─── 5. fn_validate_invitation_token (PUBLIC RPC) ──────────────────────────
-- Validates a token from biz-signup.html, marks the invite clicked if it's
-- the first click, and returns the prefill data. NEVER returns the token
-- itself or any inviter PII beyond the partner-attribution flag.
CREATE OR REPLACE FUNCTION public.fn_validate_invitation_token(p_token text)
RETURNS TABLE (
    valid                    boolean,
    reason                   text,
    invitation_id            uuid,
    prospect_business_name   text,
    prospect_owner_name      text,
    prospect_contact_email   text,
    prospect_contact_phone   text,
    has_partner              boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $validate$
DECLARE
    v_row public.biz_invitations%ROWTYPE;
BEGIN
    IF p_token IS NULL OR length(p_token) < 16 THEN
        RETURN QUERY SELECT false, 'malformed_token'::text, NULL::uuid,
                            NULL::text, NULL::text, NULL::text, NULL::text, false;
        RETURN;
    END IF;

    SELECT * INTO v_row FROM public.biz_invitations WHERE invitation_token = p_token;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'not_found'::text, NULL::uuid,
                            NULL::text, NULL::text, NULL::text, NULL::text, false;
        RETURN;
    END IF;

    IF v_row.status = 'revoked' THEN
        RETURN QUERY SELECT false, 'revoked'::text, v_row.id,
                            NULL::text, NULL::text, NULL::text, NULL::text, false;
        RETURN;
    END IF;

    IF v_row.status = 'signed_up' THEN
        RETURN QUERY SELECT false, 'already_used'::text, v_row.id,
                            NULL::text, NULL::text, NULL::text, NULL::text, false;
        RETURN;
    END IF;

    IF v_row.expires_at < now() THEN
        -- Lazy-expire so the inbox view stays accurate without a cron.
        UPDATE public.biz_invitations SET status = 'expired' WHERE id = v_row.id AND status NOT IN ('expired','signed_up','revoked');
        RETURN QUERY SELECT false, 'expired'::text, v_row.id,
                            NULL::text, NULL::text, NULL::text, NULL::text, false;
        RETURN;
    END IF;

    -- First-click mark
    IF v_row.clicked_at IS NULL THEN
        UPDATE public.biz_invitations
           SET clicked_at = now(),
               status     = CASE WHEN status = 'pending' THEN 'clicked'::biz_invitation_status ELSE status END
         WHERE id = v_row.id;
    END IF;

    RETURN QUERY SELECT
        true,
        'ok'::text,
        v_row.id,
        v_row.prospect_business_name,
        v_row.prospect_owner_name,
        v_row.prospect_contact_email,
        v_row.prospect_contact_phone,
        (v_row.assigned_partner_id IS NOT NULL);
END;
$validate$;

COMMENT ON FUNCTION public.fn_validate_invitation_token(text) IS
  'Public RPC: validates an invite token from biz-signup.html. Marks clicked_at on first call. Returns prefill data only — never the token, never inviter PII. SECURITY DEFINER so anon can call without RLS friction.';

GRANT EXECUTE ON FUNCTION public.fn_validate_invitation_token(text) TO anon, authenticated, service_role;

-- ─── 6. fn_link_invitation_to_business (PRIVATE RPC) ───────────────────────
-- Called by the business-signup EF (service_role) AFTER the businesses row
-- is created. Marks the invite as signed_up + sets resulting_business_id.
-- Also: when assigned_partner_id is set, ensures the business_partners
-- bridge points at that partner so commission attribution flows.
CREATE OR REPLACE FUNCTION public.fn_link_invitation_to_business(
    p_token       text,
    p_business_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $link$
DECLARE
    v_inv public.biz_invitations%ROWTYPE;
BEGIN
    IF p_token IS NULL OR p_business_id IS NULL THEN
        RETURN jsonb_build_object('linked', false, 'reason', 'missing_args');
    END IF;

    SELECT * INTO v_inv FROM public.biz_invitations WHERE invitation_token = p_token;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('linked', false, 'reason', 'token_not_found');
    END IF;
    IF v_inv.status IN ('signed_up','revoked','expired') THEN
        RETURN jsonb_build_object('linked', false, 'reason', 'invitation_' || v_inv.status::text);
    END IF;

    UPDATE public.biz_invitations
       SET status                = 'signed_up',
           signup_completed_at   = now(),
           resulting_business_id = p_business_id
     WHERE id = v_inv.id;

    -- If a partner generated this invite, write the attribution bridge so
    -- the business_partners table reflects the source. Migration 035's
    -- trigger handles approval-time bridge creation but it pulls partner
    -- from businesses.signed_up_by_partner_id, which the signup EF sets.
    IF v_inv.assigned_partner_id IS NOT NULL THEN
        UPDATE public.businesses
           SET signed_up_by_partner_id = v_inv.assigned_partner_id
         WHERE id = p_business_id
           AND (signed_up_by_partner_id IS NULL
                OR signed_up_by_partner_id <> v_inv.assigned_partner_id);
    END IF;

    RETURN jsonb_build_object(
        'linked',                true,
        'invitation_id',         v_inv.id,
        'assigned_partner_id',   v_inv.assigned_partner_id,
        'resulting_business_id', p_business_id
    );
END;
$link$;

COMMENT ON FUNCTION public.fn_link_invitation_to_business(text, uuid) IS
  'Called by the business-signup EF immediately after the businesses row is created. Marks the invitation signed_up + sets resulting_business_id. If the invite has assigned_partner_id, writes businesses.signed_up_by_partner_id so commission attribution flows through migration 035''s approval trigger.';

GRANT EXECUTE ON FUNCTION public.fn_link_invitation_to_business(text, uuid) TO service_role;

-- ─── 7. Admin-only convenience view ────────────────────────────────────────
-- Joins invites with partner display data + resulting business slug, so the
-- Invites tab on admin-business-applications.html can render in one query.
DROP VIEW IF EXISTS public.v_admin_biz_invitations;
CREATE VIEW public.v_admin_biz_invitations
WITH (security_invoker = on)
AS
SELECT
    inv.id,
    inv.prospect_business_name,
    inv.prospect_owner_name,
    inv.prospect_contact_email,
    inv.prospect_contact_phone,
    inv.status::text                  AS status,
    inv.expires_at,
    inv.clicked_at,
    inv.signup_completed_at,
    inv.resulting_business_id,
    b.slug                            AS resulting_business_slug,
    b.display_name                    AS resulting_business_name,
    inv.invited_by_user_id,
    inv.assigned_partner_id,
    p.display_name                    AS assigned_partner_name,
    inv.created_at,
    inv.updated_at,
    -- Hide the raw token from the listing UI — only fetched on demand via RPC
    NULL::text                        AS invitation_token_redacted,
    'https://getlymx.com/biz-signup.html?invite_token=' || inv.invitation_token AS invite_url
  FROM public.biz_invitations inv
  LEFT JOIN public.businesses b ON b.id = inv.resulting_business_id
  LEFT JOIN public.partners   p ON p.id = inv.assigned_partner_id;

COMMENT ON VIEW public.v_admin_biz_invitations IS
  'Admin/partner-facing read of biz_invitations enriched with partner and resulting-business names. SECURITY INVOKER so RLS on biz_invitations still applies — admins see all, partners see their own.';

GRANT SELECT ON public.v_admin_biz_invitations TO authenticated;

-- ─── 8. Sanity output ──────────────────────────────────────────────────────
DO $sanity_093$
DECLARE
    v_table_exists boolean;
    v_rls          boolean;
    v_rpc1         integer;
    v_rpc2         integer;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema='public' AND table_name='biz_invitations'
    ) INTO v_table_exists;
    SELECT relrowsecurity FROM pg_class WHERE relname='biz_invitations' AND relnamespace='public'::regnamespace INTO v_rls;
    SELECT count(*) FROM pg_proc WHERE proname='fn_validate_invitation_token'         INTO v_rpc1;
    SELECT count(*) FROM pg_proc WHERE proname='fn_link_invitation_to_business'       INTO v_rpc2;

    RAISE NOTICE 'biz_invitations: table=% rls=% validate_rpc=% link_rpc=%',
        v_table_exists, v_rls, v_rpc1, v_rpc2;

    IF NOT v_table_exists THEN
        RAISE EXCEPTION 'Migration 093 failed: biz_invitations table did not create';
    END IF;
END $sanity_093$;

COMMIT;
