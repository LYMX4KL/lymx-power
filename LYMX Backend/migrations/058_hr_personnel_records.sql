-- =============================================================================
-- Migration 058 — HR Phase D: personnel records (write-ups + performance reviews)
-- 2026-05-19
-- =============================================================================
--
-- Mirror of InvestPro PM db/201 + db/202 (personnel-records + reviews bits).
--
--   • personnel_write_ups: defensible write-up form with 14-day response window
--     and severity-escalating system-issued lunch-policy enforcement.
--   • performance_reviews: 3-mode flow (self / manager / sign) for probation,
--     6-month, annual, quarterly, adhoc.
--
-- Depends on migration 055 (am_i_hr_or_admin, staff_profiles).
-- =============================================================================


-- ---------- 1. personnel_write_ups -----------------------------------------
create table if not exists public.personnel_write_ups (
    id                   uuid primary key default gen_random_uuid(),
    profile_id           uuid not null references auth.users(id) on delete cascade,

    -- Categorization
    severity             text not null
                             check (severity in ('verbal_warning','written_warning','final_warning','pip','termination_notice')),
    category             text,                                        -- attendance / policy / performance / conduct / safety / other

    -- Incident facts (defensibility)
    incident_date        date not null,
    incident_time        time,
    description          text not null,                               -- min 20 chars enforced in app
    witnesses            text,                                        -- comma-separated names

    -- Policy linkage
    policy_violated      text,                                        -- e.g. "Office Code of Conduct §4"
    prior_warnings       text,                                        -- summary of prior history

    -- Expectations
    expectations         text not null,                               -- min 10 chars enforced in app
    consequences         text not null,                               -- what happens if not corrected
    improvement_deadline date,                                        -- by-when

    -- Issuer audit
    issued_by_id         uuid references auth.users(id) on delete set null,    -- NULLABLE: system-issued lunch write-ups have null
    issued_by_name       text not null,                               -- e.g. 'System — lunch policy enforcement'
    issued_by_role       text,
    issued_at            timestamptz not null default now(),

    -- Status flow
    status               text not null default 'issued'
                             check (status in ('issued','acknowledged','response_submitted','closed','rescinded')),
    acknowledged_at      timestamptz,
    response_deadline    timestamptz,                                 -- = acknowledged_at + interval '14 days'
    response_text        text,                                        -- staff's written response
    response_submitted_at timestamptz,
    closed_at            timestamptz,
    closed_by_id         uuid references auth.users(id) on delete set null,
    rescinded_at         timestamptz,
    rescinded_reason     text,

    -- Audit
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);

create index if not exists idx_wu_profile      on public.personnel_write_ups(profile_id, issued_at desc);
create index if not exists idx_wu_status       on public.personnel_write_ups(status, issued_at desc);
create index if not exists idx_wu_severity     on public.personnel_write_ups(severity);
create index if not exists idx_wu_issued_recent on public.personnel_write_ups(issued_at desc);


-- ---------- 2. performance_reviews ----------------------------------------
create table if not exists public.performance_reviews (
    id                       uuid primary key default gen_random_uuid(),
    profile_id               uuid not null references auth.users(id) on delete cascade,
    manager_id               uuid references auth.users(id) on delete set null,

    -- Period
    period                   text not null
                                 check (period in ('probation_30','probation_60','probation_90','six_month','annual','quarterly','adhoc')),
    period_start_date        date,
    period_end_date          date,
    scheduled_for            date,

    -- Self-assessment (staff fills in)
    self_top_wins            text,
    self_growth_areas        text,
    self_blockers            text,
    self_goals_next          text,
    self_overall_rating      int check (self_overall_rating between 1 and 5 or self_overall_rating is null),
    self_submitted_at        timestamptz,

    -- Manager assessment (manager/HR fills in)
    manager_assessment       text,
    manager_strengths        text,
    manager_growth_areas     text,
    manager_action_items     text,
    rating_overall           int check (rating_overall between 1 and 5 or rating_overall is null),
    rating_attendance        int check (rating_attendance between 1 and 5 or rating_attendance is null),
    rating_quality           int check (rating_quality between 1 and 5 or rating_quality is null),
    rating_initiative        int check (rating_initiative between 1 and 5 or rating_initiative is null),
    rating_teamwork          int check (rating_teamwork between 1 and 5 or rating_teamwork is null),
    compensation_rec         text check (compensation_rec in ('hold','small_raise','mid_raise','big_raise','promotion','pip','term') or compensation_rec is null),
    manager_submitted_at     timestamptz,

    -- Status
    status                   text not null default 'scheduled'
                                 check (status in ('scheduled','self_pending','manager_pending','complete','signed','cancelled')),
    acknowledged_at          timestamptz,                                 -- staff confirms they've seen the manager portion
    cancelled_at             timestamptz,
    cancelled_reason         text,

    -- Audit
    created_at               timestamptz not null default now(),
    created_by_id            uuid references auth.users(id) on delete set null,
    updated_at               timestamptz not null default now()
);

create index if not exists idx_reviews_profile  on public.performance_reviews(profile_id, scheduled_for desc);
create index if not exists idx_reviews_status   on public.performance_reviews(status, scheduled_for desc);


-- ---------- 3. updated_at trigger ----------------------------------------
create or replace function public.tg_pr_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end$$;

drop trigger if exists trg_wu_updated_at on public.personnel_write_ups;
create trigger trg_wu_updated_at before update on public.personnel_write_ups
    for each row execute function public.tg_pr_updated_at();

drop trigger if exists trg_pr_updated_at on public.performance_reviews;
create trigger trg_pr_updated_at before update on public.performance_reviews
    for each row execute function public.tg_pr_updated_at();


-- ---------- 4. RPCs: write-up workflow ------------------------------------

-- 4a. Issue write-up
create or replace function public.issue_write_up(
    p_profile_id            uuid,
    p_severity              text,
    p_category              text,
    p_incident_date         date,
    p_description           text,
    p_policy_violated       text,
    p_expectations          text,
    p_consequences          text,
    p_improvement_deadline  date default null,
    p_witnesses             text default null,
    p_prior_warnings        text default null
)
returns public.personnel_write_ups
language plpgsql security definer
as $$
declare
    v_row    public.personnel_write_ups;
    v_role   text;
    v_name   text;
begin
    if not public.am_i_hr_or_admin() then
        raise exception 'Only HR/admin/compliance can issue write-ups';
    end if;

    if length(coalesce(p_description, '')) < 20 then
        raise exception 'Description must be at least 20 characters (be factual + objective)';
    end if;
    if length(coalesce(p_expectations, '')) < 10 then
        raise exception 'Expectations must be at least 10 characters (be specific + measurable)';
    end if;

    select role into v_role from public.staff_roles where user_id = auth.uid();
    select coalesce(raw_user_meta_data->>'full_name', email)
      into v_name from auth.users where id = auth.uid();

    insert into public.personnel_write_ups (
        profile_id, severity, category,
        incident_date, description, policy_violated,
        prior_warnings, expectations, consequences,
        improvement_deadline, witnesses,
        issued_by_id, issued_by_name, issued_by_role
    ) values (
        p_profile_id, p_severity, p_category,
        p_incident_date, p_description, p_policy_violated,
        p_prior_warnings, p_expectations, p_consequences,
        p_improvement_deadline, p_witnesses,
        auth.uid(), v_name, v_role
    )
    returning * into v_row;

    return v_row;
end$$;

-- 4b. Acknowledge — staff confirms they've seen + understood the write-up
create or replace function public.acknowledge_write_up(p_id uuid)
returns public.personnel_write_ups
language plpgsql security definer
as $$
declare
    v_row public.personnel_write_ups;
begin
    select * into v_row from public.personnel_write_ups where id = p_id;
    if v_row.id is null then raise exception 'Write-up not found'; end if;
    if v_row.profile_id <> auth.uid() then raise exception 'Only the recipient can acknowledge'; end if;
    if v_row.status <> 'issued' then raise exception 'Already actioned (status=%)', v_row.status; end if;

    update public.personnel_write_ups
       set status            = 'acknowledged',
           acknowledged_at   = now(),
           response_deadline = now() + interval '14 days'
     where id = p_id
    returning * into v_row;

    return v_row;
end$$;

-- 4c. Submit response (staff's written response, within 14-day window)
create or replace function public.submit_write_up_response(
    p_id           uuid,
    p_response     text
)
returns public.personnel_write_ups
language plpgsql security definer
as $$
declare
    v_row public.personnel_write_ups;
begin
    select * into v_row from public.personnel_write_ups where id = p_id;
    if v_row.id is null then raise exception 'Write-up not found'; end if;
    if v_row.profile_id <> auth.uid() then raise exception 'Only the recipient can respond'; end if;
    if v_row.status <> 'acknowledged' then raise exception 'Must acknowledge first (current status=%)', v_row.status; end if;
    if v_row.response_deadline is not null and now() > v_row.response_deadline then
        raise exception 'Response window closed (% expired)', v_row.response_deadline;
    end if;
    if length(coalesce(p_response, '')) < 5 then
        raise exception 'Response too short';
    end if;

    update public.personnel_write_ups
       set status                = 'response_submitted',
           response_text         = p_response,
           response_submitted_at = now()
     where id = p_id
    returning * into v_row;

    return v_row;
end$$;

-- 4d. Close — HR closes after response or deadline
create or replace function public.close_write_up(p_id uuid)
returns public.personnel_write_ups
language plpgsql security definer
as $$
declare
    v_row public.personnel_write_ups;
begin
    if not public.am_i_hr_or_admin() then raise exception 'Only HR/admin can close write-ups'; end if;
    update public.personnel_write_ups
       set status       = 'closed',
           closed_at    = now(),
           closed_by_id = auth.uid()
     where id = p_id
    returning * into v_row;
    return v_row;
end$$;


-- ---------- 5. System-issued write-up (for cron lunch-policy enforcement) -
-- Called only by the enforce-lunch-policy EF via service-role JWT.
-- Auto-escalates severity based on prior-30-day count.
create or replace function public.system_issue_missed_lunch_writeup(
    p_profile_id    uuid,
    p_shift_date    date,
    p_minutes_short int default 0
)
returns public.personnel_write_ups
language plpgsql security definer
as $$
declare
    v_prior int;
    v_severity text;
    v_row public.personnel_write_ups;
begin
    -- Count prior lunch-missed write-ups in last 30 days
    select count(*) into v_prior
      from public.personnel_write_ups
     where profile_id = p_profile_id
       and category = 'lunch_policy'
       and issued_at > now() - interval '30 days';

    v_severity := case
        when v_prior = 0 then 'verbal_warning'
        when v_prior = 1 then 'written_warning'
        else 'final_warning'
    end;

    insert into public.personnel_write_ups (
        profile_id, severity, category,
        incident_date, description, policy_violated,
        prior_warnings, expectations, consequences,
        issued_by_id, issued_by_name, issued_by_role
    ) values (
        p_profile_id, v_severity, 'lunch_policy',
        p_shift_date,
        'Failed to take a qualifying lunch break during a shift of 6+ hours. ' ||
            case when p_minutes_short > 0
                 then 'Short by ' || p_minutes_short || ' minutes.'
                 else 'No lunch break taken.'
            end,
        'LYMX Power Lunch + Break Policy',
        case v_prior when 0 then 'No prior lunch write-ups in last 30 days.'
                     when 1 then '1 prior lunch write-up in last 30 days.'
                     else v_prior || ' prior lunch write-ups in last 30 days.' end,
        'Take a qualifying lunch break (default 60 min, or your assigned minimum) during every shift of 6+ hours.',
        'Further violations may result in escalating discipline up to and including termination.',
        null, 'System — lunch policy enforcement', 'system'
    )
    returning * into v_row;

    return v_row;
end$$;


-- ---------- 6. RPCs: performance review workflow --------------------------

-- 6a. Schedule review (HR/admin/manager initiates)
create or replace function public.schedule_performance_review(
    p_profile_id    uuid,
    p_period        text,
    p_period_start  date,
    p_period_end    date,
    p_scheduled_for date,
    p_manager_id    uuid default null
)
returns public.performance_reviews
language plpgsql security definer
as $$
declare
    v_row public.performance_reviews;
begin
    if not public.am_i_hr_or_admin() then raise exception 'Only HR/admin can schedule reviews'; end if;

    insert into public.performance_reviews (
        profile_id, manager_id, period,
        period_start_date, period_end_date, scheduled_for,
        status, created_by_id
    ) values (
        p_profile_id, coalesce(p_manager_id, auth.uid()), p_period,
        p_period_start, p_period_end, p_scheduled_for,
        'self_pending', auth.uid()
    )
    returning * into v_row;

    return v_row;
end$$;

-- 6b. Staff submits self-assessment
create or replace function public.submit_review_self_assessment(
    p_id                uuid,
    p_top_wins          text,
    p_growth_areas      text,
    p_blockers          text,
    p_goals_next        text,
    p_overall_rating    int
)
returns public.performance_reviews
language plpgsql security definer
as $$
declare
    v_row public.performance_reviews;
begin
    select * into v_row from public.performance_reviews where id = p_id;
    if v_row.id is null then raise exception 'Review not found'; end if;
    if v_row.profile_id <> auth.uid() then raise exception 'Only the staff being reviewed can submit self-assessment'; end if;
    if v_row.status not in ('scheduled','self_pending') then raise exception 'Self phase closed (status=%)', v_row.status; end if;

    update public.performance_reviews
       set self_top_wins        = p_top_wins,
           self_growth_areas    = p_growth_areas,
           self_blockers        = p_blockers,
           self_goals_next      = p_goals_next,
           self_overall_rating  = p_overall_rating,
           self_submitted_at    = now(),
           status               = 'manager_pending'
     where id = p_id
    returning * into v_row;

    return v_row;
end$$;

-- 6c. Manager submits assessment
create or replace function public.submit_review_manager_assessment(
    p_id                  uuid,
    p_assessment          text,
    p_strengths           text,
    p_growth_areas        text,
    p_action_items        text,
    p_rating_overall      int,
    p_rating_attendance   int,
    p_rating_quality      int,
    p_rating_initiative   int,
    p_rating_teamwork     int,
    p_compensation_rec    text
)
returns public.performance_reviews
language plpgsql security definer
as $$
declare
    v_row public.performance_reviews;
begin
    if not public.am_i_hr_or_admin() then raise exception 'Only HR/admin/manager can submit manager-assessment'; end if;

    select * into v_row from public.performance_reviews where id = p_id;
    if v_row.id is null then raise exception 'Review not found'; end if;
    if v_row.status not in ('manager_pending','self_pending') then raise exception 'Manager phase closed (status=%)', v_row.status; end if;

    update public.performance_reviews
       set manager_assessment    = p_assessment,
           manager_strengths     = p_strengths,
           manager_growth_areas  = p_growth_areas,
           manager_action_items  = p_action_items,
           rating_overall        = p_rating_overall,
           rating_attendance     = p_rating_attendance,
           rating_quality        = p_rating_quality,
           rating_initiative     = p_rating_initiative,
           rating_teamwork       = p_rating_teamwork,
           compensation_rec      = p_compensation_rec,
           manager_submitted_at  = now(),
           status                = 'complete'
     where id = p_id
    returning * into v_row;

    return v_row;
end$$;

-- 6d. Staff acknowledges manager's review (final stage)
create or replace function public.acknowledge_performance_review(p_id uuid)
returns public.performance_reviews
language plpgsql security definer
as $$
declare
    v_row public.performance_reviews;
begin
    select * into v_row from public.performance_reviews where id = p_id;
    if v_row.id is null then raise exception 'Review not found'; end if;
    if v_row.profile_id <> auth.uid() then raise exception 'Only the staff being reviewed can acknowledge'; end if;
    if v_row.status <> 'complete' then raise exception 'Review not ready for acknowledgment (status=%)', v_row.status; end if;

    update public.performance_reviews
       set status         = 'signed',
           acknowledged_at = now()
     where id = p_id
    returning * into v_row;

    return v_row;
end$$;


-- ---------- 7. RLS --------------------------------------------------------
alter table public.personnel_write_ups enable row level security;
alter table public.performance_reviews enable row level security;

-- write-ups: staff sees own; HR/admin sees all
drop policy if exists wu_self_read on public.personnel_write_ups;
create policy wu_self_read on public.personnel_write_ups for select to authenticated
    using (profile_id = auth.uid());

drop policy if exists wu_hr_read on public.personnel_write_ups;
create policy wu_hr_read on public.personnel_write_ups for select to authenticated
    using (public.am_i_hr_or_admin());

-- Only RPCs can write
drop policy if exists wu_hr_write on public.personnel_write_ups;
create policy wu_hr_write on public.personnel_write_ups for all to authenticated
    using (public.am_i_hr_or_admin())
    with check (public.am_i_hr_or_admin());

-- reviews: staff sees own; HR/admin sees all
drop policy if exists pr_self_read on public.performance_reviews;
create policy pr_self_read on public.performance_reviews for select to authenticated
    using (profile_id = auth.uid() OR manager_id = auth.uid());

drop policy if exists pr_hr_read on public.performance_reviews;
create policy pr_hr_read on public.performance_reviews for select to authenticated
    using (public.am_i_hr_or_admin());

drop policy if exists pr_hr_write on public.performance_reviews;
create policy pr_hr_write on public.performance_reviews for all to authenticated
    using (public.am_i_hr_or_admin())
    with check (public.am_i_hr_or_admin());


-- ---------- 8. Grants -----------------------------------------------------
grant select on public.personnel_write_ups to authenticated;
grant select on public.performance_reviews to authenticated;
grant execute on function public.issue_write_up(uuid,text,text,date,text,text,text,text,date,text,text) to authenticated;
grant execute on function public.acknowledge_write_up(uuid) to authenticated;
grant execute on function public.submit_write_up_response(uuid,text) to authenticated;
grant execute on function public.close_write_up(uuid) to authenticated;
grant execute on function public.system_issue_missed_lunch_writeup(uuid,date,int) to service_role;
grant execute on function public.schedule_performance_review(uuid,text,date,date,date,uuid) to authenticated;
grant execute on function public.submit_review_self_assessment(uuid,text,text,text,text,int) to authenticated;
grant execute on function public.submit_review_manager_assessment(uuid,text,text,text,text,int,int,int,int,int,text) to authenticated;
grant execute on function public.acknowledge_performance_review(uuid) to authenticated;
grant all on public.personnel_write_ups to service_role;
grant all on public.performance_reviews to service_role;


-- ---------- 9. Sanity ----------------------------------------------------
do $$ begin
    if not exists (select 1 from pg_proc where proname='am_i_hr_or_admin' and pg_function_is_visible(oid)) then
        raise exception 'am_i_hr_or_admin missing — apply migration 055 first';
    end if;
end$$;
