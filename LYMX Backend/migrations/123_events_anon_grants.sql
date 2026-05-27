-- =====================================================================
-- Migration 123 — Grant anon SELECT on events + event_speakers (HOTFIX)
-- =====================================================================
-- 2026-05-27 — migration 122 enabled RLS and created `events_public_read`
-- and `event_speakers_public_read` policies, but didn't grant table-level
-- SELECT to the anon role. Result: anon REST queries returned HTTP 401
-- "permission denied for table events" because PostgreSQL checks the
-- table grant BEFORE evaluating RLS policies. RLS policy was correct
-- (status='published'), but anon never got that far.
--
-- This migration adds the missing grants. Idempotent.
-- =====================================================================

begin;

grant select on public.events         to anon, authenticated;
grant select on public.event_speakers to anon, authenticated;

-- Sanity check
do $$
begin
    raise notice 'Migration 123 applied: anon + authenticated can SELECT from events + event_speakers (RLS still scopes to status=published for non-admins).';
end$$;

commit;
