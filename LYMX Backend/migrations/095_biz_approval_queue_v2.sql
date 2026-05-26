-- =============================================================================
-- Migration 095 — Module 2 of biz-onboarding roadmap: Approval queue v2
-- =============================================================================
-- The audit doc (audits/BIZ-ONBOARDING-GAPS-2026-05-26.md § Step 3) found three
-- gaps in the existing approval queue:
--
--   1. No surfacing of "where this signup came from" (which invitation, which
--      partner). Module 1 / migration 093 added biz_invitations.resulting_business_id;
--      this migration surfaces it through a single admin view.
--
--   2. No surfacing of intake docs uploaded during signup. Migration 078 added
--      businesses.ein/license/hours/etc. and the business_documents table; the
--      admin row didn't render any of it.
--
--   3. No "ask for more info" status. In practice many real applications need a
--      back-and-forth before approve/reject. Today admins can only flip between
--      pending and approved/rejected; there's no slot for "we sent them an email
--      asking for their business license and we're waiting on a reply."
--
-- This migration:
--   - Adds 5 columns to businesses to track the request-more-info workflow.
--   - Creates `v_admin_business_applications` view that joins businesses with
--     biz_invitations + partners + an aggregate of business_documents so the
--     admin UI can render everything in a single query.
--
-- Module 2's EF (biz-request-more-info) and the admin-business-applications.html
-- UI changes land alongside this migration. The EF writes to the new columns
-- and sends a Resend email to the applicant.
--
-- IMPORTANT — auth.users join trap:
--   The new view deliberately does NOT join auth.users. Per memory
--   [[feedback-lymx-security-invoker-view-trap]], a SECURITY INVOKER view that
--   joins auth.users returns silent empty rows because RLS on auth.users blocks
--   the join for the authenticated role. Inviter identity is surfaced via the
--   partners table (which is in public schema) and via the requested_info_by
--   uuid that the frontend resolves separately if it needs the email.
-- =============================================================================

BEGIN;

-- ─── 1. Request-more-info columns on businesses ────────────────────────────
ALTER TABLE public.businesses
    ADD COLUMN IF NOT EXISTS request_more_info_at         timestamptz,
    ADD COLUMN IF NOT EXISTS requested_info_text          text,
    ADD COLUMN IF NOT EXISTS requested_info_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS requested_info_response_at   timestamptz,
    ADD COLUMN IF NOT EXISTS requested_info_response_text text;

COMMENT ON COLUMN public.businesses.request_more_info_at IS
  'Set when an admin clicked "Request more info" on the approval queue. The pair with requested_info_text is the question we sent. When the applicant replies and the admin records the reply, requested_info_response_at + requested_info_response_text fill in. The columns are NOT cleared on approve/reject so the audit trail persists.';
COMMENT ON COLUMN public.businesses.requested_info_text IS
  'Plain text question/blank-list the admin sent to the applicant. Shown verbatim in the email and on the admin queue card. Free-form; admin types whatever they want to ask.';
COMMENT ON COLUMN public.businesses.requested_info_by IS
  'auth.users.id of the admin who clicked Request more info. Used for attribution + so we know who to ping when the reply comes in.';

-- ─── 2. v_admin_business_applications view ─────────────────────────────────
-- Powers the Pending / Approved / Rejected tabs of admin-business-applications.html.
-- Joins businesses with biz_invitations (Module 1 — where this signup came from)
-- + partners (who sent the invite, if any) + aggregated business_documents counts
-- (from migration 078).
--
-- security_invoker = on so RLS on businesses still applies — a non-admin caller
-- sees only their own business if any. The admin RLS policy on businesses
-- (via am_i_admin()) gives admins the full list.

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

    -- Invitation source (migration 093) — LEFT JOIN since not every signup
    -- came from an invite (some prospects find biz-signup.html directly).
    inv.id                           AS invitation_id,
    inv.invitation_token             AS invitation_token,
    inv.invited_by_user_id           AS invitation_invited_by_user_id,
    inv.assigned_partner_id          AS invitation_assigned_partner_id,
    inv_partner.display_name         AS invitation_partner_name,
    inv.notes                        AS invitation_notes,
    inv.signup_completed_at          AS invitation_signed_up_at,
    inv.created_at                   AS invitation_created_at,

    -- Doc counts (migration 078). LATERAL so the COUNTs roll up per business
    -- even when there are zero docs.
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
  'Admin-facing read of businesses + invitation source + doc-count rollup + intake-fields summary + request-more-info state. SECURITY INVOKER so RLS on businesses still applies — admins see all via am_i_admin() policy, owners see only their own.';

GRANT SELECT ON public.v_admin_business_applications TO authenticated;

-- ─── 3. Sanity output ──────────────────────────────────────────────────────
DO $sanity_095$
DECLARE
    v_view_exists boolean;
    v_col_count   integer;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.views
         WHERE table_schema='public' AND table_name='v_admin_business_applications'
    ) INTO v_view_exists;

    SELECT count(*) FROM information_schema.columns
        WHERE table_schema='public' AND table_name='businesses'
        AND column_name IN (
            'request_more_info_at',
            'requested_info_text',
            'requested_info_by',
            'requested_info_response_at',
            'requested_info_response_text'
        )
    INTO v_col_count;

    RAISE NOTICE 'Module 2 migration 095: view=% new_cols=%/5', v_view_exists, v_col_count;

    IF NOT v_view_exists THEN
        RAISE EXCEPTION 'Migration 095 failed: v_admin_business_applications view did not create';
    END IF;
    IF v_col_count <> 5 THEN
        RAISE EXCEPTION 'Migration 095 failed: expected 5 new request-more-info columns on businesses, got %', v_col_count;
    END IF;
END $sanity_095$;

COMMIT;
