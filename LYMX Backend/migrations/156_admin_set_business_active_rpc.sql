-- =============================================================================
-- Migration 156 — admin_set_business_active() : real deactivate / reactivate
--                 for businesses (the business_partners roster)
-- 2026-05-30
-- =============================================================================
--
-- WHY: live verification showed a direct PATCH of business_partners.active by an
--      admin updated ZERO rows with NO error (am_i_admin() = true, but no admin
--      UPDATE policy actually permits the write in prod) — the same silent
--      no-op shape we just fixed for customers and partners. A SECURITY DEFINER
--      RPC gated on am_i_admin() is the root-cause fix that is guaranteed to
--      persist regardless of the table's RLS policy state.
--
-- Reversible: flips business_partners.active and records who/when for audit.
-- "Business" is one of the three audience roles (business / partner / customer);
--      it is kept strictly separate from "partner" everywhere in the UI.
--
-- ACCESS: am_i_admin() only, fail-closed.
-- Depends on: migration 012 (business_partners), 015/102 (am_i_admin).
-- =============================================================================

alter table public.business_partners
    add column if not exists deactivated_at timestamptz,
    add column if not exists deactivated_by uuid references auth.users(id) on delete set null;

create or replace function public.admin_set_business_active(
    p_business_partner_id uuid,
    p_active              boolean
) returns public.business_partners
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row public.business_partners;
begin
    if not public.am_i_admin() then
        raise exception 'Only an admin can deactivate or reactivate a business.';
    end if;
    if p_business_partner_id is null then
        raise exception 'business id is required';
    end if;

    update public.business_partners
       set active         = coalesce(p_active, true),
           deactivated_at = case when p_active then null else coalesce(deactivated_at, now()) end,
           deactivated_by = case when p_active then null else auth.uid() end
     where id = p_business_partner_id
    returning * into v_row;

    if not found then
        raise exception 'Business % not found', p_business_partner_id;
    end if;
    return v_row;
end;
$$;

revoke all on function public.admin_set_business_active(uuid, boolean) from public;
grant execute on function public.admin_set_business_active(uuid, boolean) to authenticated;

-- ---------- Sanity ----------------------------------------------------------
do $$
begin
    if not exists (select 1 from pg_proc where proname = 'admin_set_business_active' and pg_function_is_visible(oid)) then
        raise exception 'admin_set_business_active did not get created';
    end if;
end$$;

select 'migration 156 applied — admin_set_business_active ready' as status;
