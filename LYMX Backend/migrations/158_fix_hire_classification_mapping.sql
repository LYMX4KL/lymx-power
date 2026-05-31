-- =============================================================================
-- Migration 158 — fix staff_profiles.classification mapping on hire
-- 2026-05-30
-- =============================================================================
--
-- BUG (found in live e2e verification): both tg_offer_accepted_spawn_onboarding
-- (mig 056) and provision_hire (mig 157) wrote offers.employment_type (e.g.
-- 'full_time') straight into staff_profiles.classification, which only accepts
-- 'w2_full_time' | 'w2_part_time' | '1099_contractor' | 'intern' | 'volunteer'.
-- => every accept/provision failed with staff_profiles_classification_check.
-- (Also is_on_payroll keyed off 'w2_full_time'/'w2_part_time' but offers send
-- 'full_time'/'part_time', so it was always false.)
--
-- FIX: a single mapping helper hr_classification(employment_type) used by BOTH
-- the trigger and provision_hire. employment_type stays free-form on offers;
-- the staff_profile classification is derived correctly.
-- =============================================================================

create or replace function public.hr_classification(p_employment_type text)
returns text
language sql
immutable
as $$
    select case lower(btrim(coalesce(p_employment_type, '')))
        when 'full_time'        then 'w2_full_time'
        when 'w2_full_time'     then 'w2_full_time'
        when 'fulltime'         then 'w2_full_time'
        when 'part_time'        then 'w2_part_time'
        when 'w2_part_time'     then 'w2_part_time'
        when 'parttime'         then 'w2_part_time'
        when 'contractor'       then '1099_contractor'
        when '1099'             then '1099_contractor'
        when '1099_contractor'  then '1099_contractor'
        when 'intern'           then 'intern'
        when 'volunteer'        then 'volunteer'
        else null
    end;
$$;
grant execute on function public.hr_classification(text) to authenticated, service_role, anon;

-- ---------- Redefine the spawn trigger with the correct mapping -------------
create or replace function public.tg_offer_accepted_spawn_onboarding()
returns trigger
language plpgsql security definer
as $$
declare
    v_tmpl  record;
    v_class text;
begin
    if NEW.status <> 'accepted' or OLD.status = 'accepted' then
        return NEW;
    end if;
    if NEW.accepted_at is null then
        NEW.accepted_at := now();
    end if;

    update public.job_applications
       set status = 'hired', decided_at = now()
     where id = NEW.application_id;

    if NEW.job_id is not null then
        update public.jobs
           set status = 'filled', filled_at = now(), filled_by_user_id = NEW.applicant_profile_id
         where id = NEW.job_id;
    end if;

    if NEW.applicant_profile_id is not null then
        v_class := public.hr_classification(NEW.employment_type);
        insert into public.staff_profiles (
            user_id, hire_date, employment_status, classification, title, is_on_payroll,
            pay_type, pay_rate_cents, pay_period, created_by, updated_by
        ) values (
            NEW.applicant_profile_id, NEW.start_date, 'active', v_class, NEW.title,
            v_class in ('w2_full_time','w2_part_time'),
            NEW.pay_type, NEW.pay_rate_cents, NEW.pay_period, auth.uid(), auth.uid()
        )
        on conflict (user_id) do update
            set hire_date = excluded.hire_date, employment_status = 'active',
                classification = excluded.classification, title = excluded.title,
                is_on_payroll = excluded.is_on_payroll, pay_type = excluded.pay_type,
                pay_rate_cents = excluded.pay_rate_cents, pay_period = excluded.pay_period,
                updated_by = auth.uid();

        for v_tmpl in
            select * from public.onboarding_task_templates
             where active = true
               and (target_role is null or target_role = NEW.target_role)
               and (target_employment_type is null or target_employment_type = NEW.employment_type)
        loop
            insert into public.onboarding_tasks (
                profile_id, template_id, title, description, category, is_required, due_date
            ) values (
                NEW.applicant_profile_id, v_tmpl.id, v_tmpl.title, v_tmpl.description,
                v_tmpl.category, v_tmpl.is_required,
                NEW.start_date + (v_tmpl.suggested_due_days || ' days')::interval
            );
        end loop;
    end if;

    return NEW;
end$$;

-- ---------- Redefine provision_hire safety-net insert with the mapping ------
create or replace function public.provision_hire(
    p_offer_id uuid,
    p_user_id  uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_offer       public.offers;
    v_have_tasks  boolean;
    v_class       text;
begin
    if auth.uid() is not null and not public.am_i_hr_or_admin() then
        raise exception 'Only HR or an admin can provision a hire.';
    end if;
    if p_offer_id is null or p_user_id is null then
        raise exception 'offer id and user id are required';
    end if;

    select * into v_offer from public.offers where id = p_offer_id;
    if not found then
        raise exception 'Offer % not found', p_offer_id;
    end if;
    v_class := public.hr_classification(v_offer.employment_type);

    update public.offers set applicant_profile_id = p_user_id, updated_at = now() where id = p_offer_id;

    if v_offer.status <> 'accepted' then
        update public.offers
           set status = 'accepted', accepted_at = coalesce(accepted_at, now()), updated_at = now()
         where id = p_offer_id;
    end if;

    update public.job_applications
       set status = 'hired', decided_at = coalesce(decided_at, now())
     where id = v_offer.application_id;

    insert into public.staff_profiles (
        user_id, hire_date, employment_status, classification, title,
        is_on_payroll, pay_type, pay_rate_cents, pay_period, created_by, updated_by
    ) values (
        p_user_id, v_offer.start_date, 'active', v_class, v_offer.title,
        v_class in ('w2_full_time','w2_part_time'),
        v_offer.pay_type, v_offer.pay_rate_cents, v_offer.pay_period, auth.uid(), auth.uid()
    )
    on conflict (user_id) do update
        set hire_date = excluded.hire_date, employment_status = 'active',
            classification = excluded.classification, title = excluded.title,
            is_on_payroll = excluded.is_on_payroll, pay_type = excluded.pay_type,
            pay_rate_cents = excluded.pay_rate_cents, pay_period = excluded.pay_period,
            updated_by = auth.uid();

    select exists (select 1 from public.onboarding_tasks where profile_id = p_user_id) into v_have_tasks;
    if not v_have_tasks then
        insert into public.onboarding_tasks (profile_id, template_id, title, description, category, is_required, due_date)
        select p_user_id, t.id, t.title, t.description, t.category, t.is_required,
               v_offer.start_date + (t.suggested_due_days || ' days')::interval
          from public.onboarding_task_templates t
         where t.active = true
           and (t.target_role is null or t.target_role = v_offer.target_role)
           and (t.target_employment_type is null or t.target_employment_type = v_offer.employment_type);
    end if;

    return jsonb_build_object('ok', true, 'offer_id', p_offer_id, 'user_id', p_user_id, 'classification', v_class);
end;
$$;
grant execute on function public.provision_hire(uuid, uuid) to authenticated, service_role;

select 'migration 158 applied — hire classification mapping fixed' as status;
