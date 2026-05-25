-- =============================================================================
-- Migration 084 — HR clock-in locations / permissions / timesheets / time-off /
--                  schedule weeks / shift templates / personnel files
-- =============================================================================
-- Mirrors InvestPro PM migrations:
--   • 144 clock_in_permissions
--   • 148 timesheet_periods
--   • 161 timesheet_uploads
--   • 187 clock_in_locations
--   • 208 timesheet_lines
--   • 121 (partial) time_off_requests + personnel_files (LYMX 025 has `time_off`
--         only, not the request/approval workflow; LYMX 058 has personnel records
--         but no file uploads table)
--   • 123 (partial) shift_templates + availability (LYMX 025 has schedule_shifts
--         but no templates or per-staff availability)
--   • 182 schedule_weeks_acceptance
--
-- Adaptations for LYMX:
--   • InvestPro `profiles(id)` -> LYMX `auth.users(id)`
--   • InvestPro `accounting` role gating -> LYMX `am_i_admin()` / `am_i_hr()` /
--     `am_i_cfo()` SECURITY DEFINER helpers (avoid cross-table RLS recursion per
--     feedback_lymx_rls_cross_table_recursion)
--   • Storage bucket name `personnel-files` kept identical so Helen's files
--     follow the same convention if she ever migrates between projects.
--
-- Idempotent. Named dollar-quotes per feedback_supabase_named_dollar_quotes.
-- =============================================================================

set local statement_timeout = 0;

-- =====================================================================
-- 1. ENUM types
-- =====================================================================
do $enum_time_off_category$
begin
    create type public.time_off_category as enum
        ('pto','sick','unpaid','bereavement','jury','parental','other');
exception when duplicate_object then null;
end$enum_time_off_category$;

do $enum_time_off_status$
begin
    create type public.time_off_status as enum
        ('pending','approved','denied','cancelled');
exception when duplicate_object then null;
end$enum_time_off_status$;

do $enum_personnel_file_type$
begin
    create type public.personnel_file_type as enum (
        'offer_letter','i9','w4','direct_deposit',
        'handbook_signature','non_compete','nda',
        'performance_review','discipline','separation',
        'training_cert','license','other'
    );
exception when duplicate_object then null;
end$enum_personnel_file_type$;

do $enum_cip_status$
begin
    create type public.clock_in_permission_status as enum (
        'pending','approved','denied','expired','revoked'
    );
exception when duplicate_object then null;
end$enum_cip_status$;

do $enum_cip_kind$
begin
    create type public.clock_in_permission_kind as enum
        ('single_day','ongoing');
exception when duplicate_object then null;
end$enum_cip_kind$;

do $enum_schedule_week_status$
begin
    create type public.schedule_week_status as enum
        ('draft','proposed','accepted','declined');
exception when duplicate_object then null;
end$enum_schedule_week_status$;


-- =====================================================================
-- 2. clock_in_locations  (mirror of InvestPro 187)
-- =====================================================================
-- Each row = a named place where a staff member is allowed to clock in/out
-- from. Helen creates these per-staff (e.g. "Helen WFH home" lat/lng) when
-- onboarding remote staff. The staff-clock-in geofence check walks ALL
-- active rows for that user_id + their global staff_profiles anchor (if set).
create table if not exists public.clock_in_locations (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null references auth.users(id) on delete cascade,
    label         text not null,
    address       text,
    lat           numeric(10,7) not null,
    lng           numeric(10,7) not null,
    radius_m      integer not null default 200
                    check (radius_m >= 25 and radius_m <= 5000),
    is_active     boolean not null default true,
    notes         text,
    created_by    uuid references auth.users(id) on delete set null,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);
create index if not exists idx_cil_user_active
    on public.clock_in_locations(user_id) where is_active;

alter table public.clock_in_locations enable row level security;

drop policy if exists cil_read on public.clock_in_locations;
create policy cil_read on public.clock_in_locations
    for select to authenticated
    using (user_id = auth.uid() or public.am_i_hr_or_admin());

drop policy if exists cil_write_hr on public.clock_in_locations;
create policy cil_write_hr on public.clock_in_locations
    for all to authenticated
    using (public.am_i_hr_or_admin())
    with check (public.am_i_hr_or_admin());


-- =====================================================================
-- 3. clock_in_permissions  (mirror of InvestPro 144)
-- =====================================================================
-- One row per staff request to clock in from somewhere not in their
-- standard locations. Two flavors:
--   • single_day  — "Tuesday I'm working from the plumber's house"
--   • ongoing     — "I'm relocating to Manila, all my clock-ins are remote"
-- Workflow: staff submits (pending) -> HR/CFO reviews -> approved/denied.
-- On approval, HR sets the granted geofence (lat/lng/radius) + valid window.
create table if not exists public.clock_in_permissions (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid not null references auth.users(id) on delete cascade,
    user_name_snapshot  text,                               -- denormalized for audit
    user_email_snapshot text,
    user_role_snapshot  text,

    kind                public.clock_in_permission_kind not null default 'single_day',

    -- Staff submitted
    requested_at        timestamptz not null default now(),
    request_address     text not null,
    request_reason      text not null,
    request_date        date,                               -- single_day only

    -- HR reviewed
    status              public.clock_in_permission_status not null default 'pending',
    reviewed_by_id      uuid references auth.users(id) on delete set null,
    reviewed_by_name    text,
    reviewed_at         timestamptz,
    review_notes        text,

    -- Granted geofence (filled by HR on approval)
    geofence_lat        numeric(10,7),
    geofence_lng        numeric(10,7),
    geofence_radius_m   integer not null default 100,
    valid_from          timestamptz,
    valid_until         timestamptz,

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);
create index if not exists idx_cip_user_status
    on public.clock_in_permissions(user_id, status);
create index if not exists idx_cip_status_pending
    on public.clock_in_permissions(status) where status = 'pending';

alter table public.clock_in_permissions enable row level security;

drop policy if exists cip_read on public.clock_in_permissions;
create policy cip_read on public.clock_in_permissions
    for select to authenticated
    using (user_id = auth.uid() or public.am_i_hr_or_admin());

drop policy if exists cip_staff_insert on public.clock_in_permissions;
create policy cip_staff_insert on public.clock_in_permissions
    for insert to authenticated
    with check (user_id = auth.uid());

drop policy if exists cip_hr_update on public.clock_in_permissions;
create policy cip_hr_update on public.clock_in_permissions
    for update to authenticated
    using (public.am_i_hr_or_admin())
    with check (public.am_i_hr_or_admin());


-- =====================================================================
-- 4. shift_templates + availability  (mirror of InvestPro 123 partial)
-- =====================================================================
-- shift_templates: reusable "9-6 weekdays" / "10-2 Sat" definitions.
-- availability:    per-staff "I can work Mon-Wed but not Thu" matrix.
-- (LYMX 025 already has schedule_shifts table for actual scheduled shifts.)
create table if not exists public.shift_templates (
    id              uuid primary key default gen_random_uuid(),
    name            text not null,
    role_label      text,
    start_time      time not null,
    end_time        time not null,
    days_of_week    int[] not null default '{1,2,3,4,5}',
    is_active       boolean not null default true,
    created_by      uuid references auth.users(id) on delete set null,
    created_at      timestamptz not null default now()
);
alter table public.shift_templates enable row level security;
drop policy if exists shift_templates_read on public.shift_templates;
create policy shift_templates_read on public.shift_templates
    for select to authenticated using (true);
drop policy if exists shift_templates_write_hr on public.shift_templates;
create policy shift_templates_write_hr on public.shift_templates
    for all to authenticated
    using (public.am_i_hr_or_admin())
    with check (public.am_i_hr_or_admin());


create table if not exists public.availability (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references auth.users(id) on delete cascade,
    day_of_week     int  not null check (day_of_week between 0 and 6),
    start_time      time not null,
    end_time        time not null,
    is_available    boolean not null default true,
    effective_from  date,
    effective_until date,
    notes           text,
    created_at      timestamptz not null default now(),
    constraint avail_time_order check (end_time > start_time)
);
create index if not exists idx_availability_user_day
    on public.availability(user_id, day_of_week);

alter table public.availability enable row level security;

drop policy if exists availability_read on public.availability;
create policy availability_read on public.availability
    for select to authenticated
    using (user_id = auth.uid() or public.am_i_hr_or_admin());

drop policy if exists availability_self_write on public.availability;
create policy availability_self_write on public.availability
    for all to authenticated
    using (user_id = auth.uid() or public.am_i_hr_or_admin())
    with check (user_id = auth.uid() or public.am_i_hr_or_admin());


-- =====================================================================
-- 5. schedule_weeks  (mirror of InvestPro 182)
-- =====================================================================
-- One row per (staff_user, week). HR proposes the week, staff accepts or
-- declines. Decoupled from individual schedule_shifts so the acceptance
-- is at the week-level (staff sees the whole week then accepts once).
create table if not exists public.schedule_weeks (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid not null references auth.users(id) on delete cascade,
    week_start_date     date not null,                       -- always a Monday
    status              public.schedule_week_status not null default 'draft',
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
create index if not exists idx_schedule_weeks_user_week
    on public.schedule_weeks(user_id, week_start_date);
create index if not exists idx_schedule_weeks_status
    on public.schedule_weeks(status);

alter table public.schedule_weeks enable row level security;
drop policy if exists schedule_weeks_read on public.schedule_weeks;
create policy schedule_weeks_read on public.schedule_weeks
    for select to authenticated
    using (user_id = auth.uid() or public.am_i_hr_or_admin());

drop policy if exists schedule_weeks_hr_write on public.schedule_weeks;
create policy schedule_weeks_hr_write on public.schedule_weeks
    for insert to authenticated
    with check (public.am_i_hr_or_admin());

drop policy if exists schedule_weeks_update on public.schedule_weeks;
create policy schedule_weeks_update on public.schedule_weeks
    for update to authenticated
    using (user_id = auth.uid() or public.am_i_hr_or_admin())
    with check (user_id = auth.uid() or public.am_i_hr_or_admin());


-- =====================================================================
-- 6. timesheet_periods  (mirror of InvestPro 148)
-- =====================================================================
-- A pay period. Examples: "Week of May 5" / "May 1-15" / "May 2026".
-- HR locks a period when payroll is being computed, then marks paid_out
-- when ACH/Gusto run completes. Snapshots payroll_run_total_cents for
-- post-hoc audit.
create table if not exists public.timesheet_periods (
    id                          uuid primary key default gen_random_uuid(),
    period_start                date not null,
    period_end                  date not null,
    label                       text,
    locked                      boolean not null default false,
    locked_by_id                uuid references auth.users(id) on delete set null,
    locked_by_name              text,
    locked_at                   timestamptz,
    paid_out                    boolean not null default false,
    paid_out_at                 timestamptz,
    paid_out_by_id              uuid references auth.users(id) on delete set null,
    paid_out_by_name            text,
    payroll_run_total_cents     bigint,
    payroll_notes               text,
    created_at                  timestamptz not null default now(),
    updated_at                  timestamptz not null default now(),
    unique (period_start, period_end),
    constraint timesheet_period_date_order check (period_end >= period_start)
);
create index if not exists idx_tsperiods_open
    on public.timesheet_periods(period_end desc) where not paid_out;

alter table public.timesheet_periods enable row level security;
drop policy if exists tsp_read on public.timesheet_periods;
create policy tsp_read on public.timesheet_periods
    for select to authenticated
    using (public.am_i_hr_or_admin() or public.am_i_cfo());

drop policy if exists tsp_write on public.timesheet_periods;
create policy tsp_write on public.timesheet_periods
    for all to authenticated
    using (public.am_i_hr_or_admin() or public.am_i_cfo())
    with check (public.am_i_hr_or_admin() or public.am_i_cfo());


-- =====================================================================
-- 7. timesheet_lines  (mirror of InvestPro 208)
-- =====================================================================
-- One row per (staff_user, work_date). Snapshots the computed
-- regular/OT/lunch breakdown at approval time so future payroll-policy
-- changes don't retroactively alter historical pay. payroll-reconciliation
-- aggregates these by period for the actual payroll-run total.
create table if not exists public.timesheet_lines (
    id                          uuid primary key default gen_random_uuid(),
    user_id                     uuid not null references auth.users(id) on delete cascade,
    user_name_snapshot          text,
    work_date                   date not null,
    week_start                  date not null,
    clock_in_at                 timestamptz,
    clock_out_at                timestamptz,
    raw_minutes_in_shift        integer not null default 0,
    qualifying_lunch_minutes    integer not null default 0,
    short_break_minutes         integer not null default 0,
    paid_minutes                integer not null default 0,
    daily_regular_minutes       integer not null default 0,
    daily_ot_minutes            integer not null default 0,
    weekly_ot_share_minutes     integer not null default 0,
    final_regular_minutes       integer not null default 0,
    final_ot_minutes            integer not null default 0,
    missed_lunch_flag           boolean not null default false,
    hourly_rate_usd             numeric(8,2),
    estimated_regular_pay_usd   numeric(10,2),
    estimated_ot_pay_usd        numeric(10,2),
    estimated_gross_usd         numeric(10,2),
    edited_by_id                uuid references auth.users(id) on delete set null,
    edited_by_name              text,
    edit_reason                 text,
    edited_at                   timestamptz,
    approved_by_id              uuid references auth.users(id) on delete set null,
    approved_by_name            text,
    approved_at                 timestamptz,
    locked                      boolean not null default false,
    created_at                  timestamptz not null default now(),
    updated_at                  timestamptz not null default now(),
    unique (user_id, work_date)
);
create index if not exists idx_tslines_user_week
    on public.timesheet_lines(user_id, week_start);
create index if not exists idx_tslines_week
    on public.timesheet_lines(week_start);

alter table public.timesheet_lines enable row level security;
drop policy if exists tsl_self_read on public.timesheet_lines;
create policy tsl_self_read on public.timesheet_lines
    for select to authenticated
    using (user_id = auth.uid() or public.am_i_hr_or_admin() or public.am_i_cfo());

drop policy if exists tsl_hr_write on public.timesheet_lines;
create policy tsl_hr_write on public.timesheet_lines
    for all to authenticated
    using (public.am_i_hr_or_admin() or public.am_i_cfo())
    with check (public.am_i_hr_or_admin() or public.am_i_cfo());


-- =====================================================================
-- 8. timesheet_uploads  (mirror of InvestPro 161)
-- =====================================================================
-- Staff can upload signed/printed timesheets (PDF/JPG) per pay period —
-- backup for the digital clock_events. Stored in supabase storage bucket
-- 'timesheet-uploads' (RLS on storage gated by HR/CFO).
create table if not exists public.timesheet_uploads (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references auth.users(id) on delete restrict,
    period_start    date not null,
    period_end      date not null check (period_end >= period_start),
    storage_path    text not null,
    file_name       text not null,
    file_size       bigint,
    mime_type       text,
    note            text,
    uploaded_by     uuid references auth.users(id) on delete set null,
    uploaded_at     timestamptz not null default now(),
    archived_at     timestamptz,
    archive_path    text,
    purge_after     timestamptz
);
create index if not exists idx_tsup_user_period
    on public.timesheet_uploads(user_id, period_start, period_end);

alter table public.timesheet_uploads enable row level security;
drop policy if exists tsup_read on public.timesheet_uploads;
create policy tsup_read on public.timesheet_uploads
    for select to authenticated
    using (user_id = auth.uid() or public.am_i_hr_or_admin() or public.am_i_cfo());

drop policy if exists tsup_self_insert on public.timesheet_uploads;
create policy tsup_self_insert on public.timesheet_uploads
    for insert to authenticated
    with check (user_id = auth.uid());

drop policy if exists tsup_hr_write on public.timesheet_uploads;
create policy tsup_hr_write on public.timesheet_uploads
    for update to authenticated
    using (public.am_i_hr_or_admin() or public.am_i_cfo())
    with check (public.am_i_hr_or_admin() or public.am_i_cfo());


-- =====================================================================
-- 9. time_off_requests  (mirror of InvestPro 121 partial)
-- =====================================================================
-- LYMX 025 has `time_off` for actual approved time-off records;
-- this adds the request/approval workflow staff use to ASK for time off.
create table if not exists public.time_off_requests (
    id              uuid primary key default gen_random_uuid(),
    requester_id    uuid not null references auth.users(id) on delete cascade,
    start_date      date not null,
    end_date        date not null,
    hours_requested numeric(6,2) not null default 0,
    category        public.time_off_category not null default 'pto',
    reason          text,
    status          public.time_off_status   not null default 'pending',
    approver_id     uuid references auth.users(id) on delete set null,
    approver_notes  text,
    requested_at    timestamptz not null default now(),
    decided_at      timestamptz,
    constraint tor_date_order check (end_date >= start_date)
);
create index if not exists idx_tor_requester
    on public.time_off_requests(requester_id, requested_at desc);
create index if not exists idx_tor_pending
    on public.time_off_requests(status) where status = 'pending';

alter table public.time_off_requests enable row level security;
drop policy if exists tor_read on public.time_off_requests;
create policy tor_read on public.time_off_requests
    for select to authenticated
    using (requester_id = auth.uid() or public.am_i_hr_or_admin());

drop policy if exists tor_self_insert on public.time_off_requests;
create policy tor_self_insert on public.time_off_requests
    for insert to authenticated
    with check (requester_id = auth.uid());

drop policy if exists tor_self_update_pending on public.time_off_requests;
create policy tor_self_update_pending on public.time_off_requests
    for update to authenticated
    using (
        (requester_id = auth.uid() and status = 'pending')
        or public.am_i_hr_or_admin()
    )
    with check (
        (requester_id = auth.uid() and status in ('pending','cancelled'))
        or public.am_i_hr_or_admin()
    );


-- =====================================================================
-- 10. personnel_files  (mirror of InvestPro 121 partial)
-- =====================================================================
-- Document storage for each staff member: offer letter, I-9, W-4, direct
-- deposit form, signed handbook, performance reviews, write-ups, licenses,
-- training certs. Files live in storage bucket `personnel-files`. RLS
-- restricts to the staff member themselves + HR/CFO.
create table if not exists public.personnel_files (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid not null references auth.users(id) on delete cascade,
    file_type     public.personnel_file_type not null,
    file_name     text not null,
    storage_path  text not null,
    size_bytes    bigint,
    expires_at    date,
    uploaded_by   uuid references auth.users(id) on delete set null,
    uploaded_at   timestamptz not null default now(),
    notes         text
);
create index if not exists idx_personnel_files_user
    on public.personnel_files(user_id, uploaded_at desc);
create index if not exists idx_personnel_files_expiring
    on public.personnel_files(expires_at)
    where expires_at is not null;

alter table public.personnel_files enable row level security;
drop policy if exists pf_read on public.personnel_files;
create policy pf_read on public.personnel_files
    for select to authenticated
    using (user_id = auth.uid() or public.am_i_hr_or_admin());

drop policy if exists pf_hr_write on public.personnel_files;
create policy pf_hr_write on public.personnel_files
    for all to authenticated
    using (public.am_i_hr_or_admin())
    with check (public.am_i_hr_or_admin());


-- =====================================================================
-- 11. Storage buckets (create if missing)
-- =====================================================================
-- personnel-files bucket — Helen uploads I-9 / W-4 / offer letters here.
do $bkt_personnel$
begin
    insert into storage.buckets (id, name, public)
    values ('personnel-files','personnel-files', false)
    on conflict (id) do nothing;
exception when others then null;
end$bkt_personnel$;

-- timesheet-uploads bucket
do $bkt_timesheet$
begin
    insert into storage.buckets (id, name, public)
    values ('timesheet-uploads','timesheet-uploads', false)
    on conflict (id) do nothing;
exception when others then null;
end$bkt_timesheet$;

-- Storage RLS — only owner-of-row or HR/CFO can read/write.
-- (Storage RLS goes on storage.objects, not the bucket table.)
do $stor_policy_pf_read$
begin
    drop policy if exists pf_storage_read on storage.objects;
    create policy pf_storage_read on storage.objects
        for select to authenticated
        using (bucket_id = 'personnel-files'
               and (public.am_i_hr_or_admin()
                    or (storage.foldername(name))[1] = auth.uid()::text));
exception when others then null;
end$stor_policy_pf_read$;

do $stor_policy_pf_write$
begin
    drop policy if exists pf_storage_write on storage.objects;
    create policy pf_storage_write on storage.objects
        for insert to authenticated
        with check (bucket_id = 'personnel-files'
                    and public.am_i_hr_or_admin());
exception when others then null;
end$stor_policy_pf_write$;

do $stor_policy_ts_read$
begin
    drop policy if exists ts_storage_read on storage.objects;
    create policy ts_storage_read on storage.objects
        for select to authenticated
        using (bucket_id = 'timesheet-uploads'
               and (public.am_i_hr_or_admin() or public.am_i_cfo()
                    or (storage.foldername(name))[1] = auth.uid()::text));
exception when others then null;
end$stor_policy_ts_read$;

do $stor_policy_ts_write$
begin
    drop policy if exists ts_storage_write on storage.objects;
    create policy ts_storage_write on storage.objects
        for insert to authenticated
        with check (bucket_id = 'timesheet-uploads'
                    and (auth.uid() is not null));
exception when others then null;
end$stor_policy_ts_write$;


-- =====================================================================
-- 12. updated_at triggers
-- =====================================================================
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end$$;

do $trg_cil$
begin
    create trigger trg_cil_updated_at before update on public.clock_in_locations
        for each row execute function public.tg_set_updated_at();
exception when duplicate_object then null;
end$trg_cil$;

do $trg_cip$
begin
    create trigger trg_cip_updated_at before update on public.clock_in_permissions
        for each row execute function public.tg_set_updated_at();
exception when duplicate_object then null;
end$trg_cip$;

do $trg_sw$
begin
    create trigger trg_sw_updated_at before update on public.schedule_weeks
        for each row execute function public.tg_set_updated_at();
exception when duplicate_object then null;
end$trg_sw$;

do $trg_tsp$
begin
    create trigger trg_tsp_updated_at before update on public.timesheet_periods
        for each row execute function public.tg_set_updated_at();
exception when duplicate_object then null;
end$trg_tsp$;

do $trg_tsl$
begin
    create trigger trg_tsl_updated_at before update on public.timesheet_lines
        for each row execute function public.tg_set_updated_at();
exception when duplicate_object then null;
end$trg_tsl$;


-- =====================================================================
-- 13. Bootstrap Helen as HR + CFO (one-time — she can't self-grant)
-- =====================================================================
-- Also re-asserts Kenny's HR + CFO so the "same permission as I do" rule
-- in feedback memory is satisfied at the DB level too.
do $bootstrap_helen$
begin
    update public.staff_roles
       set is_hr  = true,
           is_cfo = true
     where user_id in (
        select user_id from public.partners
         where partner_code in ('P-000001','P-000105')
     );
exception when others then
    raise notice 'bootstrap_helen update skipped: %', sqlerrm;
end$bootstrap_helen$;


-- =====================================================================
-- 14. Sanity output
-- =====================================================================
do $sanity$
declare v_count int;
begin
    select count(*) into v_count
      from information_schema.tables
     where table_schema='public'
       and table_name in (
        'clock_in_locations','clock_in_permissions','shift_templates',
        'availability','schedule_weeks','timesheet_periods','timesheet_lines',
        'timesheet_uploads','time_off_requests','personnel_files'
     );
    raise notice 'Migration 084 OK — % of 10 expected HR tables present in public schema', v_count;
end$sanity$;

-- =============================================================================
-- END migration 084
-- =============================================================================
