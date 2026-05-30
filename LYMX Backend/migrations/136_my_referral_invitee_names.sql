-- =============================================================================
-- Migration 136 — my_referral_invitee_names(): resolve a partner's recruited
--                 customers' names without exposing the customers table.
-- =============================================================================
-- Root cause of "Partner My Customers shows ID instead of name": partner-my-
-- customers.html joined to public.customers to get display_name, but RLS only
-- lets a customer read their OWN row (customer_self_read) + biz owners read their
-- customers. A partner cannot read their invitees' customer rows, so the name map
-- was empty and the page fell back to "customer …<uid-tail>".
--
-- Fix: a SECURITY DEFINER resolver SCOPED to the caller's own referrals
-- (inviter_user_id = auth.uid()). Returns the canonical name from
-- auth.users.raw_user_meta_data->>'full_name' (populated from hiring/identity by
-- mig 134), falling back to customers.display_name, then email. Safe: only the
-- caller's own invitees are returned; no broad name exposure.
-- Idempotent.
-- =============================================================================

create or replace function public.my_referral_invitee_names()
returns table (invitee_user_id uuid, full_name text)
language sql
security definer
stable
set search_path = public, auth, pg_temp
as $$
  select r.invitee_user_id,
         coalesce(
           nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
           nullif(btrim(c.display_name), ''),
           u.email
         )::text as full_name
    from public.referrals r
    join auth.users u on u.id = r.invitee_user_id
    left join public.customers c on c.user_id = r.invitee_user_id
   where r.inviter_user_id = auth.uid();
$$;

revoke all on function public.my_referral_invitee_names() from public;
grant execute on function public.my_referral_invitee_names() to authenticated;

do $s$ begin raise notice 'Migration 136 OK - my_referral_invitee_names() ready.'; end$s$;
-- END migration 136
