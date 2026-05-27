-- =============================================================================
-- Migration 105 — business_settlements (Sprint 1)
-- =============================================================================
-- Implements the clearing-house settlement model documented in master-faq.html:
--
--   "You buy LYMX units from us at $0.008 per LYMX (80% of face value) to issue
--    to customers. When customers redeem at any participating Business, that
--    Business sells the redeemed units back to us at the same $0.008."
--
--   "Net of unit purchases vs. buy-backs is settled via ACH on the 5th business
--    day of each month."
--
-- LYMX Power is the central clearing house. Per business per calendar month:
--
--   usd_owed_by_biz  = SUM(business_cost_cents on issuance rows in period)
--                      from lymx_issuances WHERE business_id = B
--                      AND reason <> 'redemption'
--                      AND admin_status IN ('auto','approved')
--
--   usd_owed_to_biz  = SUM(-amount_lymx on redemption rows in period)
--                      × $0.008 (from app_config.buyback_rate_cents_per_lymx)
--                      from lymx_issuances WHERE business_id = B
--                      AND reason = 'redemption'
--                      AND admin_status IN ('auto','approved')
--
--   net_cents        = usd_owed_to_biz_cents − usd_owed_by_biz_cents
--                      positive → LYMX Power pays B via Stripe Connect transfer
--                      negative → LYMX Power charges B via Stripe Subscription/Invoice
--
-- No cross-business attribution needed — every issuance pre-pays the unit cost
-- to LYMX Power, every redemption is bought back from LYMX Power at the same
-- rate, the 20% gap is the redeeming business's effective discount expense.
--
-- Idempotent on (business_id, period_end) — re-running for the same period
-- short-circuits if a row already exists.
--
-- Pairs with:
--   - migration 106 (feature_catalog rows for business_view_settlements +
--     admin_run_settlements)
--   - EF business-settlement-run (admin/cron-triggered)
--   - biz-payouts.html "Settlement History" card
--   - admin-settlements.html admin queue
--
-- Named dollar-quotes per feedback_supabase_named_dollar_quotes.
-- =============================================================================

set local statement_timeout = 0;

begin;

-- =====================================================================
-- 1. app_config — single-row table for tunable platform constants
-- =====================================================================
-- Per ARCHITECTURE-RULES Rule 1 + feedback_lymx_operator_configurable:
-- "Every value operators might change must be DB-config-driven."
-- This is also where the `if (false)` band-aid on biz-payouts.html gets
-- replaced by a real flag read (stripe_connect_enabled).
--
-- Single-row pattern: a hard-coded id ('singleton') keeps the table at
-- exactly one row. UPDATE-only after the bootstrap INSERT.
create table if not exists public.app_config (
    id                                 text primary key default 'singleton'
                                         check (id = 'singleton'),
    -- Settlement
    buyback_rate_cents_per_lymx        numeric(10,4) not null default 0.8,
    settlement_cadence                 text not null default 'monthly'
                                         check (settlement_cadence in ('monthly','weekly')),
    settlement_dom_business_day        int not null default 5
                                         check (settlement_dom_business_day between 1 and 10),
    -- Stripe Connect rollout gate
    stripe_connect_enabled             boolean not null default false,
    -- Bookkeeping
    updated_at                         timestamptz not null default now(),
    updated_by                         uuid references auth.users(id)
);

-- Bootstrap the singleton row if it doesn't exist
insert into public.app_config (id) values ('singleton')
    on conflict (id) do nothing;

alter table public.app_config enable row level security;

drop policy if exists app_config_read_all on public.app_config;
create policy app_config_read_all on public.app_config
    for select to authenticated, anon
    using (true);

drop policy if exists app_config_write_admin on public.app_config;
create policy app_config_write_admin on public.app_config
    for update to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

grant select on public.app_config to authenticated, anon;
grant update on public.app_config to authenticated;

comment on table public.app_config is
  'Single-row tunable platform constants. Read freely; only admins can update via RLS. See feedback_lymx_operator_configurable: never hardcode operator-changeable values.';

-- =====================================================================
-- 2. business_settlements — monthly ledger of per-business net positions
-- =====================================================================
create table if not exists public.business_settlements (
    id                  uuid primary key default uuid_generate_v4(),
    business_id         uuid not null references public.businesses(id) on delete restrict,

    -- Period (calendar month — inclusive start, exclusive end)
    period_start        date not null,
    period_end          date not null,
    check (period_end > period_start),

    -- Math — denormalized for QuickBooks export
    lymx_issued         int  not null default 0,    -- positive total issuance amount_lymx in period
    lymx_redeemed       int  not null default 0,    -- positive total of -amount_lymx for redemption rows in period
    usd_owed_by_cents   int  not null default 0,    -- cents the BUSINESS owes LYMX Power (from issuances)
    usd_owed_to_cents   int  not null default 0,    -- cents LYMX Power owes the BUSINESS (from redemptions)
    net_cents           int  not null default 0,    -- usd_owed_to_cents − usd_owed_by_cents
                                                    --   positive → LYMX Power pays the business
                                                    --   negative → LYMX Power charges the business

    -- Stripe rails (one or the other, not both)
    stripe_transfer_id  text,                       -- transfer.id when net > 0 (Connect payout)
    stripe_invoice_id   text,                       -- invoice.id when net < 0 (Subscription charge)

    -- Lifecycle
    status              text not null default 'pending'
                          check (status in ('pending','approved','paid','failed','skipped_zero','skipped_stripe_disabled')),
    status_message      text,                       -- failure reason, skip reason, etc.

    -- Audit
    computed_at         timestamptz not null default now(),
    approved_at         timestamptz,
    approved_by         uuid references auth.users(id),
    paid_at             timestamptz,

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

-- Idempotency — at most one settlement row per (business, period)
create unique index if not exists uniq_business_settlements_biz_period
    on public.business_settlements(business_id, period_end);

create index if not exists idx_business_settlements_status
    on public.business_settlements(status, period_end desc);

create index if not exists idx_business_settlements_biz
    on public.business_settlements(business_id, period_end desc);

alter table public.business_settlements enable row level security;

-- Business owner reads their own settlements
drop policy if exists bs_read_self on public.business_settlements;
create policy bs_read_self on public.business_settlements
    for select to authenticated
    using (
        exists (
            select 1 from public.businesses b
             where b.id = business_settlements.business_id
               and b.owner_user_id = auth.uid()
        )
    );

-- Admin reads + writes everything
drop policy if exists bs_admin_all on public.business_settlements;
create policy bs_admin_all on public.business_settlements
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

grant select on public.business_settlements to authenticated;

-- updated_at trigger
do $bs_updated_at$
begin
    if not exists (
        select 1 from pg_trigger
         where tgname = 'trg_bs_updated_at'
           and tgrelid = 'public.business_settlements'::regclass
    ) then
        create trigger trg_bs_updated_at before update on public.business_settlements
            for each row execute function public.tg_set_updated_at();
    end if;
end
$bs_updated_at$;

comment on table public.business_settlements is
  'Monthly clearing-house settlement ledger. One row per (business, period_end). Computed by fn_compute_business_settlement; transitioned to paid by business-settlement-run EF + Stripe webhook. See migration 105 header for the math.';

-- =====================================================================
-- 3. fn_compute_business_settlement — write a settlement row for a period
-- =====================================================================
-- Idempotent: if a row already exists for (business_id, period_end) it is
-- returned unchanged. Caller (admin or business-settlement-run EF) handles
-- the Stripe leg separately.
create or replace function public.fn_compute_business_settlement(
    p_business_id uuid,
    p_period_start date,
    p_period_end date
) returns public.business_settlements
language plpgsql
security definer
set search_path = public, pg_temp
as $fn_compute_bs$
declare
    v_existing public.business_settlements;
    v_rate     numeric;
    v_issued   int;
    v_redeemed int;
    v_owed_by  int;
    v_owed_to  int;
    v_net      int;
    v_status   text;
    v_msg      text;
    v_row      public.business_settlements;
begin
    if p_business_id is null or p_period_start is null or p_period_end is null then
        raise exception 'fn_compute_business_settlement: all three params required';
    end if;
    if p_period_end <= p_period_start then
        raise exception 'fn_compute_business_settlement: period_end must be after period_start';
    end if;

    -- Idempotency short-circuit
    select * into v_existing
      from public.business_settlements
     where business_id = p_business_id
       and period_end = p_period_end
     limit 1;
    if found then
        return v_existing;
    end if;

    -- Pull the current buy-back rate from app_config (operator-configurable)
    select buyback_rate_cents_per_lymx into v_rate
      from public.app_config where id = 'singleton';
    if v_rate is null then
        v_rate := 0.8;  -- safe default if app_config is somehow missing
    end if;

    -- Sum the period activity
    -- Issued: positive amount_lymx, reason <> 'redemption', auto/approved only
    -- Redeemed: negative amount_lymx, reason = 'redemption', auto/approved only
    select
        coalesce(sum(amount_lymx)      filter (where reason <> 'redemption'), 0)::int,
        coalesce(-sum(amount_lymx)     filter (where reason  = 'redemption'), 0)::int,
        coalesce(sum(business_cost_cents) filter (where reason <> 'redemption'), 0)::int
    into v_issued, v_redeemed, v_owed_by
      from public.lymx_issuances
     where business_id = p_business_id
       and admin_status in ('auto','approved')
       and created_at >= p_period_start::timestamptz
       and created_at <  p_period_end::timestamptz;

    -- Buy-back cents = redeemed_amount × rate (rate is cents per LYMX)
    v_owed_to := round(v_redeemed * v_rate)::int;
    v_net     := v_owed_to - v_owed_by;

    -- Zero-activity periods: insert a 'skipped_zero' row so the inbox shows
    -- "ran but nothing to pay" instead of an empty gap.
    if v_issued = 0 and v_redeemed = 0 then
        v_status := 'skipped_zero';
        v_msg    := 'No issuance or redemption activity in this period.';
    else
        v_status := 'pending';
        v_msg    := null;
    end if;

    insert into public.business_settlements (
        business_id, period_start, period_end,
        lymx_issued, lymx_redeemed,
        usd_owed_by_cents, usd_owed_to_cents, net_cents,
        status, status_message
    ) values (
        p_business_id, p_period_start, p_period_end,
        v_issued, v_redeemed,
        v_owed_by, v_owed_to, v_net,
        v_status, v_msg
    )
    returning * into v_row;

    return v_row;
end
$fn_compute_bs$;

revoke all on function public.fn_compute_business_settlement(uuid,date,date) from public;
grant execute on function public.fn_compute_business_settlement(uuid,date,date) to authenticated;

comment on function public.fn_compute_business_settlement(uuid,date,date) is
  'Compute + insert a business_settlements row for the given business and period. Idempotent on (business_id, period_end). Reads buyback_rate_cents_per_lymx from app_config. Pending settlements are transitioned to paid by business-settlement-run EF + Stripe webhook.';

-- =====================================================================
-- 4. fn_business_unsettled_balance — running cents owed for biz-payouts.html
-- =====================================================================
-- Returns the projected NET cents for the business based on all auto/approved
-- lymx_issuances rows since the LAST settled period_end (or all-time if no
-- settlement has run yet). Used by the "Current owed" card on biz-payouts.html
-- so the business can see what's accruing before the next settlement run.
create or replace function public.fn_business_unsettled_balance(
    p_business_id uuid
) returns table (
    since_period_end   date,
    lymx_issued        int,
    lymx_redeemed      int,
    usd_owed_by_cents  int,
    usd_owed_to_cents  int,
    net_cents          int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn_unsettled$
declare
    v_since date;
    v_rate  numeric;
begin
    if p_business_id is null then
        raise exception 'fn_business_unsettled_balance: business_id required';
    end if;

    -- Authorization: must own the business OR be admin
    if not public.am_i_admin() then
        if not exists (
            select 1 from public.businesses b
             where b.id = p_business_id and b.owner_user_id = auth.uid()
        ) then
            raise exception 'fn_business_unsettled_balance: not authorized for business %', p_business_id;
        end if;
    end if;

    select buyback_rate_cents_per_lymx into v_rate
      from public.app_config where id = 'singleton';
    if v_rate is null then v_rate := 0.8; end if;

    select max(period_end) into v_since
      from public.business_settlements
     where business_id = p_business_id
       and status in ('approved','paid');
    -- v_since may be null; in that case we sum all-time issuances

    return query
    with agg as (
        select
            coalesce(sum(amount_lymx)         filter (where reason <> 'redemption'), 0)::int as li_issued,
            coalesce(-sum(amount_lymx)        filter (where reason  = 'redemption'), 0)::int as li_redeemed,
            coalesce(sum(business_cost_cents) filter (where reason <> 'redemption'), 0)::int as li_owed_by
          from public.lymx_issuances
         where business_id = p_business_id
           and admin_status in ('auto','approved')
           and (v_since is null or created_at >= (v_since::timestamptz))
    )
    select
        v_since,
        li_issued,
        li_redeemed,
        li_owed_by,
        round(li_redeemed * v_rate)::int as owed_to,
        round(li_redeemed * v_rate)::int - li_owed_by as net
      from agg;
end
$fn_unsettled$;

revoke all on function public.fn_business_unsettled_balance(uuid) from public;
grant execute on function public.fn_business_unsettled_balance(uuid) to authenticated;

comment on function public.fn_business_unsettled_balance(uuid) is
  'Running unsettled net cents for a business, since its last settled period_end (or all-time if none). Used by biz-payouts.html "Current owed" card. Authorization: business owner OR admin.';

-- =====================================================================
-- 5. Sanity check
-- =====================================================================
do $sanity_105$
declare
    v_app_config_row int;
    v_rate          numeric;
    v_table_ok      boolean;
    v_compute_ok    boolean;
    v_unsettled_ok  boolean;
begin
    select count(*) into v_app_config_row from public.app_config;
    select buyback_rate_cents_per_lymx into v_rate from public.app_config where id = 'singleton';
    select exists (select 1 from information_schema.tables
                    where table_schema = 'public' and table_name = 'business_settlements')
      into v_table_ok;
    select exists (select 1 from pg_proc
                    where proname = 'fn_compute_business_settlement' and pronamespace = 'public'::regnamespace)
      into v_compute_ok;
    select exists (select 1 from pg_proc
                    where proname = 'fn_business_unsettled_balance' and pronamespace = 'public'::regnamespace)
      into v_unsettled_ok;

    raise notice 'mig 105: app_config_singleton=% rate=% table=% compute_fn=% unsettled_fn=%',
        v_app_config_row, v_rate, v_table_ok, v_compute_ok, v_unsettled_ok;

    if v_app_config_row <> 1 or v_rate is null or not v_table_ok
       or not v_compute_ok or not v_unsettled_ok then
        raise exception 'Migration 105 sanity failed';
    end if;
end
$sanity_105$;

commit;

-- =============================================================================
-- End of migration 105
-- =============================================================================
