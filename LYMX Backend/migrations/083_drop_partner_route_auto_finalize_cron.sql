-- =============================================================================
-- Migration 083: drop the partner-route auto-finalize cron + function
-- =============================================================================
-- Migration 082 created a pg_cron job that fired every 5 minutes and POSTed
-- {partner_id, force_welcome: true} to the partner-provision-email EF for any
-- partner_emails row missing a cloudflare_route_id. That was a band-aid for
-- the destination-verify-gate bug in the EF (CF refused to create routes for
-- unverified destinations).
--
-- 2026-05-24 (final) — inbound routing is now handled by the
-- `lymx-inbound-forwarder` Cloudflare Email Worker. The Worker does its own
-- partner_emails lookup at message-arrival time and forwards via Resend.
-- partner_emails.cloudflare_route_id is no longer used — and the cron has
-- nothing useful to do. Drop the cron + the function.
--
-- The Worker's lookup is idempotent and self-healing: when partner-signup
-- creates a new partner_emails row, the Worker auto-discovers it the next
-- time mail arrives for that address. No periodic sweep needed.
--
-- Notes:
--   * vault.secrets entry 'service_role_key' (created in migration 082)
--     stays — it's harmless and may be useful for future SECURITY DEFINER
--     workers that need to call EFs.
--   * partner_emails.cloudflare_route_id column stays for backward compat;
--     it's NULL for all rows going forward.
-- =============================================================================

-- 1. Unschedule the cron job by name (idempotent — succeeds even if absent)
DO $unsched$
BEGIN
    PERFORM cron.unschedule(jobid)
      FROM cron.job
      WHERE jobname = 'auto-finalize-partner-routes';
EXCEPTION WHEN OTHERS THEN
    -- pg_cron extension may not be reachable in some envs; ignore
    RAISE NOTICE 'Could not unschedule auto-finalize-partner-routes (may already be gone): %', SQLERRM;
END;
$unsched$;

-- 2. Drop the worker function
DROP FUNCTION IF EXISTS public.auto_finalize_partner_routes();

-- 3. Sanity check — confirm the job and function are gone
DO $check$
DECLARE
    v_jobs   int;
    v_funcs  int;
BEGIN
    SELECT COUNT(*) INTO v_jobs
      FROM cron.job WHERE jobname = 'auto-finalize-partner-routes';
    SELECT COUNT(*) INTO v_funcs
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'auto_finalize_partner_routes';
    RAISE NOTICE '[migration 083] cron jobs left: %, functions left: % (both should be 0)', v_jobs, v_funcs;
END;
$check$;
