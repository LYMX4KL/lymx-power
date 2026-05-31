-- =============================================================================
-- Migration 142 — commission READ access hardening
-- =============================================================================
-- Two read-access gaps found while verifying the new commission engine
-- (migrations 138/139). Both are root-cause fixes, not band-aids:
--
--  (1) partner_commissions had ONLY a partner-self read policy
--      (comm_partner_read: partner_id = current_partner_id()). Admins could not
--      read other partners' rows over REST, so the admin commission dashboard
--      came back empty even though the engine wrote rows. Add an admin read
--      policy. Writes stay engine/definer/service_role only.
--
--  (2) partner_income_summary(uuid) is SECURITY DEFINER and granted to
--      `authenticated`, but took ANY partner_id with NO caller check — any
--      logged-in user could read another partner's income breakdown (IDOR).
--      Harden it: a real authenticated caller may only read their OWN partner
--      (or anything if admin). Server / SQL-editor context (auth.uid() null) is
--      still allowed, matching the migration-140 guard convention, so manual
--      verification keeps working.
--
-- Idempotent.
-- =============================================================================

-- (1) admin read policy on partner_commissions ------------------------------
drop policy if exists comm_admin_read on public.partner_commissions;
create policy comm_admin_read on public.partner_commissions
    for select to authenticated
    using (public.am_i_admin());

-- (2) authorize partner_income_summary by caller ----------------------------
create or replace function public.partner_income_summary(p_partner_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $sum$
declare result jsonb;
begin
  -- Real authenticated caller may only read their own partner; admin reads any.
  -- auth.uid() null = server/cron/SQL-editor context -> allowed (mig 140 rule).
  if auth.uid() is not null
     and not public.am_i_admin()
     and p_partner_id is distinct from public.current_partner_id() then
    raise exception 'not authorized to read income for this partner';
  end if;

  select jsonb_build_object(
    'cash_total',  coalesce(sum(amount) filter (where payout_kind = 'cash'), 0),
    'lymx_total',  coalesce(sum(amount) filter (where payout_kind = 'lymx'), 0),
    'paid_total',  coalesce(sum(amount) filter (where settlement_id is not null), 0),
    'unpaid_total',coalesce(sum(amount) filter (where settlement_id is null), 0),
    'by_stream', (
      select coalesce(jsonb_object_agg(s.source_kind, s.amt), '{}'::jsonb)
        from (select source_kind, sum(amount) as amt
                from public.partner_commissions
               where partner_id = p_partner_id group by source_kind) s
    ),
    'by_generation', (
      select coalesce(jsonb_object_agg(g.generation::text, g.amt), '{}'::jsonb)
        from (select generation, sum(amount) as amt
                from public.partner_commissions
               where partner_id = p_partner_id group by generation) g
    )
  )
  into result
  from public.partner_commissions
  where partner_id = p_partner_id;

  return coalesce(result, jsonb_build_object(
    'cash_total',0,'lymx_total',0,'paid_total',0,'unpaid_total',0,
    'by_stream','{}'::jsonb,'by_generation','{}'::jsonb));
end$sum$;
grant execute on function public.partner_income_summary(uuid) to authenticated;

do $s$ begin raise notice 'Migration 142 OK - admin read policy + partner_income_summary IDOR guard.'; end$s$;
-- END migration 142
