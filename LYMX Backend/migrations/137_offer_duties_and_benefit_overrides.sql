-- =============================================================================
-- Migration 137 — offers.duties_md + offers.benefit_overrides
-- =============================================================================
-- S1d (Kenny 2026-05-30): Helen needs to edit an offer's KEY RESPONSIBILITIES
-- (duties) and to TOGGLE/OVERRIDE individual benefits per offer. Benefits default
-- to the current benefits_policy snapshot, but overseas hires don't get US benefits
-- (e.g. health insurance), so each offer can override them.
--
--   duties_md         — markdown key-responsibilities, rendered as its own section
--                       in the offer letter.
--   benefit_overrides — jsonb of per-offer overrides applied OVER the policy when
--                       the letter renders. Recognized keys (all optional):
--                         offers_health (bool), offers_retirement (bool),
--                         pto_days (int), sick_days (int),
--                         eligibility_wait_days (int), health_note (text),
--                         hide_holidays (bool), extra_note (text)
--                       Empty {} = use the policy as-is (US default).
-- Idempotent.
-- =============================================================================

alter table public.offers
    add column if not exists duties_md        text,
    add column if not exists benefit_overrides jsonb not null default '{}'::jsonb;

do $s$ begin raise notice 'Migration 137 OK - offers.duties_md + offers.benefit_overrides ready.'; end$s$;
-- END migration 137
