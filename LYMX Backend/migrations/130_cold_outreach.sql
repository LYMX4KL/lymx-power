-- =============================================================================
-- Migration 130 - Cold outreach platform (mirror of InvestPro PM db/035, adapted)
-- =============================================================================
-- The data layer for LYMX's cold-prospecting email system, used to onboard new
-- businesses (and partners/customers) via the COLD lane (joinlymx.com via
-- Mailgun). Replies funnel through Cloudflare Email Routing back to the HOT
-- lane (getlymx.com via Resend/SES) where conversations live.
--
-- Architecture reference:
--   shared accross projects/COMPANY-EMAIL-ARCHITECTURE.md (Two-Lane Rule)
--   shared accross projects/STACK-PLAYBOOK.md
--   LYMX Backend/LYMX-COLD-OUTREACH-SETUP.md  (operations runbook - see mig 130 ops phase)
--
-- Mirror source:
--   investpro-pm-git/InvestPro PM/db/035_outreach.sql
--
-- LYMX-specific adaptations vs. InvestPro:
--   * All 7 tables prefixed `outreach_` (LYMX already has public.leads from
--     mig 040 for the partner CRM - hard collision otherwise).
--   * Audience enum reflects LYMX's prospecting context, not real estate:
--       business_prospect | partner_prospect | customer_prospect | other
--   * created_by_id -> created_by_user_id REFERENCES auth.users(id).
--     No public.profiles table in LYMX; we key off auth.users.
--   * converted_subscriber_id -> converted_user_id REFERENCES auth.users(id).
--     LYMX has no subscribers table; the new user could be a customer, partner,
--     or business owner - all live in auth.users.
--   * Trigger function: public.set_updated_at() (LYMX standard) instead of
--     touch_updated_at (InvestPro standard).
--   * RLS gate: public.am_i_admin() (LYMX strict-role check from mig 102)
--     instead of current_user_role() IN ('broker','compliance','admin_onsite').
--   * No audit_trigger_fn invocations (LYMX uses no shared audit fn yet;
--     append-only outreach_unsubscribes / outreach_bounces tables ARE the
--     compliance audit record).
--   * Default provider 'mailgun' (LYMX cold lane), not 'resend'.
--
-- Tables created:
--   1. outreach_lead_lists          - named buckets ("LV biz owners 2026-Q3")
--   2. outreach_leads               - individual prospects (globally unique email)
--   3. outreach_lead_list_members   - many-to-many: a lead can be in N lists
--   4. outreach_campaigns           - a sending job (list x template)
--   5. outreach_sends               - one row per send attempt
--   6. outreach_unsubscribes        - append-only CAN-SPAM record
--   7. outreach_bounces             - append-only deliverability log
--
-- Helper functions:
--   * outreach_lead_can_receive(lead_id, campaign_id) - eligibility check
--   * outreach_refresh_campaign_counts(campaign_id)   - sync cached counters
--   * outreach_leads_normalize_email()                - lowercase + trim trigger
--   * outreach_lead_list_members_refresh_counts()     - lead_count maintenance
--
-- Reputation aging: after Mailgun domain verification on joinlymx.com, wait
-- 7-14 days before the first real cold send. See ops runbook.
-- =============================================================================

BEGIN;

-- ----------------------------------------------------------------
-- 1. Enums
-- ----------------------------------------------------------------
DO $mig130_audience$ BEGIN
  CREATE TYPE public.outreach_audience AS ENUM (
    'business_prospect',   -- small businesses being pitched on LYMX rewards
    'partner_prospect',    -- recruits being pitched on Partner activation
    'customer_prospect',   -- consumers being pitched on signup bonus
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $mig130_audience$;

DO $mig130_lead_status$ BEGIN
  CREATE TYPE public.outreach_lead_status AS ENUM (
    'active',                  -- eligible to receive sends
    'unsubscribed',            -- user clicked unsubscribe / list-unsub
    'bounced_hard',            -- hard bounce (invalid address)
    'complained',              -- recipient marked as spam
    'manually_suppressed'      -- admin took the lead off the list
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $mig130_lead_status$;

DO $mig130_camp_status$ BEGIN
  CREATE TYPE public.outreach_campaign_status AS ENUM (
    'draft',
    'scheduled',
    'sending',
    'sent',
    'paused',
    'archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $mig130_camp_status$;

DO $mig130_send_status$ BEGIN
  CREATE TYPE public.outreach_send_status AS ENUM (
    'queued',
    'sending',
    'sent',          -- handed off to provider
    'delivered',     -- provider confirmed delivery
    'bounced',
    'complained',
    'failed',        -- internal/provider error pre-send
    'skipped'        -- excluded by outreach_lead_can_receive
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $mig130_send_status$;

DO $mig130_provider$ BEGIN
  CREATE TYPE public.outreach_provider AS ENUM ('mailgun', 'resend', 'ses');
EXCEPTION WHEN duplicate_object THEN NULL;
END $mig130_provider$;

DO $mig130_unsub_source$ BEGIN
  CREATE TYPE public.outreach_unsubscribe_source AS ENUM (
    'public_link',         -- click on the unsubscribe link in the email body
    'list_unsubscribe',    -- one-click via List-Unsubscribe header (Gmail/Outlook UI)
    'webhook',             -- provider-side unsubscribe (Mailgun dashboard)
    'manual_admin',        -- admin took them off the list manually
    'reply_unsubscribe'    -- lead replied with "unsubscribe" / "stop"
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $mig130_unsub_source$;


-- ----------------------------------------------------------------
-- 2. outreach_lead_lists - named buckets
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.outreach_lead_lists (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  description         TEXT,
  audience_type       public.outreach_audience NOT NULL DEFAULT 'other',

  -- Cached counts (refreshed by trigger on outreach_lead_list_members)
  lead_count          INT NOT NULL DEFAULT 0,
  active_lead_count   INT NOT NULL DEFAULT 0,

  created_by_user_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ                                   -- soft delete
);

CREATE INDEX IF NOT EXISTS idx_outreach_lead_lists_audience
  ON public.outreach_lead_lists(audience_type) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_outreach_lead_lists_touch ON public.outreach_lead_lists;
CREATE TRIGGER trg_outreach_lead_lists_touch
  BEFORE UPDATE ON public.outreach_lead_lists
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ----------------------------------------------------------------
-- 3. outreach_leads - individual prospects
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.outreach_leads (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity
  email               TEXT NOT NULL,                                  -- lowercased on insert
  first_name          TEXT,
  last_name           TEXT,
  phone               TEXT,

  -- Business-prospect extras (the business we are pitching on LYMX)
  business_name       TEXT,
  business_city       TEXT,
  business_state      TEXT,
  business_zip        TEXT,
  business_category   TEXT,                                            -- 'restaurant', 'salon', 'fitness', etc.

  -- Provenance
  source              TEXT,                                            -- 'biz_directory_scraper', 'csv_import', 'referral', 'manual'
  source_url          TEXT,
  imported_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  imported_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Status
  status              public.outreach_lead_status NOT NULL DEFAULT 'active',
  status_reason       TEXT,
  unsubscribed_at     TIMESTAMPTZ,
  bounced_at          TIMESTAMPTZ,
  complained_at       TIMESTAMPTZ,

  -- Send tracking (cached for fast suppression checks)
  send_count          INT NOT NULL DEFAULT 0,
  last_sent_at        TIMESTAMPTZ,

  -- Optional link if a lead later signs up as a real user (customer / partner / business)
  converted_user_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  converted_at        TIMESTAMPTZ,
  converted_role      TEXT,                                            -- 'customer' | 'partner' | 'business'

  -- Free-form notes (admin's manual annotations)
  notes               TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);

-- Globally unique email (case-insensitive). Soft-delete-aware via partial index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_outreach_leads_email_active
  ON public.outreach_leads(LOWER(email))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_outreach_leads_status
  ON public.outreach_leads(status, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outreach_leads_imported_at
  ON public.outreach_leads(imported_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outreach_leads_phone
  ON public.outreach_leads(phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outreach_leads_business_city
  ON public.outreach_leads(business_state, business_city) WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_outreach_leads_touch ON public.outreach_leads;
CREATE TRIGGER trg_outreach_leads_touch
  BEFORE UPDATE ON public.outreach_leads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Lowercase + trim email automatically on insert/update
CREATE OR REPLACE FUNCTION public.outreach_leads_normalize_email()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn_norm$
BEGIN
  IF NEW.email IS NOT NULL THEN
    NEW.email := lower(btrim(NEW.email));
  END IF;
  RETURN NEW;
END;
$fn_norm$;

DROP TRIGGER IF EXISTS trg_outreach_leads_normalize_email ON public.outreach_leads;
CREATE TRIGGER trg_outreach_leads_normalize_email
  BEFORE INSERT OR UPDATE OF email ON public.outreach_leads
  FOR EACH ROW EXECUTE FUNCTION public.outreach_leads_normalize_email();


-- ----------------------------------------------------------------
-- 4. outreach_lead_list_members - many-to-many
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.outreach_lead_list_members (
  lead_list_id        UUID NOT NULL REFERENCES public.outreach_lead_lists(id) ON DELETE CASCADE,
  lead_id             UUID NOT NULL REFERENCES public.outreach_leads(id) ON DELETE CASCADE,
  added_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  added_by_user_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  PRIMARY KEY (lead_list_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_outreach_lead_list_members_lead
  ON public.outreach_lead_list_members(lead_id);

-- Refresh outreach_lead_lists.lead_count when membership changes
CREATE OR REPLACE FUNCTION public.outreach_lead_list_members_refresh_counts()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn_refresh$
DECLARE
  v_list_id UUID;
BEGIN
  v_list_id := COALESCE(NEW.lead_list_id, OLD.lead_list_id);
  UPDATE public.outreach_lead_lists
     SET lead_count = (
           SELECT count(*) FROM public.outreach_lead_list_members WHERE lead_list_id = v_list_id
         ),
         active_lead_count = (
           SELECT count(*)
             FROM public.outreach_lead_list_members m
             JOIN public.outreach_leads l ON l.id = m.lead_id
            WHERE m.lead_list_id = v_list_id
              AND l.deleted_at IS NULL
              AND l.status = 'active'
         )
   WHERE id = v_list_id;
  RETURN NULL;
END;
$fn_refresh$;

DROP TRIGGER IF EXISTS trg_outreach_lead_list_members_count ON public.outreach_lead_list_members;
CREATE TRIGGER trg_outreach_lead_list_members_count
  AFTER INSERT OR DELETE ON public.outreach_lead_list_members
  FOR EACH ROW EXECUTE FUNCTION public.outreach_lead_list_members_refresh_counts();


-- ----------------------------------------------------------------
-- 5. outreach_campaigns - a sending job (lead_list x template)
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.outreach_campaigns (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  name                    TEXT NOT NULL,                       -- internal label
  audience_type           public.outreach_audience NOT NULL DEFAULT 'other',
  lead_list_id            UUID NOT NULL REFERENCES public.outreach_lead_lists(id) ON DELETE RESTRICT,

  -- From / Reply-To (Two-Lane Rule per COMPANY-EMAIL-ARCHITECTURE.md)
  -- Convention: From      = <name>@joinlymx.com   (cold lane, Mailgun)
  --             Reply-To  = <name>@joinlymx.com   (Cloudflare forwards to getlymx.com)
  from_address            TEXT NOT NULL,
  from_display_name       TEXT NOT NULL,
  reply_to_address        TEXT NOT NULL,

  -- Body templates (support {first_name}, {last_name}, {business_name}, {business_city}, {unsubscribe_url})
  subject_template        TEXT NOT NULL,
  body_html_template      TEXT NOT NULL,
  body_text_template      TEXT,                                -- optional plain-text fallback

  -- Throttling / safety
  daily_send_cap          INT NOT NULL DEFAULT 250,            -- per-day max sends for this campaign
  per_second_cap          INT NOT NULL DEFAULT 1,              -- soft rate limit
  resend_suppression_days INT NOT NULL DEFAULT 90,             -- don't re-send same lead within N days

  -- Provider (cold lane default)
  provider                public.outreach_provider NOT NULL DEFAULT 'mailgun',

  -- Lifecycle
  status                  public.outreach_campaign_status NOT NULL DEFAULT 'draft',
  scheduled_at            TIMESTAMPTZ,
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  archived_at             TIMESTAMPTZ,

  -- Cached aggregate counts (updated by trigger on outreach_sends)
  total_queued            INT NOT NULL DEFAULT 0,
  total_sent              INT NOT NULL DEFAULT 0,
  total_delivered         INT NOT NULL DEFAULT 0,
  total_bounced           INT NOT NULL DEFAULT 0,
  total_complained        INT NOT NULL DEFAULT 0,
  total_unsubscribed      INT NOT NULL DEFAULT 0,
  total_skipped           INT NOT NULL DEFAULT 0,

  created_by_user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_status
  ON public.outreach_campaigns(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_lead_list
  ON public.outreach_campaigns(lead_list_id);

DROP TRIGGER IF EXISTS trg_outreach_campaigns_touch ON public.outreach_campaigns;
CREATE TRIGGER trg_outreach_campaigns_touch
  BEFORE UPDATE ON public.outreach_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ----------------------------------------------------------------
-- 6. outreach_sends - one row per send attempt
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.outreach_sends (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id             UUID NOT NULL REFERENCES public.outreach_campaigns(id) ON DELETE CASCADE,
  lead_id                 UUID NOT NULL REFERENCES public.outreach_leads(id) ON DELETE CASCADE,

  -- Snapshots at queue time (so we can audit even if lead changes later)
  to_email                TEXT NOT NULL,
  rendered_subject        TEXT,
  rendered_body_html      TEXT,
  rendered_body_text      TEXT,
  unsubscribe_token       TEXT,                                -- per-send token in URL

  -- Lifecycle
  status                  public.outreach_send_status NOT NULL DEFAULT 'queued',
  queued_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sending_started_at      TIMESTAMPTZ,
  sent_at                 TIMESTAMPTZ,
  delivered_at            TIMESTAMPTZ,
  bounced_at              TIMESTAMPTZ,
  complained_at           TIMESTAMPTZ,
  failed_at               TIMESTAMPTZ,

  -- Provider details
  provider                public.outreach_provider NOT NULL DEFAULT 'mailgun',
  provider_message_id     TEXT,
  provider_response       JSONB,

  -- Failure / bounce details
  bounce_type             TEXT,
  bounce_subtype          TEXT,
  diagnostic_code         TEXT,
  error_message           TEXT,

  -- Engagement (filled by webhook events)
  opened_count            INT NOT NULL DEFAULT 0,
  first_opened_at         TIMESTAMPTZ,
  clicked_count           INT NOT NULL DEFAULT 0,
  first_clicked_at        TIMESTAMPTZ,
  last_event_at           TIMESTAMPTZ,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (campaign_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_outreach_sends_campaign_status
  ON public.outreach_sends(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_outreach_sends_lead
  ON public.outreach_sends(lead_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_outreach_sends_provider_msg
  ON public.outreach_sends(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outreach_sends_queued
  ON public.outreach_sends(status, queued_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_outreach_sends_unsub_token
  ON public.outreach_sends(unsubscribe_token) WHERE unsubscribe_token IS NOT NULL;

DROP TRIGGER IF EXISTS trg_outreach_sends_touch ON public.outreach_sends;
CREATE TRIGGER trg_outreach_sends_touch
  BEFORE UPDATE ON public.outreach_sends
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ----------------------------------------------------------------
-- 7. outreach_unsubscribes - append-only CAN-SPAM record
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.outreach_unsubscribes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT NOT NULL,                            -- lowercased
  lead_id             UUID REFERENCES public.outreach_leads(id) ON DELETE SET NULL,
  campaign_id         UUID REFERENCES public.outreach_campaigns(id) ON DELETE SET NULL,
  send_id             UUID REFERENCES public.outreach_sends(id) ON DELETE SET NULL,
  source              public.outreach_unsubscribe_source NOT NULL,
  reason              TEXT,
  ip_address          INET,
  user_agent          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_unsubs_email
  ON public.outreach_unsubscribes(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_outreach_unsubs_lead
  ON public.outreach_unsubscribes(lead_id);


-- ----------------------------------------------------------------
-- 8. outreach_bounces - append-only deliverability log
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.outreach_bounces (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT NOT NULL,
  lead_id             UUID REFERENCES public.outreach_leads(id) ON DELETE SET NULL,
  send_id             UUID REFERENCES public.outreach_sends(id) ON DELETE SET NULL,
  bounce_type         TEXT NOT NULL,                            -- 'hard', 'soft', 'complaint', 'block'
  bounce_subtype      TEXT,                                     -- e.g., 'mailbox_full', 'suppressed'
  diagnostic_code     TEXT,
  raw_payload         JSONB,                                    -- full webhook payload for forensics
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outreach_bounces_email
  ON public.outreach_bounces(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_outreach_bounces_send
  ON public.outreach_bounces(send_id);


-- ----------------------------------------------------------------
-- 9. RLS - admin (am_i_admin) manages everything
-- ----------------------------------------------------------------
-- LYMX rule: cold outreach is admin-only territory. The Netlify Functions
-- use the service_role key to bypass RLS for the public-facing flows
-- (unsubscribe page, webhook ingestion), so we don't need anon-role policies.
ALTER TABLE public.outreach_lead_lists        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_leads             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_lead_list_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_campaigns         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_sends             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_unsubscribes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_bounces           ENABLE ROW LEVEL SECURITY;

DO $mig130_rls$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'outreach_lead_lists',
    'outreach_leads',
    'outreach_lead_list_members',
    'outreach_campaigns',
    'outreach_sends',
    'outreach_unsubscribes',
    'outreach_bounces'
  ] LOOP
    EXECUTE format($f$
      DROP POLICY IF EXISTS %I_admin_all ON public.%I;
      CREATE POLICY %I_admin_all ON public.%I
        FOR ALL TO authenticated
        USING (public.am_i_admin())
        WITH CHECK (public.am_i_admin());
    $f$, t, t, t, t);
  END LOOP;
END $mig130_rls$;


-- ----------------------------------------------------------------
-- 10. Helper: outreach_lead_can_receive(lead_id, campaign_id)
-- ----------------------------------------------------------------
-- Encapsulates the suppression rule. Returns TRUE if the lead is
-- eligible to receive a send for the given campaign right now.
CREATE OR REPLACE FUNCTION public.outreach_lead_can_receive(
  p_lead_id     UUID,
  p_campaign_id UUID
) RETURNS TABLE (
  eligible      BOOLEAN,
  reason        TEXT
) LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = public, pg_temp
AS $fn_can$
DECLARE
  v_lead   RECORD;
  v_camp   RECORD;
  v_recent INT;
BEGIN
  SELECT * INTO v_lead FROM public.outreach_leads WHERE id = p_lead_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'lead_not_found'; RETURN;
  END IF;
  IF v_lead.deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT FALSE, 'lead_deleted'; RETURN;
  END IF;
  IF v_lead.status <> 'active' THEN
    RETURN QUERY SELECT FALSE, 'lead_status_' || v_lead.status::text; RETURN;
  END IF;
  IF v_lead.unsubscribed_at IS NOT NULL THEN
    RETURN QUERY SELECT FALSE, 'unsubscribed'; RETURN;
  END IF;
  IF v_lead.bounced_at IS NOT NULL THEN
    RETURN QUERY SELECT FALSE, 'previously_bounced'; RETURN;
  END IF;
  IF v_lead.complained_at IS NOT NULL THEN
    RETURN QUERY SELECT FALSE, 'previously_complained'; RETURN;
  END IF;

  SELECT * INTO v_camp FROM public.outreach_campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'campaign_not_found'; RETURN;
  END IF;

  -- Don't re-send to a lead within the suppression window
  SELECT count(*) INTO v_recent
    FROM public.outreach_sends
   WHERE lead_id = p_lead_id
     AND sent_at IS NOT NULL
     AND sent_at >= NOW() - (v_camp.resend_suppression_days || ' days')::interval;
  IF v_recent > 0 THEN
    RETURN QUERY SELECT FALSE, 'within_suppression_window'; RETURN;
  END IF;

  RETURN QUERY SELECT TRUE, NULL::text;
END;
$fn_can$;

GRANT EXECUTE ON FUNCTION public.outreach_lead_can_receive(UUID, UUID) TO authenticated;


-- ----------------------------------------------------------------
-- 11. Helper: outreach_refresh_campaign_counts(campaign_id)
-- ----------------------------------------------------------------
-- Recomputes the cached counters on outreach_campaigns from outreach_sends.
-- Called by the dispatch function after each batch and by a periodic job.
CREATE OR REPLACE FUNCTION public.outreach_refresh_campaign_counts(p_campaign_id UUID)
RETURNS VOID LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = public, pg_temp
AS $fn_refresh_counts$
BEGIN
  UPDATE public.outreach_campaigns SET
    total_queued       = (SELECT count(*) FROM public.outreach_sends WHERE campaign_id = p_campaign_id AND status = 'queued'),
    total_sent         = (SELECT count(*) FROM public.outreach_sends WHERE campaign_id = p_campaign_id AND status IN ('sent','delivered')),
    total_delivered    = (SELECT count(*) FROM public.outreach_sends WHERE campaign_id = p_campaign_id AND status = 'delivered'),
    total_bounced      = (SELECT count(*) FROM public.outreach_sends WHERE campaign_id = p_campaign_id AND status = 'bounced'),
    total_complained   = (SELECT count(*) FROM public.outreach_sends WHERE campaign_id = p_campaign_id AND status = 'complained'),
    total_skipped      = (SELECT count(*) FROM public.outreach_sends WHERE campaign_id = p_campaign_id AND status = 'skipped'),
    total_unsubscribed = (SELECT count(*) FROM public.outreach_unsubscribes
                            JOIN public.outreach_sends ON public.outreach_sends.id = public.outreach_unsubscribes.send_id
                           WHERE public.outreach_sends.campaign_id = p_campaign_id)
  WHERE id = p_campaign_id;
END;
$fn_refresh_counts$;

GRANT EXECUTE ON FUNCTION public.outreach_refresh_campaign_counts(UUID) TO authenticated;


-- ----------------------------------------------------------------
-- 12. Verify
-- ----------------------------------------------------------------
COMMIT;

SELECT 'outreach_lead_lists'        AS tbl, count(*) FROM public.outreach_lead_lists
UNION ALL SELECT 'outreach_leads',              count(*) FROM public.outreach_leads
UNION ALL SELECT 'outreach_lead_list_members',  count(*) FROM public.outreach_lead_list_members
UNION ALL SELECT 'outreach_campaigns',          count(*) FROM public.outreach_campaigns
UNION ALL SELECT 'outreach_sends',              count(*) FROM public.outreach_sends
UNION ALL SELECT 'outreach_unsubscribes',       count(*) FROM public.outreach_unsubscribes
UNION ALL SELECT 'outreach_bounces',            count(*) FROM public.outreach_bounces;
