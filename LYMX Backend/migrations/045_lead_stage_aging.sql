-- =============================================================================
-- Migration 045 — Lead stage aging
-- =============================================================================
-- Adds `stage_changed_at` so leads.html can show "X days in this stage" pills
-- (yellow for 3-7d, red for 7d+). Trigger keeps it accurate without app-layer
-- logic — any UPDATE that changes leads.stage bumps stage_changed_at.
-- =============================================================================

alter table public.leads
    add column if not exists stage_changed_at timestamptz default now();

-- Backfill existing rows to a sensible value
update public.leads
   set stage_changed_at = coalesce(stage_changed_at, updated_at, created_at, now())
 where stage_changed_at is null;

-- Trigger: bump stage_changed_at whenever stage column changes
create or replace function public.touch_lead_stage_changed_at()
returns trigger language plpgsql as $$
begin
    if old.stage is distinct from new.stage then
        new.stage_changed_at := now();
    end if;
    return new;
end;
$$;

drop trigger if exists leads_stage_changed_at on public.leads;
create trigger leads_stage_changed_at
    before update on public.leads
    for each row
    execute function public.touch_lead_stage_changed_at();


select 'migration 045 applied' as status,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='leads' and column_name='stage_changed_at'
       ) as column_added,
       (select count(*) from pg_trigger where tgname='leads_stage_changed_at') as trigger_present;
