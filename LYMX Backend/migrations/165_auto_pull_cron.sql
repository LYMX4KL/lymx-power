-- =============================================================================
-- Migration 165 — RECONCILIATION auto-pull for business integrations (Build B)
-- =============================================================================
-- Earn is INSTANT via real-time push: a business calls business-event at the
-- moment a fee is charged, so the customer gets their LYMX while they are still
-- paying. This pull is the SAFETY NET, not the primary path — it runs hourly to
-- catch any real-time push that failed to reach us (network blip, brief outage),
-- so nothing is ever permanently missed. Mirrors the mig-144 pg_cron + pg_net +
-- service-role worker pattern.
--
-- Safe to run repeatedly: pull-business-transactions advances since_cursor and
-- business-event is idempotent on external_ref, so a real-time push and a later
-- reconciliation pull of the same fee resolve to ONE issuance (the repeat is a
-- no-op). New integrations are picked up automatically (the worker reads the
-- source table each run — no per-business scheduling).
-- =============================================================================

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- 1. cron worker: fire the pull EF for each ACTIVE source ----------------------
create or replace function public.run_lymx_auto_pull()
returns integer
language plpgsql security definer set search_path = public, extensions, net
as $worker$
declare
    v_ef_url      text := 'https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/pull-business-transactions';
    v_service_key text;
    v_row         record;
    v_count       integer := 0;
begin
    -- Resolve the service-role key the same way mig 144 does (settings or vault).
    -- pull-business-transactions is verify_jwt=false, so the call works without
    -- it, but we send it when available so the path stays correct if that flips.
    v_service_key := current_setting('app.settings.service_role_key', true);
    if v_service_key is null or v_service_key = '' then
        begin
            select decrypted_secret into v_service_key
              from vault.decrypted_secrets where name = 'service_role_key' limit 1;
        exception when others then v_service_key := null;
        end;
    end if;

    for v_row in
        select business_id from public.business_integration_source where active = true
    loop
        perform net.http_post(
            url     := v_ef_url,
            headers := case
                when v_service_key is null or v_service_key = ''
                    then jsonb_build_object('Content-Type', 'application/json')
                else jsonb_build_object('Content-Type', 'application/json',
                                        'Authorization', 'Bearer ' || v_service_key)
            end,
            body    := jsonb_build_object('business_id', v_row.business_id, 'dry_run', false)
        );
        v_count := v_count + 1;
    end loop;
    return v_count;
end
$worker$;

-- 2. schedule: hourly reconciliation (real-time push is the primary path) ------
select cron.unschedule('lymx-auto-pull') where exists (
    select 1 from cron.job where jobname = 'lymx-auto-pull'
);
select cron.schedule(
    'lymx-auto-pull',
    '7 * * * *',
    $cronfn$select public.run_lymx_auto_pull();$cronfn$
);

do $s$ begin raise notice 'Migration 165 OK - lymx-auto-pull reconciliation cron scheduled hourly.'; end$s$;
-- END migration 165
