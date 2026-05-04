-- =============================================================================
-- LYMX Power — Intake Forms: Mode 1 (storefront) + Mode 3 (self-employed)
-- Created: 2026-05-04
-- Purpose: Add business_kind discriminator + custom services for self-employed.
-- Companion doc: LYMX Power/INTAKE-FORMS-WORKING-DOC.md  (Section 5.1)
-- =============================================================================
--
-- WHY THIS MIGRATION IS SPLIT (Kenny, this is for you):
-- ----------------------------------------------------------------------------
-- The full Section 5 spec calls for SIX additions to the schema:
--   1. business_kind discriminator on businesses           ← in this file
--   2. business_custom_services (Mode 3 self-employed)     ← in this file
--   3. business_issuance_scenarios (Form B fee scenarios)  → migration 007
--   4. firm_agent_links (Mode 2 agent-at-firm)             → migration 007
--   5. firm_agent_reward_config (firm rewards defaults)    → migration 007
--   6. firm_agent_reward_grants (actual grants)            → migration 007
--
-- The InvestPro team is finalizing the Form B (firm) shape, so we ship the
-- non-firm half now and add migration 007 once their feedback is in.
-- Mode 1 (storefront) needs only the discriminator — its single flat issuance
-- rate already lives in businesses.issuance_rate from migration 001.
-- =============================================================================

begin;


-- -----------------------------------------------------------------------------
-- 1. Discriminator on businesses
-- -----------------------------------------------------------------------------
-- Tells us which intake mode the business signed up under, and drives:
--   - which form fields to show in the dashboard
--   - which issuance config table to read from
--   - which scenarios are available to enable
--
-- Default = 'storefront' so existing rows from earlier smoke tests stay valid.
-- Allowed values include 'firm' and 'agent_at_firm' even though we won't write
-- those rows until migration 007 — having the check constraint match the full
-- vocabulary now means migration 007 won't have to re-do the constraint.
alter table public.businesses
    add column if not exists business_kind text not null default 'storefront'
        check (business_kind in (
            'storefront',
            'self_employed',
            'firm',
            'agent_at_firm'
        ));

comment on column public.businesses.business_kind is
    'Discriminator from intake form. Drives which issuance config to read.';

create index if not exists idx_businesses_kind
    on public.businesses (business_kind)
    where archived_at is null;


-- -----------------------------------------------------------------------------
-- 2. business_custom_services  (Form A Mode 3 — self-employed menu)
-- -----------------------------------------------------------------------------
-- A self-employed pro (solo CPA, freelance designer, consultant, etc.) lists
-- the services they offer plus how much LYMX they issue per booking. One row
-- per service. Editable post-signup from the business dashboard.
create table if not exists public.business_custom_services (
    id                uuid primary key default uuid_generate_v4(),
    business_id       uuid not null references public.businesses(id) on delete cascade,
    service_name      text not null,
    description       text,
    price_usd         numeric,                       -- optional, informational
    lymx_per_booking  numeric not null,              -- fixed amount, lock #3
    sort_order        integer not null default 0,
    enabled           boolean not null default true,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),

    constraint chk_lymx_nonneg   check (lymx_per_booking >= 0),
    constraint chk_price_nonneg  check (price_usd is null or price_usd >= 0)
);

comment on table public.business_custom_services is
    'Self-employed pros (Form A Mode 3) list their services + LYMX per booking.';

-- Look up "all services for this business" fast (most common query)
create index if not exists idx_custom_services_business
    on public.business_custom_services (business_id, sort_order)
    where enabled;

-- Auto-update updated_at on row change (uses the trigger fn from 001).
-- Naming convention from 001: trg_<table>_updated
drop trigger if exists trg_business_custom_services_updated
    on public.business_custom_services;
create trigger trg_business_custom_services_updated
    before update on public.business_custom_services
    for each row execute function public.set_updated_at();

-- RLS: row-level security on
alter table public.business_custom_services enable row level security;

-- Business owner can do anything to their own services
create policy "custom_services_owner_full"
    on public.business_custom_services
    for all to authenticated
    using       (public.is_business_owner(business_id))
    with check  (public.is_business_owner(business_id));

-- Service role bypasses RLS automatically (used by Edge Functions for signup).
-- No explicit grants needed: migration 003 set default privileges so future
-- tables in public auto-grant DML to service_role + authenticated.

commit;


-- =============================================================================
-- VERIFICATION QUERIES (run after migration to confirm)
-- =============================================================================
-- 1. Confirm column added:
--    select column_name, data_type, column_default
--    from information_schema.columns
--    where table_schema='public' and table_name='businesses'
--      and column_name='business_kind';
--
-- 2. Confirm new table exists:
--    select count(*) from public.business_custom_services;   -- expect 0
--
-- 3. Confirm RLS is on:
--    select tablename, rowsecurity
--    from pg_tables
--    where schemaname='public' and tablename='business_custom_services';
-- =============================================================================
