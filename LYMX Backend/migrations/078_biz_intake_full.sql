-- =============================================================================
-- Migration 078 — Full biz-intake schema (legal/tax/hours/promos + docs + comms audit)
-- =============================================================================
-- Added 2026-05-24 to support Susan's launch batch of business signups.
-- Three things in one migration:
--
--   1. Expand businesses with legal/tax/operations fields (EIN, license,
--      entity_type, operating_hours, current_promos, website, etc.).
--   2. Create business_documents table + matching storage bucket so owners
--      can upload license PDFs, EIN letters, insurance certs, etc., with
--      an admin-verification flag.
--   3. Link email_events + sms_messages to a business so we can render a
--      complete communications history on the business profile (who sent
--      what, when, from where).
--
-- Sensitivity notes
-- -----------------
--   - EIN is a federal tax identifier. We store it but lock RLS so only
--     the business owner and admin staff can read it. Public endpoints
--     never select it.
--   - We DO NOT store bank account or routing numbers anywhere. Payouts
--     go through Stripe Connect (stripe_connect_account_id on businesses,
--     stripe-connect-onboarding EF). Anyone who fills a bank number into
--     a form on our site is collected by Stripe directly, not by us.
-- =============================================================================

BEGIN;

-- ─── 1. Expand businesses with legal/tax/operations columns ────────────────
ALTER TABLE public.businesses
    ADD COLUMN IF NOT EXISTS ein                       text,
    ADD COLUMN IF NOT EXISTS business_license_number   text,
    ADD COLUMN IF NOT EXISTS incorporation_state       text,
    ADD COLUMN IF NOT EXISTS entity_type               text,
    ADD COLUMN IF NOT EXISTS year_founded              int,
    ADD COLUMN IF NOT EXISTS employee_count_range      text,
    ADD COLUMN IF NOT EXISTS website                   text,
    ADD COLUMN IF NOT EXISTS social_links              jsonb DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS operating_hours           jsonb DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS current_promos            jsonb DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS intake_completed_at       timestamptz;

-- Constrain entity_type to a known set (the form is a dropdown).
ALTER TABLE public.businesses
    DROP CONSTRAINT IF EXISTS businesses_entity_type_known;
ALTER TABLE public.businesses
    ADD  CONSTRAINT businesses_entity_type_known
    CHECK (entity_type IS NULL OR entity_type IN (
        'sole_proprietorship',
        'llc',
        'corporation',
        's_corporation',
        'partnership',
        'nonprofit',
        'other'
    ));

-- Sanity-check EIN format (NN-NNNNNNN), but allow NULL since some businesses
-- haven't applied for one yet (sole proprietorships using SSN, for instance —
-- we DO NOT collect SSNs).
ALTER TABLE public.businesses
    DROP CONSTRAINT IF EXISTS businesses_ein_format;
ALTER TABLE public.businesses
    ADD  CONSTRAINT businesses_ein_format
    CHECK (ein IS NULL OR ein ~ '^\d{2}-\d{7}$');

-- year_founded sanity (cap at next year so future-dated registrations work).
ALTER TABLE public.businesses
    DROP CONSTRAINT IF EXISTS businesses_year_founded_sane;
ALTER TABLE public.businesses
    ADD  CONSTRAINT businesses_year_founded_sane
    CHECK (year_founded IS NULL OR (year_founded BETWEEN 1700 AND extract(year from now())::int + 1));

-- ─── 2. business_documents table ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.business_documents (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    doc_type              text NOT NULL,
    file_path             text NOT NULL,
    file_name             text,
    file_size_bytes       bigint,
    mime_type             text,
    uploaded_by_user_id   uuid NOT NULL,
    uploaded_at           timestamptz NOT NULL DEFAULT now(),
    verified              boolean NOT NULL DEFAULT false,
    verified_by_user_id   uuid,
    verified_at           timestamptz,
    rejection_reason      text,
    notes                 text,
    superseded_by_id      uuid REFERENCES public.business_documents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS business_documents_business_idx ON public.business_documents(business_id);
CREATE INDEX IF NOT EXISTS business_documents_unverified_idx
    ON public.business_documents(business_id, doc_type)
    WHERE verified = false AND superseded_by_id IS NULL;

-- Constrain doc_type to a known set. Operators can request new types via
-- adding values; the form should mirror this list.
ALTER TABLE public.business_documents
    DROP CONSTRAINT IF EXISTS business_documents_type_known;
ALTER TABLE public.business_documents
    ADD  CONSTRAINT business_documents_type_known
    CHECK (doc_type IN (
        'business_license',
        'ein_letter',
        'articles_of_incorporation',
        'operating_agreement',
        'dba_certificate',
        'sales_tax_permit',
        'insurance_certificate',
        'food_service_permit',
        'health_permit',
        'liquor_license',
        'professional_license',
        'other'
    ));

ALTER TABLE public.business_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS biz_docs_owner_read   ON public.business_documents;
DROP POLICY IF EXISTS biz_docs_owner_write  ON public.business_documents;
DROP POLICY IF EXISTS biz_docs_admin_all    ON public.business_documents;

-- Owners can read + insert their own docs. Admin RLS handled by am_i_admin().
CREATE POLICY biz_docs_owner_read ON public.business_documents
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.businesses b
            WHERE b.id = business_documents.business_id
              AND b.owner_user_id = auth.uid()
        )
    );

CREATE POLICY biz_docs_owner_write ON public.business_documents
    FOR INSERT WITH CHECK (
        uploaded_by_user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.businesses b
            WHERE b.id = business_documents.business_id
              AND b.owner_user_id = auth.uid()
        )
    );

CREATE POLICY biz_docs_admin_all ON public.business_documents
    FOR ALL USING (public.am_i_admin())
    WITH CHECK (public.am_i_admin());

-- ─── 3. Storage bucket for the actual file blobs ──────────────────────────
-- Storage policies live in storage.objects. We use a dedicated bucket so
-- the existing avatars bucket isn't polluted.
INSERT INTO storage.buckets (id, name, public)
VALUES ('business-documents', 'business-documents', false)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: object path convention is `<business_id>/<doc_type>/<filename>`.
-- Read: owner of that business OR admin.
-- Write: owner of that business OR admin.
DROP POLICY IF EXISTS biz_docs_storage_read  ON storage.objects;
DROP POLICY IF EXISTS biz_docs_storage_write ON storage.objects;

CREATE POLICY biz_docs_storage_read ON storage.objects
    FOR SELECT USING (
        bucket_id = 'business-documents'
        AND (
            public.am_i_admin()
            OR EXISTS (
                SELECT 1 FROM public.businesses b
                WHERE b.id::text = split_part(name, '/', 1)
                  AND b.owner_user_id = auth.uid()
            )
        )
    );

CREATE POLICY biz_docs_storage_write ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'business-documents'
        AND (
            public.am_i_admin()
            OR EXISTS (
                SELECT 1 FROM public.businesses b
                WHERE b.id::text = split_part(name, '/', 1)
                  AND b.owner_user_id = auth.uid()
            )
        )
    );

-- ─── 4. Communications audit: link email_sends + sms_messages to a biz ──
-- Note: email_events is the per-EVENT log (opened/clicked/bounced) keyed by
-- email_send_id. The per-MESSAGE row (with subject, body, recipients, send
-- status) lives on email_sends. We attach business_id to the sends row so
-- the biz-comms timeline can query "every email + SMS for this business".
ALTER TABLE public.email_sends
    ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL;

ALTER TABLE public.sms_messages
    ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS email_sends_business_idx   ON public.email_sends(business_id)   WHERE business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_messages_business_idx  ON public.sms_messages(business_id)  WHERE business_id IS NOT NULL;

-- Unified biz comms timeline. Subject + body_preview both come from the
-- per-message tables, not from the event log. send_status carries the
-- current state of the message (queued/sent/delivered/failed).
CREATE OR REPLACE VIEW public.v_business_communications AS
    SELECT
        'email'::text                                          AS channel,
        es.id                                                  AS id,
        es.business_id                                         AS business_id,
        es.template_key                                        AS kind,
        es.to_address                                          AS recipient,
        es.from_address                                        AS sender,
        es.subject                                             AS subject,
        NULL::text                                             AS body_preview,
        es.sender_user_id                                      AS actor_user_id,
        COALESCE(es.delivered_at, es.sent_at, es.created_at)   AS occurred_at,
        es.send_status                                         AS send_status,
        es.feedback_id                                         AS related_id
    FROM public.email_sends es
    WHERE es.business_id IS NOT NULL
    UNION ALL
    SELECT
        'sms'::text                                            AS channel,
        sm.id                                                  AS id,
        sm.business_id                                         AS business_id,
        ('sms_' || COALESCE(sm.direction, 'unknown'))          AS kind,
        sm.to_number                                           AS recipient,
        sm.from_number                                         AS sender,
        NULL::text                                             AS subject,
        substring(sm.body for 200)                             AS body_preview,
        sm.sender_user_id                                      AS actor_user_id,
        COALESCE(sm.delivered_at, sm.created_at)               AS occurred_at,
        sm.send_status                                         AS send_status,
        sm.feedback_id                                         AS related_id
    FROM public.sms_messages sm
    WHERE sm.business_id IS NOT NULL;

GRANT SELECT ON public.v_business_communications TO authenticated;

-- ─── 5. Helper: get full biz profile (sensitive fields stripped for non-admin/owner) ──
CREATE OR REPLACE FUNCTION public.fn_business_intake_summary(p_business_id uuid)
RETURNS TABLE (
    field text,
    value text,
    is_set boolean
) LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $intake_summary$
    SELECT 'EIN'                       AS field, COALESCE(ein,'(not set)')                     AS value, ein IS NOT NULL                     AS is_set FROM public.businesses WHERE id = p_business_id
    UNION ALL
    SELECT 'Business license number',  COALESCE(business_license_number,'(not set)'),         business_license_number IS NOT NULL                 FROM public.businesses WHERE id = p_business_id
    UNION ALL
    SELECT 'Incorporation state',      COALESCE(incorporation_state,'(not set)'),             incorporation_state IS NOT NULL                     FROM public.businesses WHERE id = p_business_id
    UNION ALL
    SELECT 'Entity type',              COALESCE(entity_type,'(not set)'),                     entity_type IS NOT NULL                             FROM public.businesses WHERE id = p_business_id
    UNION ALL
    SELECT 'Year founded',             COALESCE(year_founded::text,'(not set)'),              year_founded IS NOT NULL                            FROM public.businesses WHERE id = p_business_id
    UNION ALL
    SELECT 'Employee count',           COALESCE(employee_count_range,'(not set)'),            employee_count_range IS NOT NULL                    FROM public.businesses WHERE id = p_business_id
    UNION ALL
    SELECT 'Website',                  COALESCE(website,'(not set)'),                         website IS NOT NULL                                 FROM public.businesses WHERE id = p_business_id
    UNION ALL
    SELECT 'Operating hours',          CASE WHEN operating_hours='{}'::jsonb THEN '(not set)' ELSE operating_hours::text END,
                                       operating_hours <> '{}'::jsonb                                                                            FROM public.businesses WHERE id = p_business_id
    UNION ALL
    SELECT 'Stripe Connect',           CASE WHEN stripe_charges_enabled THEN 'connected' ELSE '(not connected)' END,
                                       stripe_charges_enabled                                                                                    FROM public.businesses WHERE id = p_business_id;
$intake_summary$;

REVOKE ALL ON FUNCTION public.fn_business_intake_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_business_intake_summary(uuid) TO authenticated;

COMMIT;
