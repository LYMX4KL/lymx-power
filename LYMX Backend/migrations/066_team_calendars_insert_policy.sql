-- Migration 066 — team_calendars INSERT policy for authenticated users
--
-- Bug #4c53cd0c (filed 2026-05-20 by Dave): clicking "Create my calendar"
-- on /team-calendar.html fails with:
--   "new row violates row-level security policy for table 'team_calendars'"
--
-- Root cause: migration 040 enabled RLS on team_calendars and added
-- SELECT (public), UPDATE (owner) and ALL (admin) policies, but never
-- added an INSERT policy for the owner. Authenticated users could not
-- create their own calendar at all.
--
-- Fix: add an INSERT policy that lets any authenticated user create a
-- calendar row whose user_id matches their auth.uid(). This matches the
-- intent of tc_owner_update (each user owns their own single calendar)
-- and is the minimum policy needed to make /team-calendar.html work.
--
-- Apply via Supabase SQL editor.

drop policy if exists tc_owner_insert on public.team_calendars;
create policy tc_owner_insert on public.team_calendars
    for insert to authenticated
    with check (user_id = auth.uid());
