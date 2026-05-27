-- =============================================================================
-- Migration 106 — feature_catalog rows for Sprint 1 business settlement
-- =============================================================================
-- Registers the four feature keys that gate Sprint 1 capabilities, per
-- ARCHITECTURE-RULES Rule 1 ("Every feature is an assignable permission")
-- and migration 104's feature-permission infrastructure.
--
-- Features registered:
--   business_view_settlements  — business owner sees their settlement history
--                                 + the unsettled-balance card on biz-payouts.html
--   admin_run_settlements      — admin runs a settlement batch manually from
--                                 admin-settlements.html (or via the EF directly)
--   admin_approve_settlement   — admin transitions a pending settlement to
--                                 approved (gating before any Stripe leg fires)
--   admin_view_app_config      — admin sees + edits app_config tunables
--                                 (buyback rate, settlement cadence, stripe gate)
--
-- Default grants:
--   business_view_settlements  → business_owner role default true
--   admin_*                    → admin role only (admin always passes via
--                                am_i_admin() short-circuit; not listed in
--                                default_for_roles, just gated by admin status)
--
-- Idempotent. Re-running this migration only inserts missing rows.
-- =============================================================================

set local statement_timeout = 0;

begin;

-- =====================================================================
-- 1. Register the four feature keys
-- =====================================================================
insert into public.feature_catalog
    (feature_key, label, description, category, default_for_roles, playbook_slug, page_paths)
values
    ('business_view_settlements',
     'View My Settlements',
     'See the monthly settlement history showing LYMX issued, LYMX redeemed, and the net USD owed (or owed to you) for each period.',
     'business',
     array['business_owner']::text[],
     'business-onboarding-08-settlement',
     array['/biz-payouts.html']::text[]),

    ('admin_run_settlements',
     'Run Settlement Batch',
     'Trigger a settlement compute + Stripe transfer batch for one business or the whole network for a given period.',
     'admin',
     array[]::text[],
     'admin-settlement-run',
     array['/admin-settlements.html']::text[]),

    ('admin_approve_settlement',
     'Approve Pending Settlement',
     'Transition a pending settlement to approved (required before any Stripe transfer or invoice fires).',
     'admin',
     array[]::text[],
     'admin-settlement-run',
     array['/admin-settlements.html']::text[]),

    ('admin_view_app_config',
     'View + Edit App Config',
     'See and adjust platform tunables: buyback rate, settlement cadence, Stripe Connect rollout gate.',
     'admin',
     array[]::text[],
     null,
     array['/admin-app-config.html']::text[])
on conflict (feature_key) do update set
    label             = excluded.label,
    description       = excluded.description,
    category          = excluded.category,
    default_for_roles = excluded.default_for_roles,
    playbook_slug     = excluded.playbook_slug,
    page_paths        = excluded.page_paths,
    is_active         = true,
    updated_at        = now();

-- =====================================================================
-- 2. Sanity check
-- =====================================================================
do $sanity_106$
declare
    v_count int;
    v_keys  text[];
begin
    select count(*), array_agg(feature_key order by feature_key)
      into v_count, v_keys
      from public.feature_catalog
     where feature_key in (
        'business_view_settlements',
        'admin_run_settlements',
        'admin_approve_settlement',
        'admin_view_app_config'
     );

    raise notice 'mig 106: registered_keys=% (%)', v_count, v_keys;

    if v_count <> 4 then
        raise exception 'Migration 106 sanity failed: expected 4 settlement feature_catalog rows, found %', v_count;
    end if;
end
$sanity_106$;

commit;

-- =============================================================================
-- End of migration 106
-- =============================================================================
