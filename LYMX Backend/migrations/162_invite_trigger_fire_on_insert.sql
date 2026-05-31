-- =============================================================================
-- Migration 162 — fire the integration-invite on INSERT too (gap fix)
-- =============================================================================
-- GAP found in the partner->business->invite e2e: business-signup sets
-- businesses.intake_completed_at at INSERT time (when the signup form carries
-- legal/tax intake). Migration 161's trigger only fired AFTER UPDATE, so a real
-- onboarding never fired the invite. Fix: fire on INSERT (intake already set)
-- AND on UPDATE (null -> set). The send-once log makes double-fire harmless.
-- =============================================================================

create or replace function public.fn_send_integration_invite_on_intake()
returns trigger
language plpgsql
security definer
set search_path = public, net, pg_temp
as $fn$
begin
    if (tg_op = 'INSERT' and new.intake_completed_at is not null)
       or (tg_op = 'UPDATE' and old.intake_completed_at is null and new.intake_completed_at is not null) then
        perform net.http_post(
            url     := 'https://apffootxzfwmtyjlnteo.supabase.co/functions/v1/send-business-integration-invite',
            body    := jsonb_build_object('business_id', new.id),
            headers := '{"Content-Type":"application/json"}'::jsonb
        );
    end if;
    return new;
end;
$fn$;

drop trigger if exists trg_send_integration_invite on public.businesses;
create trigger trg_send_integration_invite
    after insert or update of intake_completed_at on public.businesses
    for each row execute function public.fn_send_integration_invite_on_intake();
