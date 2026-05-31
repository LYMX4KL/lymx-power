-- =============================================================================
-- Migration 141 — partner_income_summary: guard against null jsonb keys
-- =============================================================================
-- partner_income_summary built jsonb_object_agg keyed by source_kind and
-- generation. If ANY of the partner's partner_commissions rows has a null
-- source_kind or null generation (e.g. legacy rows predating the engine),
-- jsonb_object_agg throws "field name must not be null". Coalesce the keys so
-- the summary is robust. Idempotent (create or replace).
-- =============================================================================

create or replace function public.partner_income_summary(p_partner_id uuid)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $sum$
  select jsonb_build_object(
    'cash_total',   coalesce(sum(amount) filter (where payout_kind = 'cash'), 0),
    'lymx_total',   coalesce(sum(amount) filter (where payout_kind = 'lymx'), 0),
    'paid_total',   coalesce(sum(amount) filter (where settlement_id is not null), 0),
    'unpaid_total', coalesce(sum(amount) filter (where settlement_id is null), 0),
    'row_count',    count(*),
    'by_stream', (
      select coalesce(jsonb_object_agg(s.k, s.amt), '{}'::jsonb)
        from (select coalesce(source_kind, '(unspecified)') as k, sum(amount) as amt
                from public.partner_commissions
               where partner_id = p_partner_id
               group by coalesce(source_kind, '(unspecified)')) s
    ),
    'by_generation', (
      select coalesce(jsonb_object_agg(g.k, g.amt), '{}'::jsonb)
        from (select coalesce(generation::text, '(none)') as k, sum(amount) as amt
                from public.partner_commissions
               where partner_id = p_partner_id
               group by coalesce(generation::text, '(none)')) g
    )
  )
  from public.partner_commissions
  where partner_id = p_partner_id;
$sum$;
grant execute on function public.partner_income_summary(uuid) to authenticated;

do $s$ begin raise notice 'Migration 141 OK - partner_income_summary null-key safe.'; end$s$;
-- END migration 141
