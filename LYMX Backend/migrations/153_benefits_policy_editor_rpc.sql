-- =============================================================================
-- Migration 153 — upsert_benefits_policy() : backend for the Benefits Policy editor
-- 2026-05-30
-- =============================================================================
--
-- WHY: admin-generate-offer.html tells HR "Edit the policy -> all future offers
--      reflect the change," but no editor page or write path ever existed in the
--      frontend. benefits_policy could only be changed by hand-editing SQL. This
--      RPC is the backend for the new admin-benefits-policy.html editor.
--
-- SHAPE (versioned config, mirrors ARCHITECTURE-RULES Rule 4):
--   Every save creates a NEW version row and atomically flips is_current, so
--   already-generated offers stay reproducible by their pinned benefits_policy_id.
--   We never mutate a historical version in place.
--
-- ACCESS BOUNDARY — UNCHANGED. The guard is exactly am_i_admin() OR am_i_cfo(),
--   identical to the existing benefits_policy_write RLS (migration 055). This
--   migration does NOT widen who can edit benefits and does NOT touch any shared
--   role helper — it only adds a write path for the access that already existed.
--
-- Depends on: migration 055 (benefits_policy table, am_i_admin/am_i_cfo helpers).
-- =============================================================================

create or replace function public.upsert_benefits_policy(
    p_pto_days_full_time        int,
    p_pto_accrual_method        text,
    p_sick_days_full_time       int,
    p_sick_accrual_method       text,
    p_paid_holidays             text[],
    p_eligibility_wait_days     int,
    p_offers_health             boolean,
    p_offers_retirement         boolean,
    p_health_employee_share_pct numeric,
    p_notes                     text
) returns public.benefits_policy
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_next_version int;
    v_row          public.benefits_policy;
begin
    -- Fail-closed authorization. Mirrors benefits_policy_write RLS exactly.
    if not (public.am_i_admin() or public.am_i_cfo()) then
        raise exception 'Only an admin or CFO can edit the benefits policy.';
    end if;

    -- Validate enums loudly (a bad value must error, never be silently coerced).
    if p_pto_accrual_method is null
       or p_pto_accrual_method not in ('lump_annual','per_pay_period','tenure_tiered') then
        raise exception 'Invalid PTO accrual method: %', p_pto_accrual_method;
    end if;
    if p_sick_accrual_method is null
       or p_sick_accrual_method not in ('lump_annual','per_pay_period') then
        raise exception 'Invalid sick accrual method: %', p_sick_accrual_method;
    end if;
    if p_pto_days_full_time is null or p_pto_days_full_time < 0 then
        raise exception 'PTO days must be 0 or more.';
    end if;
    if p_sick_days_full_time is null or p_sick_days_full_time < 0 then
        raise exception 'Sick days must be 0 or more.';
    end if;
    if p_eligibility_wait_days is null or p_eligibility_wait_days < 0 then
        raise exception 'Eligibility wait days must be 0 or more.';
    end if;
    if p_health_employee_share_pct is not null
       and (p_health_employee_share_pct < 0 or p_health_employee_share_pct > 100) then
        raise exception 'Health employee share must be between 0 and 100.';
    end if;

    select coalesce(max(version), 0) + 1 into v_next_version
      from public.benefits_policy;

    -- Unset the prior current row FIRST so the partial unique index
    -- idx_benefits_policy_current (one is_current row) is never violated mid-tx,
    -- and stamp when it stopped being effective (clean audit trail).
    update public.benefits_policy
       set is_current      = false,
           effective_until = current_date
     where is_current;

    insert into public.benefits_policy (
        version, is_current,
        pto_days_full_time, pto_accrual_method,
        sick_days_full_time, sick_accrual_method,
        paid_holidays, eligibility_wait_days,
        offers_health, offers_retirement, health_employee_share_pct,
        effective_from, notes, created_by
    ) values (
        v_next_version, true,
        p_pto_days_full_time, p_pto_accrual_method,
        p_sick_days_full_time, p_sick_accrual_method,
        coalesce(p_paid_holidays, array[]::text[]), p_eligibility_wait_days,
        coalesce(p_offers_health, false), coalesce(p_offers_retirement, false),
        p_health_employee_share_pct,
        current_date, nullif(btrim(p_notes), ''), auth.uid()
    )
    returning * into v_row;

    return v_row;
end;
$$;

revoke all on function public.upsert_benefits_policy(
    int, text, int, text, text[], int, boolean, boolean, numeric, text
) from public;
grant execute on function public.upsert_benefits_policy(
    int, text, int, text, text[], int, boolean, boolean, numeric, text
) to authenticated;

-- ---------- Sanity ----------------------------------------------------------
do $$
begin
    if not exists (select 1 from pg_proc where proname = 'am_i_cfo' and pg_function_is_visible(oid)) then
        raise exception 'am_i_cfo() missing — apply migration 055 first';
    end if;
    if not exists (select 1 from pg_proc where proname = 'upsert_benefits_policy' and pg_function_is_visible(oid)) then
        raise exception 'upsert_benefits_policy did not get created';
    end if;
end$$;

select 'migration 153 applied — upsert_benefits_policy ready' as status,
       (select version from public.benefits_policy where is_current) as current_policy_version;
