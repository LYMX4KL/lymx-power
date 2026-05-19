-- =============================================================================
-- Migration 050 — pg_cron schedule for daily fraud-scan EF
-- =============================================================================
-- Runs the fraud-scan Edge Function every day at 04:30 UTC (~21:30 PT the day
-- before) so admin sees fresh flags first thing in the morning.
--
-- Detects:
--   1. burst_issuance — 5× spike in a single biz's daily LYMX issuance
--   2. arbitrage_loop — biz owner redeems their own LYMX at another biz
--   3. concentration — single recipient gets >50% of a biz's weekly LYMX
--   4. stale_open_flags — auto-escalates flags untouched after 7 days
--
-- Idempotent. Safe to re-run.
-- =============================================================================

-- Ensure required extensions
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Unschedule any prior job with this name
do $$
declare
    v_jobid bigint;
begin
    select jobid into v_jobid from cron.job where jobname = 'lymx_fraud_scan_daily';
    if v_jobid is not null then
        perform cron.unschedule(v_jobid);
    end if;
end$$;

-- Schedule: every day at 04:30 UTC
select cron.schedule(
    'lymx_fraud_scan_daily',
    '30 4 * * *',
    $$
    select net.http_post(
        url := 'https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/fraud-scan',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
        ),
        body := '{}'::jsonb
    );
    $$
);

select 'migration 050 applied' as status,
       (select count(*) from cron.job where jobname = 'lymx_fraud_scan_daily') as cron_jobs;
