-- Migration 054 — SUPERSEDED / NO-OP
-- 2026-05-19
--
-- The schema this migration would have created (business_pos_integrations +
-- pos_vendor enum) duplicates what migration 004 already built as
-- `square_integrations` and the existing OAuth flow. Keeping `square_integrations`
-- as the source of truth keeps the existing square-oauth-* + square-webhook
-- Edge Functions wired without refactor.
--
-- This file is left in place (no-op) so the migration sequence stays linear
-- without renumber surprises.

do $$ begin raise notice 'Migration 054: no-op — square_integrations from migration 004 already covers this surface'; end $$;
