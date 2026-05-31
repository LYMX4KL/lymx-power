-- =============================================================================
-- Migration 154 — admin_archive_customer() : real close / reopen for customers
-- 2026-05-30
-- =============================================================================
--
-- WHY: admin-customers.html "Suspend account" only mutated an in-memory row and
--      showed a success toast — it never touched the database (the same mock-
--      action band-aid shape as the offer page once had). There is no admin
--      write policy on public.customers, so a SECURITY DEFINER RPC is the
--      root-cause fix: it closes (archives) or reopens a customer account and
--      records WHO did it.
--
-- "Close" == set archived_at (drops the customer from the active roster, the
--      same flag the roster query already filters on). "Reopen" clears it.
--
-- ACCESS: am_i_admin() only. Closing/reopening a customer account is an
--      admin-sensitive action; fail-closed.
--
-- Depends on: migration 001 (customers), migration 015/037/102 (am_i_admin).
-- =============================================================================

-- Audit column: who closed the account (nullable; only set while archived).
alter table public.customers
    add column if not exists archived_by uuid references auth.users(id) on delete set null;

create or replace function public.admin_archive_customer(
    p_customer_id uuid,
    p_archived    boolean
) returns public.customers
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row public.customers;
begin
    if not public.am_i_admin() then
        raise exception 'Only an admin can close or reopen a customer account.';
    end if;
    if p_customer_id is null then
        raise exception 'customer id is required';
    end if;

    update public.customers
       set archived_at = case when p_archived then coalesce(archived_at, now()) else null end,
           archived_by = case when p_archived then auth.uid() else null end,
           updated_at  = now()
     where id = p_customer_id
    returning * into v_row;

    if not found then
        raise exception 'Customer % not found', p_customer_id;
    end if;

    return v_row;
end;
$$;

revoke all on function public.admin_archive_customer(uuid, boolean) from public;
grant execute on function public.admin_archive_customer(uuid, boolean) to authenticated;

-- ---------- Sanity ----------------------------------------------------------
do $$
begin
    if not exists (select 1 from pg_proc where proname = 'admin_archive_customer' and pg_function_is_visible(oid)) then
        raise exception 'admin_archive_customer did not get created';
    end if;
end$$;

select 'migration 154 applied — admin_archive_customer ready' as status;
