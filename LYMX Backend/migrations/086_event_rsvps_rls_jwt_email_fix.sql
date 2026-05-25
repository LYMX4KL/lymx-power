-- =============================================================================
-- Migration 086 — event_rsvps RLS hotfix (use auth.jwt() not auth.users subselect)
-- =============================================================================
-- Migration 085 created event_rsvps with RLS policies that read
--    (select email from auth.users where id = auth.uid())
-- to allow anonymous-submitters-who-later-sign-up to see their old RSVPs.
-- Problem: the authenticated role does NOT have SELECT on auth.users in RLS
-- evaluation context, so the policy errors and BLOCKS ALL READS for everyone
-- (including admins reading via am_i_admin()).
--
-- Fix: use auth.jwt() ->> 'email' which reads the email straight from the
-- caller's JWT claims with no schema permission required.
-- =============================================================================

drop policy if exists er_read_own_or_admin on public.event_rsvps;
create policy er_read_own_or_admin on public.event_rsvps
    for select to authenticated
    using (
        user_id = auth.uid()
        or attendee_email = (auth.jwt() ->> 'email')
        or public.am_i_admin()
    );

drop policy if exists er_self_update on public.event_rsvps;
create policy er_self_update on public.event_rsvps
    for update to authenticated
    using (
        user_id = auth.uid()
        or attendee_email = (auth.jwt() ->> 'email')
        or public.am_i_admin()
    )
    with check (
        user_id = auth.uid()
        or attendee_email = (auth.jwt() ->> 'email')
        or public.am_i_admin()
    );

-- Sanity
do $sanity$
begin
    raise notice 'Migration 086 OK — event_rsvps SELECT/UPDATE policies now use auth.jwt() ->> email';
end$sanity$;
