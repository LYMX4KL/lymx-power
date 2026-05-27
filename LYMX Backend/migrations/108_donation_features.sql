-- =============================================================================
-- Migration 108 — feature_catalog rows for Sprint 2 donations
-- =============================================================================
-- Registers the feature keys that gate Sprint 2 Phase A capabilities per
-- ARCHITECTURE-RULES Rule 1 + migration 104's feature-permission infrastructure.
--
-- Features registered:
--   customer_donate_lymx       — customer can pick a verified nonprofit and
--                                donate LYMX from their wallet via
--                                customer-charity.html.
--   admin_manage_nonprofits    — admin can verify, edit, or disable
--                                nonprofits in the registry (Sprint 2 Phase B
--                                page: admin-nonprofits.html).
--   admin_run_donations_payout — admin runs the monthly batch that pays out
--                                pending donations to nonprofits via Stripe
--                                Connect (Sprint 3 EF, gated by
--                                app_config.stripe_connect_enabled).
--
-- Defaults:
--   customer_donate_lymx   → authenticated (any signed-in user)
--   admin_*                → admin-only (admin always passes via the
--                            am_i_admin() short-circuit in has_permission)
--
-- Idempotent. Re-running this migration only inserts missing rows.
-- =============================================================================

set local statement_timeout = 0;

begin;

insert into public.feature_catalog
    (feature_key, label, description, category, default_for_roles, playbook_slug, page_paths)
values
    ('customer_donate_lymx',
     'Donate LYMX to a nonprofit',
     'Pick a verified nonprofit and donate LYMX from your wallet. The nonprofit receives the USD equivalent at the clearing-house rate ($0.008 per LYMX).',
     'customer',
     array['authenticated']::text[],
     'customer-onboarding-04-donate-lymx',
     array['/customer-charity.html']::text[]),

    ('admin_manage_nonprofits',
     'Manage Nonprofit Registry',
     'Verify, edit, or disable nonprofits in the donation registry. Only verified nonprofits accept donations.',
     'admin',
     array[]::text[],
     'admin-manage-nonprofits',
     array['/admin-nonprofits.html']::text[]),

    ('admin_run_donations_payout',
     'Run Donations Payout',
     'Trigger the monthly batch that pays out pending donations to nonprofits via Stripe Connect. Gated by app_config.stripe_connect_enabled.',
     'admin',
     array[]::text[],
     'admin-donations-payout-run',
     array['/admin-donations.html']::text[])
on conflict (feature_key) do update set
    label             = excluded.label,
    description       = excluded.description,
    category          = excluded.category,
    default_for_roles = excluded.default_for_roles,
    playbook_slug     = excluded.playbook_slug,
    page_paths        = excluded.page_paths,
    is_active         = true,
    updated_at        = now();

-- Sanity
do $sanity_108$
declare
    v_count int;
begin
    select count(*) into v_count from public.feature_catalog
     where feature_key in (
        'customer_donate_lymx',
        'admin_manage_nonprofits',
        'admin_run_donations_payout'
     );

    raise notice 'mig 108: donation_feature_rows=%', v_count;

    if v_count <> 3 then
        raise exception 'Migration 108 sanity failed: expected 3 donation feature_catalog rows, found %', v_count;
    end if;
end
$sanity_108$;

commit;

-- =============================================================================
-- End of migration 108
-- =============================================================================
