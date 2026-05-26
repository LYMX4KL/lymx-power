-- =============================================================================
-- Migration 025 — HR + clock-in + time-off + duties + team roster
-- =============================================================================
-- Mirrors InvestPro PM's management surface (064_clock_events, 121_benefits_pto,
-- 123_schedule_shifts, 144_clock_in_permissions, 148_timesheets) — adapted to
-- LYMX's auth.users + staff_roles model (no profiles table).
--
-- Promotes Helen Chen (helen0510c@gmail.com) to admin + CFO, joining Kenny.
--
-- Idempotent.
-- =============================================================================

-- =====================================================================
-- 1. Extend staff_roles for HR
-- =====================================================================
alter table public.staff_roles
    add column if not exists role           text default 'staff',
    add column if not exists job_title      text,
    add column if not exists is_cfo         boolean not null default false,
    add column if not exists is_hr          boolean not null default false,
    add column if not exists employment_type text default 'full_time', -- full_time | part_time | contractor | intern
    add column if not exists home_office_lat   numeric(10,7),
    add column if not exists home_office_lng   numeric(10,7),
    add column if not exists geofence_radius_m numeric(8,2) default 200,
    add column if not exists remote_allowed    boolean not null default false,
    add column if not exists hire_date         date,
    add column if not exists hourly_rate_cents integer,
    add column if not exists salary_cents      integer;

-- Allowed role values (matches InvestPro pattern, simplified)
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'staff_roles_role_check') then
        alter table public.staff_roles
            add constraint staff_roles_role_check
            check (role in ('admin','manager','staff','support','tech','accounting','hr','marketing'));
    end if;
end$$;

-- =====================================================================
-- 2. Helpers — am_i_admin, has_staff_role, current_user_staff_role
-- =====================================================================
create or replace function public.am_i_admin()
returns boolean
language sql stable security definer
as $$
    select
        public.am_i_admin() -- any admin via staff_roles
        OR
        exists (select 1 from public.staff_roles where user_id = auth.uid() and role = 'admin');
$$;

create or replace function public.am_i_hr()
returns boolean
language sql stable security definer
as $$
    select
        public.am_i_admin()
        OR
        exists (select 1 from public.staff_roles where user_id = auth.uid() and (role = 'hr' OR is_hr = true));
$$;

create or replace function public.am_i_cfo()
returns boolean
language sql stable security definer
as $$
    select
        public.am_i_admin()
        OR
        exists (select 1 from public.staff_roles where user_id = auth.uid() and is_cfo = true);
$$;

grant execute on function public.am_i_admin() to authenticated;
grant execute on function public.am_i_hr() to authenticated;
grant execute on function public.am_i_cfo() to authenticated;

-- =====================================================================
-- 3. clock_events — time clock with GPS + remote support
-- =====================================================================
do $$ begin
    create type clock_event_type as enum ('in','out','break_start','break_end');
exception when duplicate_object then null;
end $$;

create table if not exists public.clock_events (
    id                      uuid primary key default uuid_generate_v4(),
    user_id                 uuid not null references auth.users(id) on delete cascade,
    event_type              clock_event_type not null,
    event_at                timestamptz not null default now(),

    -- Where the punch happened
    gps_lat                 numeric(10,7),
    gps_lng                 numeric(10,7),
    gps_accuracy_m          numeric(8,2),
    distance_from_anchor_m  numeric(10,2),
    geofence_pass           boolean not null default false,

    -- Remote support
    override_reason         text,
    remote_allowed_at_event boolean not null default false,

    -- Free-form note
    notes                   text,

    -- Audit
    user_agent              text,
    ip_address              inet,
    created_at              timestamptz not null default now()
);

create index if not exists idx_clock_events_user_time on public.clock_events(user_id, event_at desc);
create index if not exists idx_clock_events_failed on public.clock_events(event_at desc)
    where geofence_pass = false and remote_allowed_at_event = false;

alter table public.clock_events enable row level security;

drop policy if exists clock_self_read on public.clock_events;
create policy clock_self_read on public.clock_events for select to authenticated
    using (user_id = auth.uid());

drop policy if exists clock_self_insert on public.clock_events;
create policy clock_self_insert on public.clock_events for insert to authenticated
    with check (user_id = auth.uid());

drop policy if exists clock_admin_all on public.clock_events;
create policy clock_admin_all on public.clock_events for all to authenticated
    using (public.am_i_admin() or public.am_i_hr())
    with check (public.am_i_admin() or public.am_i_hr());

-- Haversine helper (meters)
create or replace function public.haversine_m(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
returns numeric
language plpgsql immutable
as $$
declare
    r constant numeric := 6371000;
    phi1 numeric; phi2 numeric; dphi numeric; dlam numeric; a numeric;
begin
    if lat1 is null or lat2 is null then return null; end if;
    phi1 := radians(lat1); phi2 := radians(lat2);
    dphi := radians(lat2 - lat1); dlam := radians(lng2 - lng1);
    a := sin(dphi/2)^2 + cos(phi1)*cos(phi2)*sin(dlam/2)^2;
    return r * 2 * atan2(sqrt(a), sqrt(1-a));
end;
$$;

-- Trigger: compute distance + geofence_pass on insert
create or replace function public.clock_events_compute_distance()
returns trigger
language plpgsql security definer
as $$
declare
    v_anchor_lat numeric;
    v_anchor_lng numeric;
    v_radius numeric;
    v_remote boolean;
begin
    select home_office_lat, home_office_lng, geofence_radius_m, remote_allowed
      into v_anchor_lat, v_anchor_lng, v_radius, v_remote
      from public.staff_roles where user_id = new.user_id;

    new.remote_allowed_at_event := coalesce(v_remote, false);

    if new.gps_lat is not null and v_anchor_lat is not null then
        new.distance_from_anchor_m := public.haversine_m(new.gps_lat, new.gps_lng, v_anchor_lat, v_anchor_lng);
        new.geofence_pass := (new.distance_from_anchor_m <= coalesce(v_radius, 200));
    end if;
    return new;
end;
$$;

drop trigger if exists trg_clock_events_compute on public.clock_events;
create trigger trg_clock_events_compute before insert on public.clock_events
    for each row execute function public.clock_events_compute_distance();

-- =====================================================================
-- 4. time_off — vacation/PTO/sick requests
-- =====================================================================
do $$ begin
    create type time_off_status as enum ('pending','approved','denied','cancelled');
exception when duplicate_object then null;
end $$;

do $$ begin
    create type time_off_kind as enum ('vacation','sick','personal','bereavement','other');
exception when duplicate_object then null;
end $$;

create table if not exists public.time_off (
    id              uuid primary key default uuid_generate_v4(),
    user_id         uuid not null references auth.users(id) on delete cascade,
    kind            time_off_kind not null,
    start_date      date not null,
    end_date        date not null,
    hours           numeric(6,2),
    reason          text,
    status          time_off_status not null default 'pending',
    decided_by      uuid references auth.users(id) on delete set null,
    decided_at      timestamptz,
    decided_notes   text,
    created_at      timestamptz not null default now(),
    check (end_date >= start_date)
);

create index if not exists idx_time_off_user on public.time_off(user_id, start_date desc);
create index if not exists idx_time_off_pending on public.time_off(created_at desc) where status = 'pending';

alter table public.time_off enable row level security;

drop policy if exists time_off_self_read on public.time_off;
create policy time_off_self_read on public.time_off for select to authenticated
    using (user_id = auth.uid());
drop policy if exists time_off_self_insert on public.time_off;
create policy time_off_self_insert on public.time_off for insert to authenticated
    with check (user_id = auth.uid() and status = 'pending');
drop policy if exists time_off_admin_all on public.time_off;
create policy time_off_admin_all on public.time_off for all to authenticated
    using (public.am_i_admin() or public.am_i_hr())
    with check (public.am_i_admin() or public.am_i_hr());

-- =====================================================================
-- 5. duty_definitions + duty_completions — recurring tasks
-- =====================================================================
create table if not exists public.duty_definitions (
    id              uuid primary key default uuid_generate_v4(),
    title           text not null,
    description     text,
    cadence         text not null default 'daily', -- daily | weekly | monthly | once
    weekday_mask    int default 0,  -- bitmask Sun=1, Mon=2, ..., Sat=64 (when cadence='weekly')
    assigned_role   text,           -- e.g. 'hr', 'accounting'
    assigned_user_id uuid references auth.users(id) on delete set null,
    is_active       boolean not null default true,
    created_at      timestamptz not null default now()
);

create table if not exists public.duty_completions (
    id              uuid primary key default uuid_generate_v4(),
    duty_id         uuid not null references public.duty_definitions(id) on delete cascade,
    due_date        date not null,
    user_id         uuid references auth.users(id) on delete set null,
    completed_at    timestamptz,
    notes           text,
    created_at      timestamptz not null default now(),
    unique (duty_id, due_date, user_id)
);

create index if not exists idx_duty_completions_user on public.duty_completions(user_id, due_date desc);

alter table public.duty_definitions enable row level security;
alter table public.duty_completions enable row level security;

drop policy if exists duty_defs_read on public.duty_definitions;
create policy duty_defs_read on public.duty_definitions for select to authenticated using (true);
drop policy if exists duty_defs_admin_write on public.duty_definitions;
create policy duty_defs_admin_write on public.duty_definitions for all to authenticated
    using (public.am_i_admin() or public.am_i_hr())
    with check (public.am_i_admin() or public.am_i_hr());

drop policy if exists duty_completions_self on public.duty_completions;
create policy duty_completions_self on public.duty_completions for all to authenticated
    using (user_id = auth.uid() or public.am_i_admin() or public.am_i_hr())
    with check (user_id = auth.uid() or public.am_i_admin() or public.am_i_hr());

-- =====================================================================
-- 6. schedule_shifts — assigned shifts (optional, for Phase 2 use)
-- =====================================================================
create table if not exists public.schedule_shifts (
    id              uuid primary key default uuid_generate_v4(),
    user_id         uuid not null references auth.users(id) on delete cascade,
    shift_date      date not null,
    starts_at       time not null,
    ends_at         time not null,
    notes           text,
    created_at      timestamptz not null default now()
);

create index if not exists idx_schedule_shifts_user_date on public.schedule_shifts(user_id, shift_date);
create index if not exists idx_schedule_shifts_date on public.schedule_shifts(shift_date);

alter table public.schedule_shifts enable row level security;

drop policy if exists schedule_self_read on public.schedule_shifts;
create policy schedule_self_read on public.schedule_shifts for select to authenticated
    using (user_id = auth.uid());
drop policy if exists schedule_admin_all on public.schedule_shifts;
create policy schedule_admin_all on public.schedule_shifts for all to authenticated
    using (public.am_i_admin() or public.am_i_hr())
    with check (public.am_i_admin() or public.am_i_hr());

-- =====================================================================
-- 7. Team roster view
-- =====================================================================
create or replace view public.v_team_roster as
select
    u.id                                 as user_id,
    u.email,
    coalesce(sr.job_title, sr.role)      as job_title,
    sr.role,
    sr.is_cfo,
    sr.is_hr,
    sr.employment_type,
    sr.hire_date,
    sr.remote_allowed,
    sr.geofence_radius_m,
    (sr.home_office_lat is not null)     as has_anchor,
    (
        select max(event_at) from public.clock_events ce
         where ce.user_id = u.id and ce.event_type = 'in'
    )                                     as last_clock_in
  from auth.users u
  join public.staff_roles sr on sr.user_id = u.id
 order by sr.role, u.email;

alter view public.v_team_roster set (security_invoker = on);
grant select on public.v_team_roster to authenticated;

-- =====================================================================
-- 8. Promote Helen Chen + Kenny to admin/CFO
-- =====================================================================
do $$
declare
    v_helen_uuid uuid;
    v_kenny_uuid uuid := (select id from auth.users where email = 'zhongkennylin@gmail.com');
begin
    -- Find Helen by email
    select id into v_helen_uuid from auth.users where lower(email) = 'helen0510c@gmail.com' limit 1;

    -- Kenny: already in staff_roles? promote if so, insert if not
    insert into public.staff_roles (user_id, role, job_title, is_cfo, is_hr)
    values (v_kenny_uuid, 'admin', 'Founder', false, false)
    on conflict (user_id) do update set role = 'admin', job_title = coalesce(staff_roles.job_title, 'Founder');

    -- Helen: admin + CFO + HR
    if v_helen_uuid is not null then
        insert into public.staff_roles (user_id, role, job_title, is_cfo, is_hr)
        values (v_helen_uuid, 'admin', 'CFO', true, true)
        on conflict (user_id) do update set
            role = 'admin',
            job_title = 'CFO',
            is_cfo = true,
            is_hr = true;
    end if;
end$$;

-- =====================================================================
-- 9. Verify
-- =====================================================================
select 'migration 025 applied' as status,
       (select count(*) from public.staff_roles where role = 'admin') as admin_count,
       (select count(*) from public.staff_roles where is_cfo) as cfo_count,
       (select count(*) from information_schema.tables where table_schema='public'
         and table_name in ('clock_events','time_off','duty_definitions','duty_completions','schedule_shifts')) as new_tables,
       (select count(*) from pg_proc where proname in ('am_i_admin','am_i_hr','am_i_cfo','haversine_m')) as new_helpers;
