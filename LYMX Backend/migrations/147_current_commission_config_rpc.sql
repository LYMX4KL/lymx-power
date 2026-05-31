-- =============================================================================
-- Migration 147 — current_commission_config(): one source of truth for rates
-- =============================================================================
-- comp-plan.html / partner-commission-calc.html / projection.html hardcoded the
-- comp numbers ($500/$750, 9%/11%, gen %s, $1,000 speed bonus) — and drifted
-- (comp-plan showed founding rates, the projector showed regular). The live
-- numbers live in commission_rate_config, but its RLS read policy is
-- authenticated-only, so public marketing pages (anon) can't read it. This
-- SECURITY DEFINER RPC exposes ONLY the current config row as jsonb to anon +
-- authenticated, so every page renders from the same source. No writes.
-- =============================================================================

create or replace function public.current_commission_config()
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $cfg$
  select to_jsonb(c) from public.commission_rate_config c where c.is_current limit 1;
$cfg$;

grant execute on function public.current_commission_config() to anon, authenticated;

do $s$ begin raise notice 'Migration 147 OK - current_commission_config() readable by anon+auth.'; end$s$;
-- END migration 147
