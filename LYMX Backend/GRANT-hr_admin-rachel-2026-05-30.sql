-- =============================================================================
-- ACCESS GRANT (run AFTER migration 133) — Rachel gets HR admin
-- =============================================================================
-- Rachel = marketing/partner QA (partner_code P-000103). She onboards + tests
-- the HR module, so she needs HR access WITHOUT being a full am_i_admin().
-- Dave (P-000100) is intentionally NOT granted hr_admin (HR-excluded). His
-- non-HR admin access comes in Phase 2 once those pages move to perm: keys.
--
-- Preferred path is the Manage Permissions UI (/admin-manage-permissions.html):
-- find Rachel, toggle "HR & Payroll admin" ON. This SQL is the equivalent for
-- the Supabase SQL editor (where auth.uid() is null so the admin-only RPC can't
-- run — hence a direct, idempotent upsert).
-- =============================================================================

insert into public.user_permissions (user_id, perms, notes, updated_at)
select p.user_id,
       jsonb_build_object('hr_admin', true),
       'Rachel — HR onboarding/testing access (granted 2026-05-30)',
       now()
from public.partners p
where p.partner_code = 'P-000103'
on conflict (user_id) do update set
    perms      = public.user_permissions.perms || jsonb_build_object('hr_admin', true),
    notes      = 'Rachel — HR onboarding/testing access (granted 2026-05-30)',
    updated_at = now();

-- Verify
select u.user_id, u.perms -> 'hr_admin' as hr_admin
from public.user_permissions u
join public.partners p on p.user_id = u.user_id
where p.partner_code = 'P-000103';
