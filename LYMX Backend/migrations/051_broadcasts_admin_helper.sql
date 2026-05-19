-- Migration 051 — let any admin (not just Kenny) insert broadcasts
-- Bug fix #e0441aec: admin-invite-friends.html POSTs to /rest/v1/broadcasts
-- to log a per-recipient invite. The original RLS hard-coded Kenny's UUID,
-- so any other admin (Dave testing as admin role, for example) got HTTP 403
-- "insert 403" and the invite never went out.
--
-- New rule: anyone the am_i_admin() helper considers an admin can manage
-- broadcasts. Kenny's UUID is still implicit because he's flagged admin in
-- staff_roles, but the policy no longer cares about the specific UUID.

drop policy if exists broadcasts_admin_all on public.broadcasts;

create policy broadcasts_admin_all on public.broadcasts
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- Sanity: the function must exist. If not, fail loud rather than silently
-- leave broadcasts with no policy (which would lock everyone out).
do $$
begin
    if not exists (
        select 1
        from pg_proc
        where proname = 'am_i_admin'
          and pg_function_is_visible(oid)
    ) then
        raise exception 'am_i_admin() helper is missing — apply earlier migration first';
    end if;
end$$;
