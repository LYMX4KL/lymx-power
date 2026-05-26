-- =============================================================================
-- Migration 099 — Module 5 follow-up: guard_lymx_issuance accepts businesses
-- =============================================================================
-- After migration 098 unified the issuance pipeline on lymx_issuances, the
-- first real issuance attempt failed with "Unknown business_id %". Root cause:
-- the guard_lymx_issuance() trigger (migration 012) only validated
-- business_id against `business_partners` — a legacy table that predates the
-- modern `businesses` schema.
--
-- The modern issuance EF (Module 5) passes a `businesses.id` value. The
-- trigger needs to accept both shapes during the transition:
--
--   - Primary path: look up the modern `businesses` row. Map fields:
--       biz_active = (approval_status='approved' AND archived_at IS NULL AND demo_only=false)
--       biz_owner_user_ids = ARRAY[owner_user_id]
--       biz_blocked_email_domains = NULL (modern biz config doesn't carry this)
--       biz_max_signups_per_hour = 500 (default cap)
--
--   - Fallback: business_partners (legacy partner-signup + business-signup-bonus
--     EFs still pass these ids).
--
-- Velocity check now exempts `reason='redemption'` rows — redemptions are
-- spending, not issuance, and shouldn't count against the per-hour cap.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.guard_lymx_issuance()
RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE
    biz_modern record;
    biz_legacy record;
    biz_slug text;
    biz_active boolean;
    biz_owner_user_ids uuid[];
    biz_blocked_email_domains text[];
    biz_max_signups_per_hour int;
    recent_count int;
BEGIN
    IF new.business_id IS NULL THEN RETURN new; END IF;

    -- Try modern businesses table first
    SELECT id, slug, approval_status, archived_at, demo_only, owner_user_id
      INTO biz_modern
      FROM public.businesses WHERE id = new.business_id;

    IF FOUND THEN
        biz_slug := biz_modern.slug;
        biz_active := (biz_modern.approval_status = 'approved' AND biz_modern.archived_at IS NULL AND COALESCE(biz_modern.demo_only, false) = false);
        biz_owner_user_ids := ARRAY[biz_modern.owner_user_id];
        biz_blocked_email_domains := NULL;
        biz_max_signups_per_hour := 500;
    ELSE
        -- Legacy fallback
        SELECT * INTO biz_legacy FROM public.business_partners WHERE id = new.business_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Unknown business_id % (not in businesses or business_partners)', new.business_id;
        END IF;
        biz_slug := biz_legacy.slug;
        biz_active := biz_legacy.active;
        biz_owner_user_ids := biz_legacy.owner_user_ids;
        biz_blocked_email_domains := biz_legacy.blocked_email_domains;
        biz_max_signups_per_hour := biz_legacy.max_signups_per_hour;
    END IF;

    IF NOT biz_active THEN
        RAISE EXCEPTION 'Business % is inactive (or not approved)', biz_slug;
    END IF;

    -- HARD BLOCK 1: self-issuance
    IF biz_owner_user_ids IS NOT NULL AND new.recipient_user_id = ANY(biz_owner_user_ids) THEN
        RAISE EXCEPTION 'FRAUD BLOCK: Cannot issue LYMX to a business owner (% to %)', biz_slug, new.recipient_user_id;
    END IF;

    -- HARD BLOCK 2: blocked email domain (only legacy biz config carries this list)
    IF biz_blocked_email_domains IS NOT NULL THEN
        DECLARE
            recipient_email text;
            recipient_domain text;
        BEGIN
            SELECT email INTO recipient_email FROM auth.users WHERE id = new.recipient_user_id;
            IF recipient_email IS NOT NULL THEN
                recipient_domain := lower(split_part(recipient_email, '@', 2));
                IF recipient_domain = ANY(biz_blocked_email_domains) THEN
                    RAISE EXCEPTION 'FRAUD BLOCK: Recipient email domain % is on % blocklist', recipient_domain, biz_slug;
                END IF;
            END IF;
        END;
    END IF;

    -- HARD BLOCK 3: velocity limit (skip for redemptions — those are spending, not issuing)
    IF new.reason <> 'redemption' THEN
        SELECT count(*) INTO recent_count
          FROM public.lymx_issuances
         WHERE business_id = new.business_id
           AND created_at > now() - interval '1 hour'
           AND reason <> 'redemption';
        IF recent_count >= biz_max_signups_per_hour THEN
            RAISE EXCEPTION 'FRAUD BLOCK: % exceeded velocity limit (% per hour)', biz_slug, biz_max_signups_per_hour;
        END IF;
    END IF;

    RETURN new;
END $body$;
