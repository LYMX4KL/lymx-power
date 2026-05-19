-- =============================================================================
-- Migration 056 — HR Phase A: hiring lifecycle (jobs → applications → interviews → offers → onboarding tasks)
-- 2026-05-19
-- =============================================================================
--
-- Mirror of InvestPro PM db/065 + onboarding-task pieces of db/121.
-- Adapted to LYMX:
--   • Roles use LYMX staff_roles flags (am_i_hr_or_admin)
--   • At-will language refers to "LYMX Power" / Nevada NRS
--   • Email sender set to hr@lymxpower.com
--
-- Depends on migration 055 (am_i_hr_or_admin, staff_profiles, benefits_policy).
-- =============================================================================


-- ---------- 1. jobs ---------------------------------------------------------
create table if not exists public.jobs (
    id                    uuid primary key default gen_random_uuid(),
    title                 text not null,
    department            text,
    target_role           text,                                    -- e.g. 'partner_success_coach', 'cs_agent'. Free-form, matches onboarding_task_templates filter.
    location              text not null default 'Las Vegas, NV',
    work_mode             text not null default 'hybrid'
                              check (work_mode in ('onsite','hybrid','remote')),
    employment_type       text not null default 'w2_full_time'
                              check (employment_type in ('w2_full_time','w2_part_time','1099_contractor','intern')),

    -- Listing copy
    summary               text,                                    -- 1-2 sentences for the careers card
    description_md        text,                                    -- markdown body for the full posting
    pay_range_min_cents   int,
    pay_range_max_cents   int,
    pay_unit              text check (pay_unit in ('hour','year') or pay_unit is null),

    -- Lifecycle
    status                text not null default 'draft'
                              check (status in ('draft','open','paused','filled','closed')),
    opened_at             timestamptz,
    filled_at             timestamptz,
    filled_by_user_id     uuid references auth.users(id) on delete set null,

    -- Audit
    posted_by_id          uuid references auth.users(id) on delete set null,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

create index if not exists idx_jobs_status     on public.jobs(status, opened_at desc);
create index if not exists idx_jobs_open_recent on public.jobs(opened_at desc) where status = 'open';


-- ---------- 2. job_applications --------------------------------------------
create table if not exists public.job_applications (
    id                    uuid primary key default gen_random_uuid(),
    job_id                uuid references public.jobs(id) on delete set null,

    -- Applicant
    first_name            text not null,
    last_name             text not null,
    email                 text not null,
    phone                 text,
    resume_url            text,                                    -- storage URL
    cover_letter          text,
    linkedin_url          text,
    portfolio_url         text,
    referred_by_partner_id uuid,                                   -- if applied via partner referral link
    source                text default 'careers_page'
                              check (source in ('careers_page','partner_referral','direct_outreach','linkedin','indeed','other')),

    -- Pipeline stage
    status                text not null default 'new'
                              check (status in ('new','phone_screen','interview','offer','hired','rejected','withdrew','ghosted')),
    rejected_reason       text,

    -- For accepted offer flow: link to the user account that was created
    applicant_profile_id  uuid references auth.users(id) on delete set null,

    -- Audit
    submitted_at          timestamptz not null default now(),
    reviewed_at           timestamptz,
    reviewed_by_id        uuid references auth.users(id) on delete set null,
    decided_at            timestamptz,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

create index if not exists idx_japps_job       on public.job_applications(job_id, submitted_at desc);
create index if not exists idx_japps_status    on public.job_applications(status, submitted_at desc);
create index if not exists idx_japps_email     on public.job_applications(lower(email));


-- ---------- 3. interview_events --------------------------------------------
create table if not exists public.interview_events (
    id                    uuid primary key default gen_random_uuid(),
    application_id        uuid not null references public.job_applications(id) on delete cascade,

    scheduled_for         timestamptz not null,
    duration_minutes      int not null default 30,
    interviewer_id        uuid references auth.users(id) on delete set null,
    interview_kind        text not null default 'phone_screen'
                              check (interview_kind in ('phone_screen','technical','culture','panel','final')),
    location_or_link      text,                                    -- physical address or Zoom/Daily link
    notes_md              text,                                    -- private notes
    overall_rating        int check (overall_rating between 1 and 5 or overall_rating is null),
    recommendation        text check (recommendation in ('strong_yes','yes','maybe','no','strong_no') or recommendation is null),
    status                text not null default 'scheduled'
                              check (status in ('scheduled','completed','cancelled','no_show')),
    completed_at          timestamptz,

    created_at            timestamptz not null default now(),
    created_by_id         uuid references auth.users(id) on delete set null
);

create index if not exists idx_interviews_app    on public.interview_events(application_id);
create index if not exists idx_interviews_when   on public.interview_events(scheduled_for desc);


-- ---------- 4. offers -------------------------------------------------------
create table if not exists public.offers (
    id                    uuid primary key default gen_random_uuid(),
    application_id        uuid not null references public.job_applications(id) on delete cascade,
    job_id                uuid references public.jobs(id) on delete set null,
    applicant_profile_id  uuid references auth.users(id) on delete set null,

    -- Terms (snapshot at offer-generation time so historical record is stable)
    title                 text not null,
    target_role           text,
    employment_type       text not null,
    pay_type              text not null check (pay_type in ('hourly','salary','commission_only')),
    pay_rate_cents        int not null,
    pay_period            text not null check (pay_period in ('hour','week','biweek','month','year')),
    start_date            date not null,
    location              text not null default 'Las Vegas, NV',
    work_mode             text not null default 'hybrid',
    benefits_policy_id    uuid references public.benefits_policy(id) on delete restrict, -- snapshot of policy version

    -- Optional structured fields the offer letter renders
    sign_on_bonus_cents   int,
    reports_to_id         uuid references auth.users(id) on delete set null,
    custom_notes_md       text,

    -- Offer letter artifact (generated by generate-offer-letter EF)
    offer_letter_path     text,                                    -- personnel-files/<applicant_uuid>/offer_letter_<ts>.html
    offer_letter_html     text,                                    -- inline copy for audit (signed snapshot)

    -- Lifecycle
    status                text not null default 'draft'
                              check (status in ('draft','sent','accepted','declined','expired','rescinded')),
    sent_at               timestamptz,
    accepted_at           timestamptz,
    declined_at           timestamptz,
    expires_at            timestamptz,
    decline_reason        text,

    -- Audit
    generated_by_id       uuid references auth.users(id) on delete set null,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

create index if not exists idx_offers_app      on public.offers(application_id);
create index if not exists idx_offers_status   on public.offers(status, sent_at desc);


-- ---------- 5. onboarding_task_templates -----------------------------------
create table if not exists public.onboarding_task_templates (
    id                    uuid primary key default gen_random_uuid(),
    title                 text not null,
    description           text,
    target_role           text,                                    -- match against offers.target_role; null = applies to everyone
    target_employment_type text,                                   -- e.g. only 'w2_full_time'; null = any
    category              text not null default 'onboarding'
                              check (category in ('onboarding','i9_w4','policy_sign','equipment','training','intro','account_setup')),
    is_required           boolean not null default true,
    suggested_due_days    int not null default 7,                  -- offset from hire_date
    sort_order            int not null default 100,
    active                boolean not null default true,
    created_at            timestamptz not null default now()
);

-- ---------- 6. onboarding_tasks (per-hire instances) -----------------------
create table if not exists public.onboarding_tasks (
    id                    uuid primary key default gen_random_uuid(),
    profile_id            uuid not null references auth.users(id) on delete cascade,
    template_id           uuid references public.onboarding_task_templates(id) on delete set null,

    -- Snapshot of template fields so deleting/editing the template
    -- doesn't rewrite history
    title                 text not null,
    description           text,
    category              text not null,
    is_required           boolean not null default true,
    due_date              date,

    -- State
    status                text not null default 'pending'
                              check (status in ('pending','in_progress','completed','waived','overdue')),
    completed_at          timestamptz,
    completed_by_id       uuid references auth.users(id) on delete set null,    -- HR can complete on behalf
    waived_reason         text,

    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

create index if not exists idx_onboarding_tasks_profile on public.onboarding_tasks(profile_id, status);
create index if not exists idx_onboarding_tasks_due     on public.onboarding_tasks(due_date) where status in ('pending','in_progress');


-- ---------- 7. Trigger: accepted offer → spawn onboarding ------------------
-- When offers.status flips to 'accepted', do everything an HR person would
-- otherwise have to do manually:
--   1. Stamp accepted_at
--   2. Set the matching job_application status='hired'
--   3. Create / promote the staff_profiles row with hire_date = start_date
--   4. Loop onboarding_task_templates matching target_role + active=true
--      and instantiate onboarding_tasks for the new hire
--   5. Mark the source job status='filled' with the new hire's user_id
--
-- All wrapped in one transaction so a partial failure rolls everything back.
create or replace function public.tg_offer_accepted_spawn_onboarding()
returns trigger
language plpgsql security definer
as $$
declare
    v_tmpl record;
begin
    if NEW.status <> 'accepted' or OLD.status = 'accepted' then
        return NEW;
    end if;

    if NEW.accepted_at is null then
        NEW.accepted_at := now();
    end if;

    -- Mark the job_application as hired
    update public.job_applications
       set status     = 'hired',
           decided_at = now()
     where id = NEW.application_id;

    -- Mark the job as filled (if linked)
    if NEW.job_id is not null then
        update public.jobs
           set status            = 'filled',
               filled_at         = now(),
               filled_by_user_id = NEW.applicant_profile_id
         where id = NEW.job_id;
    end if;

    -- Ensure staff_profiles row exists with this hire date
    if NEW.applicant_profile_id is not null then
        insert into public.staff_profiles (
            user_id, hire_date, employment_status,
            classification, title, is_on_payroll,
            pay_type, pay_rate_cents, pay_period,
            created_by, updated_by
        ) values (
            NEW.applicant_profile_id,
            NEW.start_date,
            'active',
            NEW.employment_type,
            NEW.title,
            NEW.employment_type in ('w2_full_time','w2_part_time'),
            NEW.pay_type,
            NEW.pay_rate_cents,
            NEW.pay_period,
            auth.uid(),
            auth.uid()
        )
        on conflict (user_id) do update
            set hire_date         = excluded.hire_date,
                employment_status = 'active',
                classification    = excluded.classification,
                title             = excluded.title,
                is_on_payroll     = excluded.is_on_payroll,
                pay_type          = excluded.pay_type,
                pay_rate_cents    = excluded.pay_rate_cents,
                pay_period        = excluded.pay_period,
                updated_by        = auth.uid();

        -- Spawn onboarding_tasks from matching templates
        for v_tmpl in
            select * from public.onboarding_task_templates
             where active = true
               and (target_role is null or target_role = NEW.target_role)
               and (target_employment_type is null or target_employment_type = NEW.employment_type)
        loop
            insert into public.onboarding_tasks (
                profile_id, template_id, title, description, category,
                is_required, due_date
            ) values (
                NEW.applicant_profile_id, v_tmpl.id, v_tmpl.title, v_tmpl.description,
                v_tmpl.category, v_tmpl.is_required,
                NEW.start_date + (v_tmpl.suggested_due_days || ' days')::interval
            );
        end loop;
    end if;

    return NEW;
end$$;

drop trigger if exists trg_offer_accepted_spawn_onboarding on public.offers;
create trigger trg_offer_accepted_spawn_onboarding
    before update of status on public.offers
    for each row execute function public.tg_offer_accepted_spawn_onboarding();


-- ---------- 8. Seed onboarding_task_templates (LYMX defaults) ---------------
insert into public.onboarding_task_templates (title, description, target_role, target_employment_type, category, is_required, suggested_due_days, sort_order)
values
    ('Complete I-9 form',                  'Federal employment eligibility verification. HR will guide.', null, 'w2_full_time', 'i9_w4',          true,  3,  10),
    ('Complete I-9 form',                  'Federal employment eligibility verification. HR will guide.', null, 'w2_part_time', 'i9_w4',          true,  3,  10),
    ('Complete W-4 form',                  'Tax withholding form. HR will guide.',                        null, 'w2_full_time', 'i9_w4',          true,  3,  20),
    ('Complete W-4 form',                  'Tax withholding form. HR will guide.',                        null, 'w2_part_time', 'i9_w4',          true,  3,  20),
    ('Sign Code of Conduct',               'Read + click-to-acknowledge.',                                null, null,           'policy_sign',    true,  7,  30),
    ('Sign Anti-Harassment / EEO policy',  'Read + click-to-acknowledge.',                                null, null,           'policy_sign',    true,  7,  40),
    ('Sign NDA',                           'E-sign (legal-grade).',                                       null, null,           'policy_sign',    true,  7,  50),
    ('Sign Employee Handbook receipt',     'Read + click-to-acknowledge.',                                null, null,           'policy_sign',    true,  7,  60),
    ('Set up @lymxpower.com email',        'HR auto-provisions; check inbox for login.',                  null, null,           'account_setup', true,  3,  70),
    ('Add to Slack / team chat',           'Manager invites to the relevant channels.',                   null, null,           'account_setup', true,  3,  80),
    ('Get laptop + access card',           'Pick up at office or ship to remote address.',                null, null,           'equipment',     true, 14,  90),
    ('Set up direct deposit',              'Submit via payroll portal.',                                  null, 'w2_full_time', 'account_setup', true, 14, 100),
    ('Set up direct deposit',              'Submit via payroll portal.',                                  null, 'w2_part_time', 'account_setup', true, 14, 100),
    ('Sign Independent Contractor Agreement', 'E-sign required.',                                         null, '1099_contractor','policy_sign',  true,  7, 110),
    ('30-day intro call with Kenny',       'Manager schedules 30 min on the calendar.',                   null, null,           'intro',         false, 30, 120)
on conflict do nothing;


-- ---------- 9. RLS ---------------------------------------------------------
alter table public.jobs                       enable row level security;
alter table public.job_applications           enable row level security;
alter table public.interview_events           enable row level security;
alter table public.offers                     enable row level security;
alter table public.onboarding_task_templates  enable row level security;
alter table public.onboarding_tasks           enable row level security;

-- jobs: public reads only for status='open'; admin/hr reads everything; admin/hr writes
drop policy if exists jobs_public_open_read on public.jobs;
create policy jobs_public_open_read on public.jobs for select to anon, authenticated
    using (status = 'open');

drop policy if exists jobs_hr_all on public.jobs;
create policy jobs_hr_all on public.jobs for all to authenticated
    using (public.am_i_hr_or_admin())
    with check (public.am_i_hr_or_admin());

-- job_applications: anon + authenticated can INSERT (apply); HR/admin reads + updates
drop policy if exists japps_public_insert on public.job_applications;
create policy japps_public_insert on public.job_applications for insert to anon, authenticated
    with check (true);

drop policy if exists japps_hr_read on public.job_applications;
create policy japps_hr_read on public.job_applications for select to authenticated
    using (public.am_i_hr_or_admin());

drop policy if exists japps_hr_write on public.job_applications;
create policy japps_hr_write on public.job_applications for update to authenticated
    using (public.am_i_hr_or_admin())
    with check (public.am_i_hr_or_admin());

-- interview_events: HR/admin only
drop policy if exists interviews_hr_all on public.interview_events;
create policy interviews_hr_all on public.interview_events for all to authenticated
    using (public.am_i_hr_or_admin())
    with check (public.am_i_hr_or_admin());

-- offers: HR/admin reads everything; applicant reads their own; only HR/admin writes
drop policy if exists offers_hr_all on public.offers;
create policy offers_hr_all on public.offers for all to authenticated
    using (public.am_i_hr_or_admin())
    with check (public.am_i_hr_or_admin());

drop policy if exists offers_applicant_self_read on public.offers;
create policy offers_applicant_self_read on public.offers for select to authenticated
    using (applicant_profile_id = auth.uid());

-- onboarding_task_templates: HR/admin can manage; everyone authenticated can read
drop policy if exists ott_read_authenticated on public.onboarding_task_templates;
create policy ott_read_authenticated on public.onboarding_task_templates for select to authenticated
    using (active = true);

drop policy if exists ott_hr_write on public.onboarding_task_templates;
create policy ott_hr_write on public.onboarding_task_templates for all to authenticated
    using (public.am_i_hr_or_admin())
    with check (public.am_i_hr_or_admin());

-- onboarding_tasks: staff sees own; HR/admin sees + edits all
drop policy if exists otasks_self_read on public.onboarding_tasks;
create policy otasks_self_read on public.onboarding_tasks for select to authenticated
    using (profile_id = auth.uid());

drop policy if exists otasks_self_update on public.onboarding_tasks;
create policy otasks_self_update on public.onboarding_tasks for update to authenticated
    using (profile_id = auth.uid())
    with check (profile_id = auth.uid());

drop policy if exists otasks_hr_all on public.onboarding_tasks;
create policy otasks_hr_all on public.onboarding_tasks for all to authenticated
    using (public.am_i_hr_or_admin() OR public.am_i_accounting())
    with check (public.am_i_hr_or_admin() OR public.am_i_accounting());


-- ---------- 10. Grants ----------------------------------------------------
grant select          on public.jobs                  to anon, authenticated;
grant insert          on public.job_applications      to anon, authenticated;
grant select, update  on public.job_applications      to authenticated;
grant all             on public.interview_events      to authenticated;
grant all             on public.offers                to authenticated;
grant select          on public.onboarding_task_templates to authenticated;
grant select, update  on public.onboarding_tasks      to authenticated;

grant all on public.jobs                       to service_role;
grant all on public.job_applications           to service_role;
grant all on public.interview_events           to service_role;
grant all on public.offers                     to service_role;
grant all on public.onboarding_task_templates  to service_role;
grant all on public.onboarding_tasks           to service_role;


-- ---------- 11. Sanity ----------------------------------------------------
do $$ begin
    if not exists (select 1 from pg_proc where proname='am_i_hr_or_admin' and pg_function_is_visible(oid)) then
        raise exception 'am_i_hr_or_admin missing — apply migration 055 first';
    end if;
end$$;
