-- =============================================================================
-- LYMX Power — Initial Schema (Phase 1)
-- Created: 2026-05-01
-- Purpose: Core tables for Business sign-up, Customer wallet, Issuance
-- =============================================================================
--
-- DESIGN NOTES (read me first — Kenny, this is for you):
-- ----------------------------------------------------------------------------
-- 1. UUIDs everywhere. Supabase auth.users uses UUID — keeping ours consistent
--    means we can reference auth.users(id) cleanly for partners/customers.
-- 2. Every table gets `created_at` + `updated_at`. We auto-update `updated_at`
--    via a trigger at the bottom of this file.
-- 3. RLS is ON for every table. We'll add specific policies in 002+.
-- 4. We use NUMERIC for LYMX amounts (not FLOAT) — money math must be exact.
--    LYMX is integer-valued in practice (you can't issue half a LYMX), but
--    NUMERIC keeps the door open if rates change later.
-- 5. References use ON DELETE RESTRICT by default — we never want a deleted
--    business to silently delete its transactions. Soft-delete via `archived_at`
--    instead.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- EXTENSIONS
-- -----------------------------------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";


-- -----------------------------------------------------------------------------
-- 1. ORGANIZATIONS  (chain owners — parent of multiple business_locations)
-- -----------------------------------------------------------------------------
-- Most local businesses won't have an organization (single-location).
-- Chains/franchises (e.g. a 4-store dim sum chain) get one organization
-- with multiple business_locations under it.
create table public.organizations (
    id              uuid primary key default uuid_generate_v4(),
    name            text not null,
    owner_user_id   uuid references auth.users(id) on delete restrict,
    contact_email   text,
    contact_phone   text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    archived_at     timestamptz
);

comment on table public.organizations is
    'Chain/franchise parent. Single-location businesses do not need this row.';


-- -----------------------------------------------------------------------------
-- 2. BUSINESSES  (the merchant entity — billing + subscription live here)
-- -----------------------------------------------------------------------------
create table public.businesses (
    id                  uuid primary key default uuid_generate_v4(),
    organization_id     uuid references public.organizations(id) on delete restrict,
    legal_name          text not null,
    display_name        text not null,
    category            text,                          -- "restaurant", "salon", "retail", etc.
    contact_email       text not null,
    contact_phone       text,
    owner_user_id       uuid references auth.users(id) on delete restrict,

    -- LYMX economics knobs (defaults from the model — can override per business)
    issuance_rate       numeric not null default 5,    -- LYMX issued per $1 spent
    redemption_rate     numeric not null default 5,    -- LYMX required per $0.01 value
    redemption_cap_pct  numeric not null default 0.80, -- 80% rule

    -- Sign-up attribution
    signed_up_by_partner_id uuid,                      -- FK added below (forward ref)
    signup_paid_amount  numeric default 0,             -- $850 sign-up fee actually paid
    signup_paid_at      timestamptz,

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    archived_at         timestamptz
);

comment on table public.businesses is
    'A merchant. One row per business, even if they have multiple locations.';
comment on column public.businesses.redemption_cap_pct is
    'The 80% rule: max share of a transaction that can be paid with LYMX.';


-- -----------------------------------------------------------------------------
-- 3. BUSINESS_LOCATIONS  (physical storefronts — one or many per business)
-- -----------------------------------------------------------------------------
create table public.business_locations (
    id              uuid primary key default uuid_generate_v4(),
    business_id     uuid not null references public.businesses(id) on delete restrict,
    name            text not null,                     -- "Downtown", "Spring Mountain"
    street          text,
    city            text,
    state           text,
    zip             text,
    latitude        numeric,
    longitude       numeric,
    phone           text,
    is_primary      boolean not null default false,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    archived_at     timestamptz
);

create index idx_locations_business on public.business_locations(business_id);
create index idx_locations_geo on public.business_locations(latitude, longitude);

comment on table public.business_locations is
    'Each physical storefront. A business has at least one. Chains have many.';


-- -----------------------------------------------------------------------------
-- 4. PARTNERS  (the sales/network role — has a tree position)
-- -----------------------------------------------------------------------------
create table public.partners (
    id                  uuid primary key default uuid_generate_v4(),
    user_id             uuid not null unique references auth.users(id) on delete restrict,
    legal_name          text not null,
    display_name        text,
    contact_email       text not null,
    contact_phone       text,

    -- Status flags
    is_founding_25      boolean not null default false, -- permanent grandfather perks
    founding_25_rank    integer,                        -- 1..25 if founding
    qualifying_credits  integer not null default 0,     -- yearly cooperative-training credits

    -- Sign-up fee state ($25 + $12.95/mo, waived until 7/31/2027)
    signup_fee_paid     boolean not null default false,
    signup_fee_waived   boolean not null default true,  -- TRUE during launch window
    monthly_fee_status  text not null default 'waived', -- 'waived' | 'active' | 'overdue'

    -- Tree position (filled by mgc_tree row — denormalized cache for speed)
    sponsor_partner_id  uuid references public.partners(id),

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    archived_at         timestamptz
);

create index idx_partners_user on public.partners(user_id);
create index idx_partners_sponsor on public.partners(sponsor_partner_id);

-- Now wire businesses.signed_up_by_partner_id forward ref
alter table public.businesses
    add constraint fk_business_partner
    foreign key (signed_up_by_partner_id) references public.partners(id) on delete restrict;

comment on column public.partners.is_founding_25 is
    'TRUE for the first 25 partners who hit 5 Direct activations. Permanent.';


-- -----------------------------------------------------------------------------
-- 5. CUSTOMERS  (consumers — phone-OTP authenticated)
-- -----------------------------------------------------------------------------
create table public.customers (
    id              uuid primary key default uuid_generate_v4(),
    user_id         uuid not null unique references auth.users(id) on delete restrict,
    display_name    text,
    phone           text not null unique,
    email           text,
    home_zip        text,                              -- for "your local LYMX" bucket
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    archived_at     timestamptz
);

create index idx_customers_phone on public.customers(phone);


-- -----------------------------------------------------------------------------
-- 6. WALLETS  (one balance per customer per business — the core ledger root)
-- -----------------------------------------------------------------------------
-- A customer earns LYMX at Business A and spends LYMX at Business A. Wallets
-- are per-business. The "send LYMX to a friend" feature transfers between
-- two customers' wallets at the SAME business.
create table public.wallets (
    id              uuid primary key default uuid_generate_v4(),
    customer_id     uuid not null references public.customers(id) on delete restrict,
    business_id     uuid not null references public.businesses(id) on delete restrict,
    balance         numeric not null default 0,        -- in LYMX units
    lifetime_earned numeric not null default 0,
    lifetime_spent  numeric not null default 0,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    unique (customer_id, business_id)                  -- one wallet per pair
);

create index idx_wallets_customer on public.wallets(customer_id);
create index idx_wallets_business on public.wallets(business_id);

comment on column public.wallets.balance is
    'Current LYMX balance. Updated by transactions trigger (later migration).';


-- -----------------------------------------------------------------------------
-- 7. TRANSACTIONS  (immutable ledger of every LYMX movement)
-- -----------------------------------------------------------------------------
create type transaction_type as enum (
    'issuance',     -- customer earned LYMX from a purchase
    'redemption',   -- customer spent LYMX at the business
    'transfer_out', -- customer sent LYMX to a friend (paired with transfer_in)
    'transfer_in',
    'expiration',   -- 90-day wind-down sweep
    'adjustment'    -- manual correction (admin only)
);

create table public.transactions (
    id                  uuid primary key default uuid_generate_v4(),
    type                transaction_type not null,
    wallet_id           uuid not null references public.wallets(id) on delete restrict,
    business_id         uuid not null references public.businesses(id) on delete restrict,
    location_id         uuid references public.business_locations(id),

    -- Amounts
    lymx_amount         numeric not null,              -- always positive — direction is in `type`
    usd_basis           numeric,                       -- the $ amount of the underlying purchase

    -- For transfers: the paired transaction
    paired_transaction_id uuid references public.transactions(id),

    -- Provenance
    pos_external_id     text,                          -- Square/Toast transaction ID
    note                text,
    created_by_user_id  uuid references auth.users(id),
    created_at          timestamptz not null default now()
);

create index idx_tx_wallet on public.transactions(wallet_id, created_at desc);
create index idx_tx_business on public.transactions(business_id, created_at desc);
create index idx_tx_type on public.transactions(type);

comment on table public.transactions is
    'Immutable ledger. Never UPDATE — append corrections as new rows.';


-- -----------------------------------------------------------------------------
-- 8. MGC_TREE  (Partner downline — the multi-generation commission tree)
-- -----------------------------------------------------------------------------
-- One row per Partner-Partner edge. Generation = 1 (Direct), 2 (G1), 3 (G2), 4 (G3).
-- We store the full path so we can sum a partner's whole downline in one query.
create table public.mgc_tree (
    id              uuid primary key default uuid_generate_v4(),
    ancestor_id     uuid not null references public.partners(id) on delete restrict,
    descendant_id   uuid not null references public.partners(id) on delete restrict,
    generation      integer not null check (generation between 1 and 4),
    created_at      timestamptz not null default now(),
    unique (ancestor_id, descendant_id)
);

create index idx_tree_ancestor on public.mgc_tree(ancestor_id);
create index idx_tree_descendant on public.mgc_tree(descendant_id);
create index idx_tree_gen on public.mgc_tree(generation);

comment on table public.mgc_tree is
    'Closure table for partner downline. ancestor=>descendant edge per row. Insert all 4 ancestors when a new partner signs up.';


-- -----------------------------------------------------------------------------
-- 9. BUSINESS_SUBSCRIPTIONS  ($199/mo dashboard subscription state)
-- -----------------------------------------------------------------------------
create table public.business_subscriptions (
    id              uuid primary key default uuid_generate_v4(),
    business_id     uuid not null references public.businesses(id) on delete restrict,
    plan            text not null default 'standard',   -- room for tiers later
    status          text not null default 'trialing',   -- 'trialing' | 'active' | 'past_due' | 'canceled'
    monthly_amount  numeric not null default 199,
    trial_ends_at   timestamptz,                        -- 3 free months
    current_period_start timestamptz,
    current_period_end   timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index idx_subs_business on public.business_subscriptions(business_id);
create index idx_subs_status on public.business_subscriptions(status);


-- -----------------------------------------------------------------------------
-- 10. PARTNER_COMMISSIONS  (what each partner has earned, by source)
-- -----------------------------------------------------------------------------
create table public.partner_commissions (
    id                  uuid primary key default uuid_generate_v4(),
    partner_id          uuid not null references public.partners(id) on delete restrict,
    source_business_id  uuid references public.businesses(id),
    source_partner_id   uuid references public.partners(id),  -- the downline partner whose business triggered this
    type                text not null,                        -- 'signup_bonus' | 'override' | 'qualifier_bonus'
    generation          integer,                              -- 0=own, 1=Direct, 2=G1, 3=G2, 4=G3
    amount              numeric not null,
    settlement_id       uuid,                                 -- FK to settlements (added below)
    created_at          timestamptz not null default now()
);

create index idx_comm_partner on public.partner_commissions(partner_id, created_at desc);
create index idx_comm_settlement on public.partner_commissions(settlement_id);


-- -----------------------------------------------------------------------------
-- 11. SETTLEMENTS  (weekly partner payout batches)
-- -----------------------------------------------------------------------------
create table public.settlements (
    id              uuid primary key default uuid_generate_v4(),
    partner_id      uuid not null references public.partners(id) on delete restrict,
    period_start    date not null,
    period_end      date not null,
    total_amount    numeric not null default 0,
    status          text not null default 'pending',   -- 'pending' | 'paid' | 'held'
    paid_at         timestamptz,
    payment_method  text,                              -- 'ach' | 'paypal' | 'check'
    payment_ref     text,                              -- external txn id
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

alter table public.partner_commissions
    add constraint fk_comm_settlement
    foreign key (settlement_id) references public.settlements(id) on delete set null;

create index idx_settle_partner on public.settlements(partner_id, period_end desc);
create index idx_settle_status on public.settlements(status);


-- =============================================================================
-- AUTO-UPDATE updated_at TRIGGER
-- =============================================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

-- Attach to every table that has updated_at
do $$
declare t text;
begin
    for t in
        select table_name from information_schema.columns
        where table_schema = 'public'
          and column_name = 'updated_at'
    loop
        execute format(
            'create trigger trg_%I_updated before update on public.%I
             for each row execute procedure public.set_updated_at()',
            t, t
        );
    end loop;
end $$;


-- =============================================================================
-- ROW LEVEL SECURITY — turn it on. Policies come in migration 002.
-- =============================================================================
-- Auto-RLS is enabled on the project, so RLS should already be ON for new
-- tables. We make it explicit here as a safety belt.
alter table public.organizations          enable row level security;
alter table public.businesses             enable row level security;
alter table public.business_locations     enable row level security;
alter table public.partners               enable row level security;
alter table public.customers              enable row level security;
alter table public.wallets                enable row level security;
alter table public.transactions           enable row level security;
alter table public.mgc_tree               enable row level security;
alter table public.business_subscriptions enable row level security;
alter table public.partner_commissions    enable row level security;
alter table public.settlements            enable row level security;

-- =============================================================================
-- END OF MIGRATION 001
-- Next: 002_rls_policies.sql — who-can-read-what rules
-- =============================================================================
