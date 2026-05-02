-- =============================================================================
-- LYMX Power — Grants (Phase 1 fix-up)
-- Created: 2026-05-01
-- Purpose: Grant table-level permissions to service_role and authenticated.
--
-- WHY THIS EXISTS:
-- We disabled "Automatically expose new tables and functions" at project
-- creation for security. That keeps the auto-grants away from anon/auth
-- roles, but it ALSO means service_role doesn't have INSERT/UPDATE/DELETE
-- on our 11 tables — even though it bypasses RLS, it still needs the
-- underlying table grants. Without these, Edge Functions get
-- "permission denied for table businesses" on insert.
--
-- This grants:
--   - service_role: full DML on all public tables (RLS bypass means
--     RLS policies don't apply; we trust the function code).
--   - authenticated: full DML on all public tables; RLS policies
--     filter what they can actually see/change.
--   - anon: NOTHING. No public anon access at the table level.
-- =============================================================================

-- Service role: full access (used by Edge Functions)
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Authenticated users: DML access; RLS policies enforce row-level filtering
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Anon: no table-level grants (anon should only see public views in 003+ later)

-- Apply the same grants to FUTURE tables created in public (so we don't have
-- to re-run this every time we add a table)
alter default privileges in schema public
    grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
    grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
    grant usage, select on sequences to service_role;
alter default privileges in schema public
    grant usage, select on sequences to authenticated;
