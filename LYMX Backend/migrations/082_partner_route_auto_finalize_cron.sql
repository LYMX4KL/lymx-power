-- =============================================================================
-- Migration 082: auto-finalize stuck partner Cloudflare routes via pg_cron
-- =============================================================================
-- Root-cause fix for the Cloudflare-destination-pending trap, second half.
--
-- Problem after migration 081 + partner-provision-email EF patch (2026-05-24):
--   New partner provisions → CF destination pending → route not created (EF
--   bails gracefully). Partner later clicks the CF verify link in their gmail
--   → destination becomes verified. BUT nothing automatically creates the
--   route at that point. The patched EF will create the route on the next
--   force_welcome call, but that call has to come from somewhere.
--
-- Fix:
--   A SECURITY DEFINER SQL function scans partner_emails every 5 minutes
--   for rows with cloudflare_route_id IS NULL AND status = 'active'. For
--   each, it POSTs {partner_id, force_welcome: true} to the
--   partner-provision-email EF via pg_net. The EF re-checks Cloudflare
--   destination status — if now verified, creates the route. Idempotent.
--
--   This means: once a partner clicks the CF verify link, their route gets
--   created within 5 minutes — automatically, with zero admin intervention,
--   zero dashboard clicks, zero user-facing button. The system self-heals.
--
-- Per architecture rule (no band-aid): this is the second half of the
-- root-cause fix. The EF patch (route-retry inside force_welcome) is the
-- mechanism. The cron is the trigger. Together they close the gap.
-- =============================================================================

-- 0. Pre-reqs: pg_cron + pg_net extensions
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- 1. The worker function — finds stuck rows, POSTs to EF for each
CREATE OR REPLACE FUNCTION public.auto_finalize_partner_routes()
RETURNS TABLE(partner_email_id uuid, partner_id uuid, full_email text, request_id bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, net
AS $auto_finalize$
DECLARE
    v_ef_url    text;
    v_service_key text;
    v_row       record;
    v_req_id    bigint;
BEGIN
    -- Read config from Vault (service role key) and a project-config table.
    -- The EF URL is constructed from the standard Supabase project ref.
    v_ef_url    := 'https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/partner-provision-email';
    v_service_key := current_setting('app.settings.service_role_key', true);
    IF v_service_key IS NULL OR v_service_key = '' THEN
        -- Fallback: try Vault secret. If neither is set, log and bail without erroring.
        BEGIN
            SELECT decrypted_secret INTO v_service_key
            FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;
        EXCEPTION WHEN OTHERS THEN
            v_service_key := NULL;
        END;
    END IF;
    IF v_service_key IS NULL OR v_service_key = '' THEN
        RAISE NOTICE '[auto_finalize_partner_routes] service_role_key not configured (set app.settings.service_role_key or vault.secrets); skipping run';
        RETURN;
    END IF;

    -- Scan for partner_emails rows that are active but missing a CF route.
    FOR v_row IN
        SELECT pe.id AS partner_email_id, pe.partner_id, pe.full_email
        FROM public.partner_emails pe
        WHERE pe.status = 'active'
          AND pe.cloudflare_route_id IS NULL
        ORDER BY pe.created_at ASC
        LIMIT 25  -- batch cap so a backlog doesn't flood the EF
    LOOP
        -- Fire-and-forget POST to the EF via pg_net (async, returns request id).
        SELECT net.http_post(
            url     := v_ef_url,
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer ' || v_service_key
            ),
            body    := jsonb_build_object(
                'partner_id', v_row.partner_id,
                'force_welcome', true
            )
        ) INTO v_req_id;

        partner_email_id := v_row.partner_email_id;
        partner_id       := v_row.partner_id;
        full_email       := v_row.full_email;
        request_id       := v_req_id;
        RETURN NEXT;
    END LOOP;
END;
$auto_finalize$;

-- 2. Schedule every 5 minutes via pg_cron
--    Use uniquely-named job; safe-drop the old one first if re-running.
DO $sched$
BEGIN
    -- Unschedule prior runs by name (idempotent re-deploy)
    PERFORM cron.unschedule(jobid)
      FROM cron.job
      WHERE jobname = 'auto-finalize-partner-routes';
EXCEPTION WHEN OTHERS THEN
    -- ignore if cron schema not yet available in this rare race
    NULL;
END;
$sched$;

SELECT cron.schedule(
    'auto-finalize-partner-routes',
    '*/5 * * * *',
    $cronfn$SELECT public.auto_finalize_partner_routes();$cronfn$
);

-- 3. Grants — admin can read the function output for monitoring; cron runs as
--    superuser via pg_cron so no explicit EXECUTE grant needed for the schedule.
GRANT EXECUTE ON FUNCTION public.auto_finalize_partner_routes() TO postgres;

-- 4. Sanity check — fire one immediate run so any partners stuck right now
--    (Helen, Susan, future) get their first attempt within seconds, not 5 min.
SELECT * FROM public.auto_finalize_partner_routes();
