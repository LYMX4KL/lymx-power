-- =============================================================================
-- Migration 062 — customers.preferences JSONB column
-- 2026-05-19
-- =============================================================================
--
-- Adds a single jsonb column to public.customers to persist customer-facing
-- toggle preferences from /customer-settings:
--
--   notify_push                 (bool) — push notification consent
--   notify_sms                  (bool) — text-message consent
--   notify_email_digest         (bool) — weekly digest opt-in
--   notify_referrals            (bool) — friends-joined / bonus alerts
--   privacy_show_reviews        (bool) — show first name on public reviews
--   privacy_location_browsing   (bool) — share location while browsing
--
-- All 6 are simple booleans. Defaults below match the on-disk HTML defaults
-- so existing accounts behave identically to before until they explicitly
-- change a toggle (no surprise opt-outs).
--
-- Fixes Dave tickets 70b54da7, 68b4b62e, d62c71d8, 22c09c18, 688a2349, 55705730.
--
-- Idempotent. Safe to re-run.
-- =============================================================================

alter table public.customers
    add column if not exists preferences jsonb not null default '{}'::jsonb;

-- Seed defaults for any existing row that doesn't have them, so reads
-- never return null/undefined for the 6 known keys.
update public.customers
   set preferences = coalesce(preferences, '{}'::jsonb) || jsonb_build_object(
       'notify_push',               true,
       'notify_sms',                true,
       'notify_email_digest',       false,
       'notify_referrals',          true,
       'privacy_show_reviews',      true,
       'privacy_location_browsing', true
   )
 where not (preferences ? 'notify_push'
        and preferences ? 'notify_sms'
        and preferences ? 'notify_email_digest'
        and preferences ? 'notify_referrals'
        and preferences ? 'privacy_show_reviews'
        and preferences ? 'privacy_location_browsing');

-- RLS — preferences are part of customers row, so the existing customers
-- self-read/self-update policies already cover them. No additional policies
-- needed; verify with this read.
select
    'migration 062 applied' as status,
    (select count(*) from public.customers where preferences ? 'notify_push') as rows_seeded;
