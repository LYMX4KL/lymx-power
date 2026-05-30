-- 132_drop_orphan_permission_rpcs.sql
-- =============================================================================
-- Cleanup of orphan RPCs created during the 2026-05-29 stale-folder incident.
--
-- What happened: a duplicate "090_feature_permissions_backend.sql" was written
-- and applied against a STALE copy of the backend, before we discovered the
-- canonical backend (with the real migration 104) lived in a nested folder.
-- That duplicate created non-canonical RPCs:
--     has_feature(text), my_features(), grant_permission(uuid,text,boolean),
--     revoke_permission(uuid,text), admin_set_staff_role(uuid,text),
--     admin_resolve_user_by_email(text)
-- The canonical permission API lives in migration 104:
--     has_permission(text), has_permissions(text[]), list_my_permissions(),
--     grant_permission(uuid,text,boolean,text), revoke_permission(uuid,text,text)
-- and the canonical staff/email helpers are admin_list_user_emails (mig 060)
-- + is_staff()/am_i_admin() (mig 102).
--
-- ORDER OF OPERATIONS (Supabase SQL editor):
--   1. Re-apply migration 104 first  (restores the canonical permission RPCs;
--      it is fully idempotent — create-or-replace + on-conflict seed).
--   2. Then run THIS file to drop the orphans.
--
-- All drops are IF EXISTS, so this is safe even if an orphan is already gone.
-- The canonical grant_permission/revoke_permission have DIFFERENT signatures
-- (extra trailing text param), so these drops never touch the canonical ones.
-- =============================================================================

drop function if exists public.my_features();
drop function if exists public.has_feature(text);
drop function if exists public.admin_set_staff_role(uuid, text);
drop function if exists public.admin_resolve_user_by_email(text);
drop function if exists public.grant_permission(uuid, text, boolean);   -- orphan 3-arg (canonical is 4-arg)
drop function if exists public.revoke_permission(uuid, text);           -- orphan 2-arg (canonical is 3-arg)

-- Verify (optional): these should all be MISSING after, and the canonical
-- has_permission/grant_permission(...,text)/revoke_permission(...,text) present.
-- select proname, pg_get_function_identity_arguments(oid)
--   from pg_proc where proname in
--   ('has_feature','my_features','admin_set_staff_role','admin_resolve_user_by_email',
--    'has_permission','grant_permission','revoke_permission','list_my_permissions');
