-- =============================================================================
-- Migration 144 — partner daily income digest: log table + daily cron
-- =============================================================================
-- Backs the partner-daily-income edge function (in-app + email morning summary
-- of yesterday + MTD earnings). The log table makes the EF idempotent per
-- partner per day. The cron fires the EF once a day. Mirrors the mig-082
-- pg_cron + pg_net + service-role pattern.
-- =============================================================================

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- 1. idempotency log -------------------------------------------------------
create table if not exists public.partner_income_digest_log (
    partner_id   uuid not null references public.partners(id) on delete cascade,
    digest_date  date not null,
    sent_at      timestamptz not null default now(),
    primary key (partner_id, digest_date)
);
alter table public.partner_income_digest_log enable row level security;

drop policy if exists pidl_admin_read on public.partner_income_digest_log;
create policy pidl_admin_read on public.partner_income_digest_log
    for select to authenticated using (public.am_i_admin());
-- Writes happen only from the EF (service_role, bypasses RLS). No other policy.

-- 2. cron worker: POST to the edge function --------------------------------
create or replace function public.run_partner_income_digest()
returns bigint
language plpgsql security definer set search_path = public, extensions, net
as $worker$
declare
    v_ef_url      text := 'https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/partner-daily-income';
    v_service_key text;
    v_req_id      bigint;
begin
    v_service_key := current_setting('app.settings.service_role_key', true);
    if v_service_key is null or v_service_key = '' then
        begin
            select decrypted_secret into v_service_key
              from vault.decrypted_secrets where name = 'service_role_key' limit 1;
        exception when others then v_service_key := null;
        end;
    end if;
    if v_service_key is null then
        raise notice '[run_partner_income_digest] service_role_key not configured; skipping';
        return null;
    end if;

    select net.http_post(
        url     := v_ef_url,
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_service_key
        ),
        body    := '{}'::jsonb
    ) into v_req_id;
    return v_req_id;
end
$worker$;

-- 3. schedule: once a day at 13:30 UTC (~early morning Americas) ------------
select cron.unschedule('partner-daily-income') where exists (
    select 1 from cron.job where jobname = 'partner-daily-income'
);
select cron.schedule(
    'partner-daily-income',
    '30 13 * * *',
    $cronfn$select public.run_partner_income_digest();$cronfn$
);

do $s$ begin raise notice 'Migration 144 OK - income digest log + daily cron scheduled.'; end$s$;
-- END migration 144
