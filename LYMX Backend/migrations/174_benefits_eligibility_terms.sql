-- =============================================================================
-- Migration 174 — Benefits eligibility terms: full-time-only + explicit summary
-- 2026-06-01
-- =============================================================================
--
-- WHY (feedback #da347aa6 "Benefits policy" + #0d02770f "Generate offer- Benefits"):
--   Testers reading the Benefits Policy page and a generated offer letter could not
--   tell, from the page itself, (a) WHO is eligible for benefits and (b) WHEN
--   benefits begin. One tester inferred "benefits start 1 year after the 90-day
--   wait" — that inference is WRONG and there was nothing on the page to correct it.
--
--   The REAL company policy (confirmed by Kenny 2026-06-01):
--     • Eligibility begins AFTER the 90-day probation period (already held in
--       benefits_policy.eligibility_wait_days = 90 — no change to that).
--     • Benefits apply to FULL-TIME employees only.
--     • Some benefits accrue / are earned over time (PTO accrues per its accrual
--       method; retirement vesting may apply) — i.e. "day-91" is when you become
--       ELIGIBLE, not when every benefit is fully earned.
--
--   There is NO blanket "1 year after probation" delay. This migration makes the
--   true terms first-class CONFIG (Rule 4 — config-driven, not hardcoded) so the
--   policy editor, the offer letter, and any future surface all read the same
--   single source of truth and can never drift from a hardcoded copy.
--
-- SHAPE: two new columns on the versioned benefits_policy config table, plus the
--   upsert_benefits_policy() RPC extended to write them. The function signature
--   changes, so we DROP the old signature and recreate (only caller is
--   admin-benefits-policy.html, updated in the same change set).
--
-- ACCESS BOUNDARY — UNCHANGED. Guard stays exactly am_i_admin() OR am_i_cfo(),
--   identical to migration 153. No role helper touched, no one new can edit.
--
-- Depends on: migration 055 (benefits_policy table + am_i_admin/am_i_cfo),
--             migration 153 (upsert_benefits_policy v1).
-- =============================================================================

-- ---------- 1. New config columns -------------------------------------------
alter table public.benefits_policy
    add column if not exists eligibility_employment_type text not null default 'full_time',
    add column if not exists eligibility_note            text;

-- Constrain the employment-type value (loud failure on a bad value, never coerce).
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'benefits_policy_eligibility_emp_type_chk'
    ) then
        alter table public.benefits_policy
            add constraint benefits_policy_eligibility_emp_type_chk
            check (eligibility_employment_type in ('full_time','part_time','all'));
    end if;
end$$;

-- Backfill the current + historical rows so every version states the policy.
-- 'full_time' is already the column default; only fill the human note where blank.
update public.benefits_policy
   set eligibility_note = 'Eligibility begins after the '
        || coalesce(eligibility_wait_days, 90)
        || '-day probation period and applies to full-time employees only. '
        || 'Some benefits accrue or vest over time — see each benefit''s accrual method.'
 where eligibility_note is null or btrim(eligibility_note) = '';

-- ---------- 2. Extend upsert_benefits_policy() ------------------------------
-- Drop the migration-153 signature so we can add the two new params.
drop function if exists public.upsert_benefits_policy(
    int, text, int, text, text[], int, boolean, boolean, numeric, text
);

create or replace function public.upsert_benefits_policy(
    p_pto_days_full_time          int,
    p_pto_accrual_method          text,
    p_sick_days_full_time         int,
    p_sick_accrual_method         text,
    p_paid_holidays               text[],
    p_eligibility_wait_days       int,
    p_offers_health               boolean,
    p_offers_retirement           boolean,
    p_health_employee_share_pct   numeric,
    p_notes                       text,
    p_eligibility_employment_type text default 'full_time',
    p_eligibility_note            text default null
) returns public.benefits_policy
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_next_version int;
    v_row          public.benefits_policy;
    v_emp_type     text := coalesce(nullif(btrim(p_eligibility_employment_type), ''), 'full_time');
begin
    -- Fail-closed authorization. Mirrors benefits_policy_write RLS exactly.
    if not (public.am_i_admin() or public.am_i_cfo()) then
        raise exception 'Only an admin or CFO can edit the benefits policy.';
    end if;

    -- Validate enums loudly.
    if p_pto_accrual_method is null
       or p_pto_accrual_method not in ('lump_annual','per_pay_period','tenure_tiered') then
        raise exception 'Invalid PTO accrual method: %', p_pto_accrual_method;
    end if;
    if p_sick_accrual_method is null
       or p_sick_accrual_method not in ('lump_annual','per_pay_period') then
        raise exception 'Invalid sick accrual method: %', p_sick_accrual_method;
    end if;
    if v_emp_type not in ('full_time','part_time','all') then
        raise exception 'Invalid eligibility employment type: %', v_emp_type;
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
        eligibility_employment_type, eligibility_note,
        effective_from, notes, created_by
    ) values (
        v_next_version, true,
        p_pto_days_full_time, p_pto_accrual_method,
        p_sick_days_full_time, p_sick_accrual_method,
        coalesce(p_paid_holidays, array[]::text[]), p_eligibility_wait_days,
        coalesce(p_offers_health, false), coalesce(p_offers_retirement, false),
        p_health_employee_share_pct,
        v_emp_type, nullif(btrim(p_eligibility_note), ''),
        current_date, nullif(btrim(p_notes), ''), auth.uid()
    )
    returning * into v_row;

    return v_row;
end;
$$;

revoke all on function public.upsert_benefits_policy(
    int, text, int, text, text[], int, boolean, boolean, numeric, text, text, text
) from public;
grant execute on function public.upsert_benefits_policy(
    int, text, int, text, text[], int, boolean, boolean, numeric, text, text, text
) to authenticated;

-- ---------- 3. Sanity --------------------------------------------------------
do $$
begin
    if not exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='benefits_policy'
                     and column_name='eligibility_employment_type') then
        raise exception 'eligibility_employment_type column did not get added';
    end if;
    if not exists (select 1 from pg_proc
                   where proname='upsert_benefits_policy' and pronargs=12) then
        raise exception 'upsert_benefits_policy(12-arg) did not get created';
    end if;
end$$;

select 'migration 174 applied — benefits eligibility terms are config-backed' as status,
       (select eligibility_employment_type from public.benefits_policy where is_current) as current_emp_type;
