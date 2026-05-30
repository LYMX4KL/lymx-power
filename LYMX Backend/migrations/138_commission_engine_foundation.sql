-- =============================================================================
-- Migration 138 — Commission engine FOUNDATION: config-driven rates + ledger cols
-- =============================================================================
-- The MGC commission ENGINE was never built — partner_commissions is never
-- populated, so every payout/dashboard/projector shows $0. This migration lays
-- the foundation; migration 139 adds the accrual functions.
--
-- Comp plan (Kenny 2026-05-30), CONFIG-DRIVEN so marketing can change rates
-- without a code change ("% x the fee"):
--   * Activation bonus (one-time, CASH, to the direct/signing partner at go-live):
--       regular $500 · qualified Founding-25 $750 (+ $1000 speed bonus, 5 in 3 mo)
--   * Transaction-fee commission (recurring, paid in LYMX):
--       platform fee = transaction_fee_pct x (LYMX issued + redeemed) for the
--       business in the period (NOT transaction USD); MGC of that fee: direct
--       9% (reg) / 11% (founding), G1 3%, G2 2%, G3 1%. Paid in LYMX units.
--   * Monthly-fee commission (recurring, paid in CASH):
--       same MGC on business_subscriptions.monthly_amount collected; the first
--       monthly_fee_free_months months are free (no commission).
--   Only the DIRECT rate bumps for founding; G1/G2/G3 are the same for everyone.
--   "Qualified founding" = partners.is_founding_25 (the promoted gate).
-- =============================================================================

-- ---------- 1. commission_rate_config (versioned, single current) -----------
create table if not exists public.commission_rate_config (
    id                              uuid primary key default gen_random_uuid(),
    version                         int  not null,
    is_current                      boolean not null default false,
    effective_from                  date not null default current_date,
    -- activation
    activation_bonus_regular_cents  int  not null default 50000,   -- $500
    activation_bonus_founding_cents int  not null default 75000,   -- $750
    founding_speed_bonus_cents      int  not null default 100000,  -- $1000
    founding_speed_count            int  not null default 5,
    founding_speed_window_months    int  not null default 3,
    -- transaction fee (the platform's cut that MGC is paid on)
    transaction_fee_pct             numeric(6,3) not null default 3.000,  -- % of LYMX volume (issued+redeemed)
    -- MGC override rates (percent). direct bumps for founding; gens are flat.
    direct_pct_regular              numeric(6,3) not null default 9.000,
    direct_pct_founding             numeric(6,3) not null default 11.000,
    g1_pct                          numeric(6,3) not null default 3.000,
    g2_pct                          numeric(6,3) not null default 2.000,
    g3_pct                          numeric(6,3) not null default 1.000,
    -- monthly fee free period
    monthly_fee_free_months         int  not null default 3,
    notes                           text,
    created_at                      timestamptz not null default now(),
    constraint commission_rate_config_version_unique unique (version)
);
create unique index if not exists uq_commission_rate_config_current
    on public.commission_rate_config (is_current) where is_current;

alter table public.commission_rate_config enable row level security;
drop policy if exists crc_read_auth on public.commission_rate_config;
create policy crc_read_auth on public.commission_rate_config
    for select to authenticated using (true);
drop policy if exists crc_write_admin on public.commission_rate_config;
create policy crc_write_admin on public.commission_rate_config
    for all to authenticated using (public.am_i_admin()) with check (public.am_i_admin());

insert into public.commission_rate_config (version, is_current, notes)
values (1, true, 'Initial LYMX comp plan (Kenny 2026-05-30).')
on conflict (version) do nothing;

-- ---------- 2. partner_commissions ledger columns ---------------------------
-- Two payout currencies (cash vs LYMX) + per-period idempotency + audit links.
alter table public.partner_commissions
    add column if not exists payout_kind          text,                 -- 'cash' | 'lymx'
    add column if not exists source_kind          text,                 -- 'activation'|'speed_bonus'|'transaction_fee'|'monthly_fee'
    add column if not exists period_month         date,                 -- recurring period (null for one-time)
    add column if not exists source_transaction_id uuid,
    add column if not exists source_subscription_id uuid;

-- backfill payout_kind default for any legacy rows (none expected) so checks hold
update public.partner_commissions set payout_kind = 'cash' where payout_kind is null;

-- Lookup index for the engine's idempotency (delete-unsettled-then-insert in mig 139)
-- and for dashboard queries. NOT unique: settled rows are immutable, and re-running
-- a period replaces only unsettled rows, so a strict unique key would conflict with
-- a row already settled under the same (partner, stream, gen, business, period).
create index if not exists idx_partner_commissions_dedupe
    on public.partner_commissions (
        source_kind, period_month, source_business_id, partner_id, generation
    )
    where source_kind is not null;

do $s$ begin raise notice 'Migration 138 OK - commission_rate_config v1 + partner_commissions ledger cols ready.'; end$s$;
-- END migration 138
