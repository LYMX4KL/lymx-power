-- =============================================================================
-- Migration 060 — admin_list_user_emails helper
-- 2026-05-19
-- =============================================================================
--
-- The HR admin pages (admin-personnel-records.html, admin-personnel-file.html,
-- admin-issue-write-up.html, etc.) need to display staff names + emails next
-- to user_id values.  auth.users isn't directly readable from client RLS,
-- so we expose a small SECURITY DEFINER RPC restricted to am_i_hr_or_admin().
--
-- Returns one row per auth user the caller may legitimately see (admins see
-- everyone; staff sees no one through this helper).
--
-- Depends on migration 055 (am_i_hr_or_admin).
-- =============================================================================

create or replace function public.admin_list_user_emails()
returns table (
    user_id   uuid,
    email     text,
    full_name text
)
language sql security definer stable
as $$
    select u.id as user_id,
           u.email::text,
           coalesce(u.raw_user_meta_data->>'full_name', u.email)::text as full_name
      from auth.users u
     where public.am_i_hr_or_admin()
     order by lower(coalesce(u.raw_user_meta_data->>'full_name', u.email))
$$;

revoke all on function public.admin_list_user_emails() from public;
grant execute on function public.admin_list_user_emails() to authenticated;

-- Sanity
do $$ begin
    if not exists (select 1 from pg_proc where proname='am_i_hr_or_admin' and pg_function_is_visible(oid)) then
        raise exception 'am_i_hr_or_admin missing — apply migration 055 first';
    end if;
end$$;
