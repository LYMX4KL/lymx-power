-- =============================================================================
-- Module 2 deploy bundle — paste into Supabase SQL Editor and Run
-- =============================================================================
-- This file is what you paste into https://supabase.com/dashboard/project/
-- apffootxzfwmtyjlnteo/sql/new and click Run. It does two things in one
-- transaction:
--
--   A. Applies migration 095 (request_more_info columns + v_admin_business_applications view)
--   B. Cleans up the "Test Prospect Coffee (Module 1 verify)" test row from
--      the M1 verification run, AND deletes the demo-prospect@test.lymxpower.com
--      auth user — per the M1 session memo cleanup item.
--
-- After this SQL runs successfully:
--   1. Deploy the biz-request-more-info Edge Function (see DEPLOY block at the
--      bottom of this file — it's actually a comment with the CLI command).
--   2. Push frontend with push.ps1 -Message "..."
--   3. Browser-verify on admin-business-applications.html.
-- =============================================================================

-- ─── PART A: Migration 095 ────────────────────────────────────────────────

BEGIN;

ALTER TABLE public.businesses
    ADD COLUMN IF NOT EXISTS request_more_info_at         timestamptz,
    ADD COLUMN IF NOT EXISTS requested_info_text          text,
    ADD COLUMN IF NOT EXISTS requested_info_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS requested_info_response_at   timestamptz,
    ADD COLUMN IF NOT EXISTS requested_info_response_text text;

COMMENT ON COLUMN public.businesses.request_more_info_at IS
  'Set when an admin clicked "Request more info" on the approval queue. The pair with requested_info_text is the question we sent.';
COMMENT ON COLUMN public.businesses.requested_info_text IS
  'Plain text question/blank-list the admin sent to the applicant. Shown verbatim in the email and on the admin queue card.';
COMMENT ON COLUMN public.businesses.requested_info_by IS
  'auth.users.id of the admin who clicked Request more info.';

DROP VIEW IF EXISTS public.v_admin_business_applications CASCADE;
CREATE VIEW public.v_admin_business_applications
WITH (security_invoker = on)
AS
SELECT
    b.id,
    b.slug,
    b.display_name,
    b.legal_name,
    b.category,
    b.contact_email,
    b.contact_phone,
    b.owner_user_id,
    b.approval_status,
    b.approved_at,
    b.approved_by,
    b.rejection_reason,
    b.created_at,
    b.issuance_rate,
    b.redemption_rate,
    b.demo_only,
    -- Intake fields (migration 078)
    b.ein                            AS intake_ein,
    b.business_license_number        AS intake_license,
    b.incorporation_state            AS intake_state,
    b.entity_type                    AS intake_entity_type,
    b.year_founded                   AS intake_year_founded,
    b.employee_count_range           AS intake_employee_count,
    b.website                        AS intake_website,
    b.operating_hours                AS intake_operating_hours,
    b.intake_completed_at            AS intake_completed_at,
    b.stripe_charges_enabled         AS intake_stripe_connected,
    -- Request more info (this migration)
    b.request_more_info_at,
    b.requested_info_text,
    b.requested_info_by,
    b.requested_info_response_at,
    b.requested_info_response_text,
    CASE
        WHEN b.request_more_info_at IS NULL THEN 'none'
        WHEN b.requested_info_response_at IS NULL THEN 'awaiting_response'
        ELSE 'responded'
    END                              AS info_request_state,
    -- Invitation source (migration 093)
    inv.id                           AS invitation_id,
    inv.invitation_token             AS invitation_token,
    inv.invited_by_user_id           AS invitation_invited_by_user_id,
    inv.assigned_partner_id          AS invitation_assigned_partner_id,
    inv_partner.display_name         AS invitation_partner_name,
    inv.notes                        AS invitation_notes,
    inv.signup_completed_at          AS invitation_signed_up_at,
    inv.created_at                   AS invitation_created_at,
    -- Doc counts (migration 078)
    COALESCE(doc_counts.total_docs,    0)    AS total_docs,
    COALESCE(doc_counts.verified_docs, 0)    AS verified_docs
  FROM public.businesses b
  LEFT JOIN public.biz_invitations inv
       ON inv.resulting_business_id = b.id
  LEFT JOIN public.partners inv_partner
       ON inv_partner.id = inv.assigned_partner_id
  LEFT JOIN LATERAL (
      SELECT
          COUNT(*)::int                                AS total_docs,
          COUNT(*) FILTER (WHERE verified = true)::int AS verified_docs
        FROM public.business_documents
       WHERE business_id = b.id
         AND superseded_by_id IS NULL
  ) doc_counts ON true;

COMMENT ON VIEW public.v_admin_business_applications IS
  'Admin-facing read of businesses + invitation source + doc-count rollup + intake-fields summary + request-more-info state. SECURITY INVOKER so RLS still applies.';

GRANT SELECT ON public.v_admin_business_applications TO authenticated;

COMMIT;

-- ─── PART B: M2e cleanup — M1 verify test prospect ─────────────────────────
-- The Module 1 browser-verify run created a real Pending application titled
-- "Test Prospect Coffee (Module 1 verify)" backed by the
-- demo-prospect@test.lymxpower.com auth user. Per the M1 session memo, clean
-- both up now that Module 2 is shipping.

DO $cleanup_m1$
DECLARE
    v_biz_id   uuid;
    v_user_id  uuid;
BEGIN
    -- 1) Find the test biz (match by display_name; safer than by slug because
    --    the slug got auto-generated and may differ from what we expect).
    SELECT id, owner_user_id
      INTO v_biz_id, v_user_id
      FROM public.businesses
     WHERE display_name = 'Test Prospect Coffee (Module 1 verify)'
        OR display_name ILIKE '%Test Prospect Coffee%'
     LIMIT 1;

    IF v_biz_id IS NOT NULL THEN
        -- Reject the biz instead of hard-delete so any FK references survive.
        UPDATE public.businesses
           SET approval_status   = 'rejected',
               rejection_reason  = 'Automated module 1 verify test, safe to clean up. Cleaned during Module 2 deploy 2026-05-26.',
               approved_by       = (SELECT id FROM auth.users WHERE email = 'zhongkennylin@gmail.com' LIMIT 1),
               approved_at       = now()
         WHERE id = v_biz_id;
        RAISE NOTICE 'Test prospect biz rejected: id=%', v_biz_id;
    ELSE
        RAISE NOTICE 'No "Test Prospect Coffee" biz found — already cleaned up?';
    END IF;

    -- 2) Also delete the demo-prospect@test.lymxpower.com auth user if it's
    --    still around. auth.users DELETE is privileged but allowed inside this
    --    DO block (service role). The cascade will clean any orphaned
    --    references through ON DELETE SET NULL.
    DELETE FROM auth.users
     WHERE email IN (
         'demo-prospect@test.lymxpower.com',
         'demo-prospect@lymxpower.com'
     )
    RETURNING id INTO v_user_id;

    IF v_user_id IS NOT NULL THEN
        RAISE NOTICE 'Auth user demo-prospect deleted: id=%', v_user_id;
    ELSE
        RAISE NOTICE 'No demo-prospect auth user found — already cleaned up?';
    END IF;
END $cleanup_m1$;


-- ─── PART C: Smoke-test the new view ─────────────────────────────────────
-- Run this manually after the migration applies — confirms the view returns
-- rows AND that the joins didn't accidentally explode the count.

SELECT approval_status, COUNT(*) AS n_real_apps
  FROM public.v_admin_business_applications
 WHERE demo_only = false
 GROUP BY approval_status
 ORDER BY approval_status;

-- Expect something like:
--   approval_status | n_real_apps
--   ----------------+-------------
--   approved        | 1
--   pending         | 1   <- Helen's old test or other real apps; NOT the rejected test prospect
--   rejected        | 1   <- the test prospect we just rejected


-- =============================================================================
-- DEPLOY THE EDGE FUNCTION (after the SQL above succeeds)
-- =============================================================================
-- From PowerShell on the laptop:
--
--   cd C:\Users\Kenny\Desktop\Gemini\LYMX Backend
--   supabase functions deploy biz-request-more-info --project-ref apffootxzfwmtyjlnteo
--
-- (If you don't have the supabase CLI:
--   npm install -g supabase
-- or download from https://supabase.com/docs/guides/cli)
--
-- The EF source is at:
--   LYMX Backend/functions/biz-request-more-info/index.ts
--
-- Verify deploy:
--   curl -X POST https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/biz-request-more-info \
--     -H "Content-Type: application/json" \
--     -H "Authorization: Bearer <admin-jwt>" \
--     -d '{"business_id":"<some-uuid>","requested_info_text":"test"}'
-- =============================================================================
