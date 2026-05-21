-- Migration 068 â feedback self-update RLS for owner
--
-- Bugs #2f77dc20 + #63f2961b (filed 2026-05-20 by Dave): "Feedback List Does
-- Not Have Edit Option" / "Feedback System Does Not Allow Users to Resolve
-- Their Own Tickets". Same root cause as the customers/team_calendars saga:
-- migration 008 added INSERT (auth+anon) and SELECT (own) policies plus
-- admin-all, but never added UPDATE for the OWNER of the row. So the
-- modal-driven edit flow + the user self-resolve button get silently denied.
--
-- Fix: let an authenticated user UPDATE their OWN feedback rows. Admins keep
-- their existing all-rows policy. Anonymous tickets (user_id is null) remain
-- admin-only by design.
--
-- Apply via Supabase SQL editor.

drop policy if exists feedback_update_own on public.feedback;
create policy feedback_update_own on public.feedback
    for update to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());
