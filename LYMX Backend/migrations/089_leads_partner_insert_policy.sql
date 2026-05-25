-- 089_leads_partner_insert_policy.sql
-- 2026-05-25 — root-cause fix for ticket "Adding Prospect Does Not Create Entry in Partner CRM Table"
--
-- The leads table (migration 040) had RLS enabled with only two policies:
--   - leads_admin_all   (admins can do anything)
--   - leads_owner_read  (owners can SELECT their own rows)
--
-- That left partners with NO insert/update path for their own CRM rows.
-- partner-crm.html was a client-side mock that alerted "in production this would
-- save the prospect" because the actual save path was blocked at the DB layer.
--
-- This migration adds the two missing policies so an authenticated user can:
--   1. INSERT a lead with themselves as the owner (and only themselves)
--   2. UPDATE a lead they own (stage changes, next-action edits, notes, etc.)
--
-- Deletion stays admin-only — partners should mark leads as 'lost' or 'won'
-- rather than delete, so we preserve pipeline history for commission reconciliation.

-- Partners can INSERT a row only if they set owner_user_id to themselves.
drop policy if exists leads_owner_insert on public.leads;
create policy leads_owner_insert on public.leads
    for insert to authenticated
    with check (owner_user_id = auth.uid());

-- Partners can UPDATE their own leads. The WITH CHECK clause prevents
-- changing owner_user_id to someone else (no transferring rows out).
drop policy if exists leads_owner_update on public.leads;
create policy leads_owner_update on public.leads
    for update to authenticated
    using (owner_user_id = auth.uid())
    with check (owner_user_id = auth.uid());

-- Sanity-check the policies exist after this migration runs.
do $$
declare
    policies_count integer;
begin
    select count(*) into policies_count
    from pg_policies
    where schemaname = 'public'
      and tablename = 'leads'
      and policyname in ('leads_owner_insert', 'leads_owner_update');
    if policies_count <> 2 then
        raise exception 'Migration 089 failed: expected 2 new policies on public.leads, found %', policies_count;
    end if;
end $$;
