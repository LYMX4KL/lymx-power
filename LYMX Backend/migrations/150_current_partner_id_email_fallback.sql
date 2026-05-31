-- =============================================================================
-- Migration 150 — current_partner_id(): add contact_email fallback
-- =============================================================================
-- current_partner_id() matched ONLY partners.user_id = auth.uid(). But the
-- frontend + lymx-role-gate resolve a partner by user_id OR contact_email, so a
-- partner whose auth account isn't linked to partners.user_id (matched only by
-- email) gets INTO partner pages, then gets rejected by every SECURITY DEFINER
-- guard that compares against current_partner_id() — partner_income_summary
-- (mig 142), partner_benchmarks (148), fn_partner_income_statement (143),
-- set_partner_goal (149), and the partner_goals RLS read. Result: blank income
-- statement / projector / goals for those partners.
--
-- Root-cause fix: make current_partner_id() also fall back to a contact_email
-- match against the caller's auth email (preferring the user_id link). This
-- fixes ALL of the above at once and matches how the rest of the app resolves
-- partners. SECURITY DEFINER so it can read auth.users.email.
-- =============================================================================

create or replace function public.current_partner_id()
returns uuid
language sql stable security definer set search_path = public, pg_temp
as $$
  select p.id
    from public.partners p
   where p.user_id = auth.uid()
      or lower(p.contact_email) = lower((select u.email from auth.users u where u.id = auth.uid()))
   order by (p.user_id = auth.uid()) desc nulls last,
            p.created_at asc
   limit 1;
$$;

grant execute on function public.current_partner_id() to authenticated;

do $s$ begin raise notice 'Migration 150 OK - current_partner_id() now falls back to contact_email.'; end$s$;
-- END migration 150
