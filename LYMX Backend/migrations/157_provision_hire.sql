-- =============================================================================
-- Migration 157 — provision_hire() + find_auth_user_by_email()
-- 2026-05-30
-- =============================================================================
--
-- WHY: the onboarding-spawn trigger (mig 056) only creates the staff_profile +
--      onboarding tasks IF the offer has an applicant_profile_id (an auth
--      account). A careers applicant has none, and nothing in the flow created
--      one — so accepted hires were marked 'hired' but never appeared in
--      Personnel Records and got no onboarding tasks. Per Kenny (2026-05-30):
--      HR provisions the account on accept.
--
-- This migration provides the SQL half. The `provision-hire` Edge Function
-- creates/locates the candidate's auth user (service role), then calls
-- provision_hire(offer_id, user_id) which is IDEMPOTENT and works whether the
-- offer was already accepted (candidate self-accepted with no account) or is
-- being accepted now by HR.
--
-- ACCESS: provision_hire allows the service-role caller (auth.uid() IS NULL,
--      the EF already enforced HR auth) and blocks authenticated non-HR users.
-- Depends on: mig 056 (offers, job_applications, staff_profiles,
--      onboarding_task(_templates)), mig 055 (am_i_hr_or_admin).
-- =============================================================================

-- Resolve an existing auth user by email (the EF uses this before createUser).
create or replace function public.find_auth_user_by_email(p_email text)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
    select id from auth.users where lower(email) = lower(btrim(p_email)) limit 1;
$$;
revoke all on function public.find_auth_user_by_email(text) from public, anon, authenticated;
-- service_role only (called from the provision-hire Edge Function).
grant execute on function public.find_auth_user_by_email(text) to service_role;

-- Idempotent hire provisioning: link account, accept offer, ensure staff_profile
-- + onboarding tasks.
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
begin
    -- Allow the service-role caller (EF already enforced HR auth). Block any
    -- authenticated non-HR user that reaches this directly.
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

    -- 1) Link the account (separate from the status flip so the BEFORE-UPDATE
    --    trigger sees applicant_profile_id already set when status changes).
    update public.offers
       set applicant_profile_id = p_user_id,
           updated_at = now()
     where id = p_offer_id;

    -- 2) Accept the offer if not already. This fires tg_offer_accepted_spawn_
    --    onboarding (mig 056) which, with applicant_profile_id now set, creates
    --    the staff_profile + onboarding tasks + marks the application hired.
    if v_offer.status <> 'accepted' then
        update public.offers
           set status = 'accepted',
               accepted_at = coalesce(accepted_at, now()),
               updated_at = now()
         where id = p_offer_id;
    end if;

    -- 3) Idempotent safety net for the already-accepted case (trigger did NOT
    --    re-fire because OLD.status was already 'accepted'): ensure the
    --    application is hired, the staff_profile exists, and tasks are seeded.
    update public.job_applications
       set status = 'hired', decided_at = coalesce(decided_at, now())
     where id = v_offer.application_id;

    insert into public.staff_profiles (
        user_id, hire_date, employment_status, classification, title,
        is_on_payroll, pay_type, pay_rate_cents, pay_period, created_by, updated_by
    ) values (
        p_user_id, v_offer.start_date, 'active', v_offer.employment_type, v_offer.title,
        v_offer.employment_type in ('w2_full_time','w2_part_time'),
        v_offer.pay_type, v_offer.pay_rate_cents, v_offer.pay_period, auth.uid(), auth.uid()
    )
    on conflict (user_id) do update
        set hire_date = excluded.hire_date,
            employment_status = 'active',
            classification = excluded.classification,
            title = excluded.title,
            is_on_payroll = excluded.is_on_payroll,
            pay_type = excluded.pay_type,
            pay_rate_cents = excluded.pay_rate_cents,
            pay_period = excluded.pay_period,
            updated_by = auth.uid();

    select exists (select 1 from public.onboarding_tasks where profile_id = p_user_id)
      into v_have_tasks;
    if not v_have_tasks then
        insert into public.onboarding_tasks (
            profile_id, template_id, title, description, category, is_required, due_date
        )
        select p_user_id, t.id, t.title, t.description, t.category, t.is_required,
               v_offer.start_date + (t.suggested_due_days || ' days')::interval
          from public.onboarding_task_templates t
         where t.active = true
           and (t.target_role is null or t.target_role = v_offer.target_role)
           and (t.target_employment_type is null or t.target_employment_type = v_offer.employment_type);
    end if;

    return jsonb_build_object('ok', true, 'offer_id', p_offer_id, 'user_id', p_user_id);
end;
$$;

revoke all on function public.provision_hire(uuid, uuid) from public, anon;
grant execute on function public.provision_hire(uuid, uuid) to authenticated, service_role;

-- ---------- Sanity ----------------------------------------------------------
do $$
begin
    if not exists (select 1 from pg_proc where proname='provision_hire' and pg_function_is_visible(oid)) then
        raise exception 'provision_hire did not get created';
    end if;
    if not exists (select 1 from pg_proc where proname='find_auth_user_by_email' and pg_function_is_visible(oid)) then
        raise exception 'find_auth_user_by_email did not get created';
    end if;
end$$;

select 'migration 157 applied — provision_hire + find_auth_user_by_email ready' as status;
