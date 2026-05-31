-- =============================================================================
-- Migration 155 — admin_archive_partner() : real archive / restore for partners
-- 2026-05-30
-- =============================================================================
--
-- WHY: admin-partners.html called sb.from('partners').update({archived_at})
--      directly, but public.partners has NO admin-update RLS policy — only
--      partner_self_update (user_id = auth.uid()). So an admin archiving another
--      partner updated ZERO rows: the toast said "Suspended" but nothing
--      persisted (the same looks-wired-but-isn't shape we just fixed for
--      customers and offers). This SECURITY DEFINER RPC fixes it at the root.
--
-- Reversible soft-delete: set / clear archived_at (the partners public directory
--      and downline queries already filter on archived_at).
--
-- Businesses are handled separately: the admin "Businesses" roster is the
--      business_partners table, which already has the b2b_admin_all admin-write
--      RLS policy + an `active` flag, so that page toggles `active` directly
--      (no RPC needed). Staff are intentionally excluded — personnel files are
--      retained for compliance and role removal already exists on admin-staff.html.
--
-- ACCESS: am_i_admin() only, fail-closed.
-- Depends on: migration 001 (partners), 015/102 (am_i_admin).
-- =============================================================================

alter table public.partners
    add column if not exists archived_by uuid references auth.users(id) on delete set null;

create or replace function public.admin_archive_partner(
    p_partner_id uuid,
    p_archived   boolean
) returns public.partners
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_row public.partners;
begin
    if not public.am_i_admin() then
        raise exception 'Only an admin can archive or restore a partner account.';
    end if;
    if p_partner_id is null then
        raise exception 'partner id is required';
    end if;

    update public.partners
       set archived_at = case when p_archived then coalesce(archived_at, now()) else null end,
           archived_by = case when p_archived then auth.uid() else null end
     where id = p_partner_id
    returning * into v_row;

    if not found then
        raise exception 'Partner % not found', p_partner_id;
    end if;
    return v_row;
end;
$$;

revoke all on function public.admin_archive_partner(uuid, boolean) from public;
grant execute on function public.admin_archive_partner(uuid, boolean) to authenticated;

-- ---------- Sanity ----------------------------------------------------------
do $$
begin
    if not exists (select 1 from pg_proc where proname = 'admin_archive_partner' and pg_function_is_visible(oid)) then
        raise exception 'admin_archive_partner did not get created';
    end if;
end$$;

select 'migration 155 applied — admin_archive_partner ready' as status;
