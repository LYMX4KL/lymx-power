-- =============================================================================
-- Migration 047 — Weekly schedule + acceptance + on-shift helper
-- =============================================================================
-- Adds:
--   • schedule_weeks — one row per (user_id, week_start_date) with accept/decline status
--   • schedule_shifts.week_id — links each shift to a weekly plan
--   • fn_is_on_shift_now(uuid) — returns true if user is currently inside an accepted shift
--   • fn_next_shift(uuid) — returns next upcoming accepted shift
--   • RLS so staff see only their own weeks; admin/HR see everyone
--
-- Idempotent. Safe to re-run.
-- =============================================================================

-- =====================================================================
-- 1. schedule_week_status enum
-- =====================================================================
do $$ begin
    create type schedule_week_status as enum ('draft','proposed','accepted','declined');
exception when duplicate_object then null;
end $$;

-- =====================================================================
-- 2. schedule_weeks table
-- =====================================================================
create table if not exists public.schedule_weeks (
    id                  uuid primary key default uuid_generate_v4(),
    user_id             uuid not null references auth.users(id) on delete cascade,
    week_start_date     date not null,                          -- always a Monday
    status              schedule_week_status not null default 'draft',
    proposed_at         timestamptz,
    accepted_at         timestamptz,
    declined_at         timestamptz,
    declined_reason     text,
    proposed_by         uuid references auth.users(id) on delete set null,
    notes               text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    unique (user_id, week_start_date)
);

create index if not exists idx_schedule_weeks_user
    on public.schedule_weeks(user_id, week_start_date desc);
create index if not exists idx_schedule_weeks_pending
    on public.schedule_weeks(proposed_at desc) where status = 'proposed';

-- Auto-bump updated_at
create or replace function public.touch_schedule_weeks_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists trg_schedule_weeks_updated on public.schedule_weeks;
create trigger trg_schedule_weeks_updated before update on public.schedule_weeks
    for each row execute function public.touch_schedule_weeks_updated_at();

-- =====================================================================
-- 3. Link schedule_shifts to schedule_weeks
-- =====================================================================
alter table public.schedule_shifts
    add column if not exists week_id uuid references public.schedule_weeks(id) on delete cascade;

create index if not exists idx_schedule_shifts_week
    on public.schedule_shifts(week_id);

-- =====================================================================
-- 4. RLS — staff see own; admin/HR see all
-- =====================================================================
alter table public.schedule_weeks enable row level security;

drop policy if exists sw_self_read on public.schedule_weeks;
create policy sw_self_read on public.schedule_weeks for select to authenticated
    using (user_id = auth.uid() or public.am_i_admin() or public.am_i_hr());

drop policy if exists sw_self_accept on public.schedule_weeks;
create policy sw_self_accept on public.schedule_weeks for update to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid() and status in ('accepted','declined'));

drop policy if exists sw_admin_all on public.schedule_weeks;
create policy sw_admin_all on public.schedule_weeks for all to authenticated
    using (public.am_i_admin() or public.am_i_hr())
    with check (public.am_i_admin() or public.am_i_hr());

-- =====================================================================
-- 5. fn_is_on_shift_now — is the user currently inside an accepted shift?
-- =====================================================================
-- "Now" uses server-side timezone (UTC). Frontend should pass local-day boundaries.
-- For accuracy across timezones, we look at any shift whose date is today (server-local)
-- AND whose starts_at..ends_at window contains the current time-of-day.
create or replace function public.fn_is_on_shift_now(p_user_id uuid)
returns boolean
language sql stable security definer
as $$
    select exists (
        select 1
          from public.schedule_shifts s
          join public.schedule_weeks  w on w.id = s.week_id
         where s.user_id = p_user_id
           and w.status  = 'accepted'
           and s.shift_date = current_date
           and current_time between s.starts_at and s.ends_at
    );
$$;

grant execute on function public.fn_is_on_shift_now(uuid) to authenticated;

-- =====================================================================
-- 6. fn_next_shift — next upcoming accepted shift after "now"
-- =====================================================================
create or replace function public.fn_next_shift(p_user_id uuid)
returns table (
    shift_date  date,
    starts_at   time,
    ends_at     time,
    notes       text
)
language sql stable security definer
as $$
    select s.shift_date, s.starts_at, s.ends_at, s.notes
      from public.schedule_shifts s
      join public.schedule_weeks  w on w.id = s.week_id
     where s.user_id = p_user_id
       and w.status  = 'accepted'
       and (
           s.shift_date >  current_date
           or (s.shift_date = current_date and s.starts_at > current_time)
       )
     order by s.shift_date asc, s.starts_at asc
     limit 1;
$$;

grant execute on function public.fn_next_shift(uuid) to authenticated;

-- =====================================================================
-- 7. fn_my_current_week — convenience for "is my current week accepted?"
-- =====================================================================
-- Returns the row id of THIS calendar week's schedule_weeks (Monday boundary),
-- or null if no plan was published.
create or replace function public.fn_my_current_week()
returns uuid
language sql stable security definer
as $$
    select id
      from public.schedule_weeks
     where user_id = auth.uid()
       and week_start_date = (current_date - ((extract(dow from current_date)::int + 6) % 7) * interval '1 day')::date
     limit 1;
$$;

grant execute on function public.fn_my_current_week() to authenticated;

-- =====================================================================
-- 8. Onboarding fields on staff_roles (additive)
-- =====================================================================
alter table public.staff_roles
    add column if not exists onboarding_completed_at timestamptz,
    add column if not exists work_agreement_accepted_at timestamptz,
    add column if not exists work_agreement_version text,
    add column if not exists home_office_address text;

-- =====================================================================
-- 9. Verify
-- =====================================================================
select 'migration 047 applied' as status,
       (select count(*) from information_schema.tables where table_schema='public'
         and table_name = 'schedule_weeks') as new_table,
       (select count(*) from pg_proc where proname in
         ('fn_is_on_shift_now','fn_next_shift','fn_my_current_week','touch_schedule_weeks_updated_at')) as new_helpers;
