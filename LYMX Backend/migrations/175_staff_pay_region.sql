-- =============================================================================
-- Migration 175 — staff pay_region (domestic vs overseas) + gated setter
-- 2026-06-01
-- =============================================================================
--
-- WHY (feedback #b45f7e73 "Send HR launch email - two templates" +
--      #6caf1dc5 "Payroll reconciliation - two templates"):
--   Domestic (USA) and overseas staff need DIFFERENT onboarding emails (different
--   required documents) and DIFFERENT payroll workflows (different pay periods /
--   pay dates). Today every page assumes a single US workflow because staff have
--   no region marker. This adds ONE classification field, pay_region, so the HR
--   launch email and the payroll reconciliation page can auto-select the right
--   template per person and separate the two workflows.
--
-- SHAPE: a single CHECK-constrained text column (Rule 1a — role/region as data,
--   not hardcoded branches) plus a SECURITY DEFINER setter so HR can change a
--   person's region from the existing admin pages WITHOUT a direct table PATCH
--   (Rule 0 — go through a gated RPC, never bypass RLS).
--
-- Depends on: migration 055/060 era (staff_profiles table, am_i_hr_or_admin()).
-- =============================================================================

-- ---------- 1. The region column -------------------------------------------
alter table public.staff_profiles
    add column if not exists pay_region text not null default 'domestic';

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'staff_profiles_pay_region_chk'
    ) then
        alter table public.staff_profiles
            add constraint staff_profiles_pay_region_chk
            check (pay_region in ('domestic','overseas'));
    end if;
end$$;

-- Existing staff default to 'domestic' (the column default already applied to
-- in-place rows; this is explicit + safe to re-run).
update public.staff_profiles
   set pay_region = 'domestic'
 where pay_region is null;

-- ---------- 2. Gated setter (HR/admin only) ---------------------------------
create or replace function public.set_staff_pay_region(
    p_user_id uuid,
    p_region  text
) returns public.staff_profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_region text := lower(btrim(coalesce(p_region, '')));
    v_row    public.staff_profiles;
begin
    if not public.am_i_hr_or_admin() then
        raise exception 'Only HR or an admin can change a staff member''s pay region.';
    end if;
    if v_region not in ('domestic','overseas') then
        raise exception 'pay_region must be domestic or overseas (got %)', p_region;
    end if;
    if p_user_id is null then
        raise exception 'p_user_id is required.';
    end if;

    update public.staff_profiles
       set pay_region = v_region
     where user_id = p_user_id
    returning * into v_row;

    if v_row.user_id is null then
        raise exception 'No staff_profiles row for that user.';
    end if;
    return v_row;
end;
$$;

revoke all on function public.set_staff_pay_region(uuid, text) from public;
grant execute on function public.set_staff_pay_region(uuid, text) to authenticated;

-- ---------- 3. Sanity --------------------------------------------------------
do $$
begin
    if not exists (select 1 from information_schema.columns
                   where table_schema='public' and table_name='staff_profiles'
                     and column_name='pay_region') then
        raise exception 'pay_region column did not get added';
    end if;
    if not exists (select 1 from pg_proc
                   where proname='set_staff_pay_region' and pg_function_is_visible(oid)) then
        raise exception 'set_staff_pay_region did not get created';
    end if;
end$$;

select 'migration 175 applied — staff pay_region ready' as status,
       count(*) filter (where pay_region='domestic') as domestic_staff,
       count(*) filter (where pay_region='overseas') as overseas_staff
  from public.staff_profiles;
