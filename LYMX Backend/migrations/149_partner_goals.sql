-- =============================================================================
-- Migration 149 — partner_goals: a monthly cash goal + progress reminders
-- =============================================================================
-- The income projector lets a partner SET a monthly cash goal; the dashboard
-- shows a progress meter and the daily income digest (partner-daily-income EF)
-- nudges them toward it. One row per partner. Partner reads/sets their own;
-- admin reads all. Writes go through set_partner_goal() (definer) so the partner
-- can't spoof another partner's row.
-- =============================================================================

set local statement_timeout = 0;
begin;

create table if not exists public.partner_goals (
    partner_id        uuid primary key references public.partners(id) on delete cascade,
    monthly_cash_goal numeric not null default 0,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);
alter table public.partner_goals enable row level security;

drop policy if exists pg_self_read on public.partner_goals;
create policy pg_self_read on public.partner_goals
    for select to authenticated
    using (public.am_i_admin() or partner_id = public.current_partner_id());

-- set / update own goal (definer keeps it to the caller's own partner)
create or replace function public.set_partner_goal(p_goal numeric)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $g$
declare v_pid uuid;
begin
  v_pid := public.current_partner_id();
  if v_pid is null then raise exception 'no partner for current user'; end if;
  if p_goal is null or p_goal < 0 then raise exception 'goal must be >= 0'; end if;
  insert into public.partner_goals (partner_id, monthly_cash_goal)
    values (v_pid, p_goal)
  on conflict (partner_id) do update set monthly_cash_goal = excluded.monthly_cash_goal, updated_at = now();
  return jsonb_build_object('ok', true, 'partner_id', v_pid, 'monthly_cash_goal', p_goal);
end$g$;
grant execute on function public.set_partner_goal(numeric) to authenticated;

commit;
do $s$ begin raise notice 'Migration 149 OK - partner_goals + set_partner_goal().'; end$s$;
-- END migration 149
