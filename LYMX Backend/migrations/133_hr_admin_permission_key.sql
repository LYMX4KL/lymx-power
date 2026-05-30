-- =============================================================================
-- Migration 133 — seed the 'hr_admin' feature key (Phase 1 of toggler wiring)
-- =============================================================================
-- Wires the Manage-Permissions toggler (migration 104) to real enforcement,
-- starting with the HR module. After this migration + the frontend change
-- (HR pages gated with data-role-required="perm:hr_admin" in lymx-role-gate.js),
-- access to HR pages is controlled by an admin-grantable key instead of the
-- blanket am_i_admin() bypass.
--
-- Model (ARCHITECTURE-RULES Rule 1, Kenny 2026-05-30):
--   * True admins (Kenny + Helen, staff_roles.role='admin') pass everything via
--     the am_i_admin() shortcut inside has_permission().
--   * Rachel (marketing, partner) is a NON-admin granted hr_admin=true so she can
--     onboard/walk-through + test the HR module.
--   * Dave (partner) is a NON-admin who is NOT granted hr_admin, so HR pages
--     bounce him while (Phase 2) the rest of admin opens up to him.
--
-- Idempotent. Re-run safe.
-- =============================================================================

insert into public.feature_catalog
    (feature_key, label, description, category, default_for_roles, playbook_slug, page_paths)
values
    ('hr_admin',
     'HR & Payroll admin',
     'Access the HR module: staff roster, personnel records, scheduling, timesheets, payroll, offers, clock-in, inventory/property. Grant to people who onboard or manage staff.',
     'HR',
     array['admin'],            -- only true admins by default; everyone else needs an explicit grant
     'hr-onboarding-end-to-end',
     array[
        '/admin-staff.html','/admin-personnel-records.html','/admin-personnel-file.html',
        '/admin-schedule.html','/admin-schedule-requests.html','/admin-time-off.html',
        '/admin-team-roster.html','/admin-staff-locations.html','/admin-clock-in-permissions.html',
        '/admin-clock-in-requests.html','/admin-timesheets.html','/admin-payroll-reconciliation.html',
        '/admin-generate-offer.html','/admin-counter-offer-queue.html','/admin-bulk-policy-assign.html',
        '/admin-inventory.html','/admin-outstanding-property.html','/admin-send-hr-launch.html',
        '/admin-hiring.html'
     ])
on conflict (feature_key) do update set
    label             = excluded.label,
    description       = excluded.description,
    category          = excluded.category,
    default_for_roles = excluded.default_for_roles,
    playbook_slug     = excluded.playbook_slug,
    page_paths        = excluded.page_paths,
    is_active         = true,
    updated_at        = now();

do $sanity$
declare v_has boolean;
begin
    select exists(select 1 from public.feature_catalog where feature_key='hr_admin' and is_active)
      into v_has;
    raise notice 'Migration 133 OK - hr_admin present: %', v_has;
end$sanity$;
-- =============================================================================
-- END migration 133
-- =============================================================================
