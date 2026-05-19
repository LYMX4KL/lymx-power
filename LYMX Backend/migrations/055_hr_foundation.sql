-- =============================================================================
-- Migration 055 — HR foundation (mirror of InvestPro PM HR module, Phase 0)
-- 2026-05-19
-- =============================================================================
--
-- Establishes the universal admin spine + staff profile + benefits versioning
-- that every later HR migration (056-059) depends on.
--
-- Mirrors InvestPro's universal admin role family (broker / admin_onsite / hr /
-- compliance / accounting) onto LYMX's existing staff_roles table.  Kept the
-- existing `role` text column intact — added boolean flag columns so the
-- existing role values keep working AND fine-grained HR permissions become
-- queryable without re-writing every policy that already uses am_i_admin().
--
-- New role helpers join `am_i_admin()` (migration 025) so RLS reads stay one
-- liners:  using (am_i_admin() OR am_i_hr() OR am_i_compliance() …).
--
-- DEFAULTS (per Kenny 2026-05-19):
--   • Founder (Kenny) — full access (already wired via hardcoded UUID in 025)
--   • CFO — full access besides me (is_cfo flag → all HR/financial RPCs)
--   • Helen — default HR (is_hr=true, no is_cfo)
-- =============================================================================


-- ---------- 1. Extend staff_roles with HR boolean flags --------------------
alter table public.staff_roles
    add column if not exists is_hr           boolean not null default false,
    add column if not exists is_cfo          boolean not null default false,
    add column if not exists is_compliance   boolean not null default false,
    add column if not exists is_accounting   boolean not null default false,
    add column if not exists is_admin_onsite boolean not null default false;

create index if not exists idx_staff_roles_is_hr         on public.staff_roles(is_hr)         where is_hr;
create index if not exists idx_staff_roles_is_cfo        on public.staff_roles(is_cfo)        where is_cfo;
create index if not exists idx_staff_roles_is_compliance on public.staff_roles(is_compliance) where is_compliance;
create index if not exists idx_staff_roles_is_accounting on public.staff_roles(is_accounting) where is_accounting;


-- ---------- 2. Role helpers (mirror InvestPro's universal admin spine) ----
create or replace function public.am_i_hr()
returns boolean language sql stable security definer as $$
    select
        am_i_admin()
        OR exists (select 1 from public.staff_roles
                    where user_id = auth.uid()
                      and (is_hr OR is_cfo));
$$;

create or replace function public.am_i_cfo()
returns boolean language sql stable security definer as $$
    select
        am_i_admin()
        OR exists (select 1 from public.staff_roles
                    where user_id = auth.uid() and is_cfo);
$$;

create or replace function public.am_i_compliance()
returns boolean language sql stable security definer as $$
    select
        am_i_admin()
        OR exists (select 1 from public.staff_roles
                    where user_id = auth.uid()
                      and (is_compliance OR is_cfo));
$$;

create or replace function public.am_i_accounting()
returns boolean language sql stable security definer as $$
    select
        am_i_admin()
        OR exists (select 1 from public.staff_roles
                    where user_id = auth.uid()
                      and (is_accounting OR is_cfo));
$$;

create or replace function public.am_i_admin_onsite()
returns boolean language sql stable security definer as $$
    select
        am_i_admin()
        OR exists (select 1 from public.staff_roles
                    where user_id = auth.uid()
                      and (is_admin_onsite OR is_cfo));
$$;

-- Combined helper used by most HR-write RLS policies: admin / admin_onsite /
-- hr / compliance / cfo all qualify.  Accounting does NOT — they only get
-- explicit grants where finance is involved (overtime, final pay).
create or replace function public.am_i_hr_or_admin()
returns boolean language sql stable security definer as $$
    select am_i_admin() OR am_i_hr() OR am_i_compliance() OR am_i_admin_onsite();
$$;


-- ---------- 3. staff_profiles — per-employee HR state ----------------------
-- InvestPro keeps this on `profiles`.  LYMX never built a `profiles` table —
-- auth.users is the user spine.  We keep that, and put HR-specific employee
-- state on a sibling table so non-staff users (customers, businesses,
-- partners) stay out of HR queries entirely.
create table if not exists public.staff_profiles (
    user_id                 uuid primary key references auth.users(id) on delete cascade,

    -- Hiring + tenure
    hire_date               date,                                   -- when they actually started
    termination_date        date,                                   -- last_day_worked (set on close_termination)
    employment_status       text not null default 'active'
                                check (employment_status in ('active','on_leave','suspended','terminated','rehire_eligible')),

    -- Pay + classification
    is_on_payroll           boolean not null default false,         -- W-2 yes/no
    classification          text check (classification in ('w2_full_time','w2_part_time','1099_contractor','intern','volunteer') or classification is null),
    title                   text,
    department              text,

    -- Clock-in policy (per-employee overrides)
    clock_in_exempt         boolean not null default false,         -- salaried — no clock required
    lunch_minutes_default   int not null default 60 check (lunch_minutes_default between 0 and 120),

    -- Compensation (only HR/CFO can read via RLS)
    pay_type                text check (pay_type in ('hourly','salary','commission_only') or pay_type is null),
    pay_rate_cents          int,                                    -- hourly rate or monthly salary in cents
    pay_period              text check (pay_period in ('hour','week','biweek','month','year') or pay_period is null),

    -- Compliance / I-9 tracking
    i9_completed_at         timestamptz,
    w4_completed_at         timestamptz,

    -- Free-form permissions JSONB — granular UI gates that don't deserve a
    -- column.  E.g. { "can_void_transaction": true, "max_refund_cents": 50000 }
    permissions             jsonb not null default '{}'::jsonb,

    -- Audit
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),
    created_by              uuid references auth.users(id) on delete set null,
    updated_by              uuid references auth.users(id) on delete set null
);

create index if not exists idx_staff_profiles_status        on public.staff_profiles(employment_status);
create index if not exists idx_staff_profiles_on_payroll    on public.staff_profiles(is_on_payroll) where is_on_payroll;
create index if not exists idx_staff_profiles_hire_date     on public.staff_profiles(hire_date);
create index if not exists idx_staff_profiles_clock_exempt  on public.staff_profiles(clock_in_exempt) where clock_in_exempt;

-- updated_at trigger
create or replace function public.tg_staff_profiles_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    new.updated_by := auth.uid();
    return new;
end$$;

drop trigger if exists trg_staff_profiles_updated_at on public.staff_profiles;
create trigger trg_staff_profiles_updated_at
    before update on public.staff_profiles
    for each row execute function public.tg_staff_profiles_updated_at();


-- ---------- 4. benefits_policy — versioned, current row drives offer letters
create table if not exists public.benefits_policy (
    id                      uuid primary key default gen_random_uuid(),
    version                 int not null,
    is_current              boolean not null default false,

    -- PTO + sick
    pto_days_full_time      int not null default 10,                -- annual PTO at full-time
    pto_accrual_method      text not null default 'lump_annual'
                                check (pto_accrual_method in ('lump_annual','per_pay_period','tenure_tiered')),
    sick_days_full_time     int not null default 5,
    sick_accrual_method     text not null default 'lump_annual'
                                check (sick_accrual_method in ('lump_annual','per_pay_period')),

    -- Holidays + waiting period
    paid_holidays           text[] not null default array['New Year''s Day','Memorial Day','Independence Day','Labor Day','Thanksgiving Day','Christmas Day'],
    eligibility_wait_days   int not null default 90,                -- 90-day wait before PTO/health kicks in

    -- Health + retirement (yes/no flags, dollars in separate table later)
    offers_health           boolean not null default false,
    offers_retirement       boolean not null default false,
    health_employee_share_pct numeric(5,2),                         -- e.g. 30.00 means employee pays 30%

    -- Audit
    effective_from          date not null default current_date,
    effective_until         date,
    notes                   text,
    created_at              timestamptz not null default now(),
    created_by              uuid references auth.users(id) on delete set null,

    constraint benefits_policy_version_unique unique (version)
);

create unique index if not exists idx_benefits_policy_current
    on public.benefits_policy(is_current) where is_current;

-- Seed v1 policy (LYMX Power, Nevada).
-- Conservative defaults; Kenny edits via UI later.
insert into public.benefits_policy (
    version, is_current,
    pto_days_full_time, pto_accrual_method,
    sick_days_full_time, sick_accrual_method,
    eligibility_wait_days,
    offers_health, offers_retirement,
    notes
)
select
    1, true,
    10, 'lump_annual',
    5,  'lump_annual',
    90,
    false, false,
    'LYMX Power v1 — Nevada. Founders + first hires. Health/retirement TBD as team scales.'
where not exists (select 1 from public.benefits_policy where version = 1);


-- ---------- 5. personnel_files storage bucket (private, signed URLs only) --
-- I-9, W-4, signed offer letters, signed policies, write-up evidence,
-- termination paperwork.  Bucket is private; access via short-lived signed
-- URLs only.
insert into storage.buckets (id, name, public)
values ('personnel-files', 'personnel-files', false)
on conflict (id) do nothing;

-- Staff can upload their own onboarding docs into  personnel-files/<auth.uid()>/<file>
drop policy if exists pf_insert_own on storage.objects;
create policy pf_insert_own on storage.objects for insert to authenticated
    with check (
        bucket_id = 'personnel-files'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- Staff can read their own files
drop policy if exists pf_read_own on storage.objects;
create policy pf_read_own on storage.objects for select to authenticated
    using (
        bucket_id = 'personnel-files'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- HR / admin / compliance / cfo can read every file
drop policy if exists pf_read_hr on storage.objects;
create policy pf_read_hr on storage.objects for select to authenticated
    using (
        bucket_id = 'personnel-files' AND public.am_i_hr_or_admin()
    );

-- HR / admin / compliance / cfo can upload on behalf of any staff
drop policy if exists pf_insert_hr on storage.objects;
create policy pf_insert_hr on storage.objects for insert to authenticated
    with check (
        bucket_id = 'personnel-files' AND public.am_i_hr_or_admin()
    );


-- ---------- 6. RLS on staff_profiles --------------------------------------
alter table public.staff_profiles enable row level security;

-- Staff sees own row
drop policy if exists staff_profiles_self_read on public.staff_profiles;
create policy staff_profiles_self_read on public.staff_profiles for select to authenticated
    using (user_id = auth.uid());

-- HR / admin / cfo sees every staff row
drop policy if exists staff_profiles_hr_read on public.staff_profiles;
create policy staff_profiles_hr_read on public.staff_profiles for select to authenticated
    using (public.am_i_hr_or_admin());

-- Only HR / admin / cfo can insert + update
drop policy if exists staff_profiles_hr_write on public.staff_profiles;
create policy staff_profiles_hr_write on public.staff_profiles for all to authenticated
    using (public.am_i_hr_or_admin())
    with check (public.am_i_hr_or_admin());

-- benefits_policy: read = anyone authenticated (offer letter generators need
-- it); write = admin / cfo only
alter table public.benefits_policy enable row level security;

drop policy if exists benefits_policy_read on public.benefits_policy;
create policy benefits_policy_read on public.benefits_policy for select to authenticated
    using (true);

drop policy if exists benefits_policy_write on public.benefits_policy;
create policy benefits_policy_write on public.benefits_policy for all to authenticated
    using (am_i_admin() OR am_i_cfo())
    with check (am_i_admin() OR am_i_cfo());


-- ---------- 7. Sanity: am_i_admin must exist before this migration runs ---
do $$
begin
    if not exists (
        select 1 from pg_proc where proname = 'am_i_admin' and pg_function_is_visible(oid)
    ) then
        raise exception 'am_i_admin() helper missing — apply migration 015 first';
    end if;
end$$;


-- =============================================================================
-- POST-MIGRATION TASKS (run via UI later, NOT in this file)
-- =============================================================================
-- 1. Set Helen as default HR:
--      update staff_roles set is_hr = true
--       where user_id = (select id from auth.users where email='helen@lymxpower.com');
--    (Helen's email TBD — adjust as needed.)
--
-- 2. Set CFO when role is filled:
--      update staff_roles set is_cfo = true where user_id = '<cfo_uuid>';
--
-- 3. Backfill staff_profiles.hire_date for existing staff once their start
--    dates are known.  Until then, staff_profiles rows can be created on
--    demand by the hiring/onboarding migration (056).
-- =============================================================================
