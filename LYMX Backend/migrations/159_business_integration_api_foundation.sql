-- =============================================================================
-- Migration 159 — Business Integration API: foundation schema
-- =============================================================================
-- Anchors the generic LYMX Business Integration API on the canonical
-- `public.businesses` table (NOT the deprecated `business_partners`).
-- Vocabulary follows the 3-role rule: business / partner / customer. There is
-- no "business partner" concept here.
--
-- Implements the data model for the handoff contract
-- (14-Project Modules/reference/LYMX-BUSINESS-API-HANDOFF.md), §3–§11:
--   * per-business api_key + integration config (identity-match mode)
--   * earn-event catalog (event_type -> rate, redeemable, approved)
--   * earn-event log (idempotent on external_ref)
--   * 24h pending claims for earns that hit a person with no wallet (§11)
--   * redeem intents (hosted consent handshake, §5.2 / §9.2)
--   * customer legal_name + one-wallet-per-person key (§9.4, §9.5, §10.A)
--   * admin api-key rotation RPC
--
-- Issuance itself REUSES the canonical pipeline (public.lymx_issuances, the
-- view-backed ledger) — this migration adds NO parallel balance store.
--
-- Idempotent: safe to re-run. Uniquely-named dollar quotes per the
-- multi-block SQL-editor rule.
-- =============================================================================

-- pgcrypto for gen_random_bytes (api keys) — usually already present.
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. businesses: api_key + integration config
-- -----------------------------------------------------------------------------
alter table public.businesses
    add column if not exists api_key                text,
    add column if not exists api_key_rotated_at     timestamptz,
    add column if not exists integration_active     boolean not null default false,
    -- 'required'  : wallet owner must match the presented customer (email/phone) — property mgmt, InvestPro
    -- 'none'      : credit the presented wallet, rely on anti-fraud — retail
    add column if not exists identity_match_mode    text    not null default 'required';

alter table public.businesses
    drop constraint if exists businesses_identity_match_mode_chk;
alter table public.businesses
    add  constraint businesses_identity_match_mode_chk
         check (identity_match_mode in ('required','none'));

-- api_key must be unique when present
create unique index if not exists businesses_api_key_uidx
    on public.businesses (api_key) where api_key is not null;

-- -----------------------------------------------------------------------------
-- 2. customers: legal_name (§9.4) + one-wallet-per-person key (§9.5 / §10.A)
-- -----------------------------------------------------------------------------
-- Every wallet must carry a real legal name to redeem. Uniqueness key that
-- blocks a duplicate wallet (to enforce the negative-balance / anti-dup rule):
-- lower(legal_name) + normalized phone. DOB intentionally optional (rarely
-- collected); phone is the disambiguator. Partial unique index only bites when
-- BOTH legal_name and phone are present, so existing rows are never broken.
alter table public.customers
    add column if not exists legal_name          text,
    add column if not exists legal_name_set_at   timestamptz;

create unique index if not exists customers_legalname_phone_uidx
    on public.customers (lower(legal_name), phone)
    where legal_name is not null and phone is not null and archived_at is null;

-- -----------------------------------------------------------------------------
-- 3. business_event_catalog — the approved earn-event catalog (§3)
-- -----------------------------------------------------------------------------
create table if not exists public.business_event_catalog (
    id                 uuid primary key default gen_random_uuid(),
    business_id        uuid not null references public.businesses(id) on delete cascade,
    event_type         text not null,                 -- e.g. fee_admin, agent_signup, promo_spring
    label              text,                           -- human label for dashboards
    lymx_per_dollar    numeric(12,4) not null default 0,   -- earns this * amount_usd
    flat_lymx          integer       not null default 0,   -- plus this flat amount
    redeemable         boolean       not null default true,
    approved           boolean       not null default false, -- owner approves after Partner intake
    approved_at        timestamptz,
    approved_by        uuid,
    active             boolean       not null default true,
    created_at         timestamptz   not null default now(),
    updated_at         timestamptz   not null default now(),
    constraint business_event_catalog_uq unique (business_id, event_type),
    constraint business_event_catalog_amt_chk
        check (lymx_per_dollar >= 0 and flat_lymx >= 0)
);
create index if not exists business_event_catalog_biz_idx
    on public.business_event_catalog (business_id) where active;

-- -----------------------------------------------------------------------------
-- 4. business_events — idempotent earn log (§5.1)
-- -----------------------------------------------------------------------------
-- One row per inbound earn event. Idempotency is enforced on (business_id,
-- external_ref): a retry returns the original outcome, never double-issues.
create table if not exists public.business_events (
    id                  uuid primary key default gen_random_uuid(),
    business_id         uuid not null references public.businesses(id) on delete cascade,
    event_type          text not null,
    external_ref        text not null,                 -- the business's unique id for this event
    recipient_user_id   uuid,                          -- resolved wallet owner (auth.users.id), null if no_wallet
    customer_email      text,
    customer_phone      text,
    customer_external_id text,
    amount_usd_cents    integer,
    lymx_issued         integer not null default 0,
    status              text not null,                 -- issued | no_wallet | rejected | reversed | hold
    error_code          text,                          -- identity_mismatch | event_type_not_configured | wallet_missing_legal_name | ...
    issuance_id         uuid references public.lymx_issuances(id),
    claim_id            uuid,                          -- -> lymx_pending_claims.id when no_wallet
    occurred_at         timestamptz,
    created_at          timestamptz not null default now(),
    constraint business_events_idem_uq unique (business_id, external_ref),
    constraint business_events_status_chk
        check (status in ('issued','no_wallet','rejected','reversed','hold'))
);
create index if not exists business_events_biz_idx on public.business_events (business_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 5. lymx_pending_claims — 24h hold for earns to a person with no wallet (§11)
-- -----------------------------------------------------------------------------
-- No wallet at event time => NOTHING is issued; a provisional claim is held for
-- 24h and a claim/invite link is returned. If the person makes a wallet within
-- 24h the LYMX is credited; after 24h it is forfeited (business billed only if
-- claimed).
create table if not exists public.lymx_pending_claims (
    id                  uuid primary key default gen_random_uuid(),
    business_id         uuid not null references public.businesses(id) on delete cascade,
    event_type          text not null,
    customer_email      text,
    customer_phone      text,
    lymx_amount         integer not null,
    amount_usd_cents    integer,
    external_ref        text not null,
    invite_token        text not null default encode(gen_random_bytes(18),'hex'),
    status              text not null default 'pending',   -- pending | claimed | forfeited
    expires_at          timestamptz not null default (now() + interval '24 hours'),
    claimed_at          timestamptz,
    claimed_user_id     uuid,
    issuance_id         uuid references public.lymx_issuances(id),
    created_at          timestamptz not null default now(),
    constraint lymx_pending_claims_idem_uq unique (business_id, external_ref),
    constraint lymx_pending_claims_status_chk
        check (status in ('pending','claimed','forfeited'))
);
create index if not exists lymx_pending_claims_token_idx on public.lymx_pending_claims (invite_token);
create index if not exists lymx_pending_claims_open_idx
    on public.lymx_pending_claims (customer_email, customer_phone) where status = 'pending';

-- -----------------------------------------------------------------------------
-- 6. business_redeem_intents — hosted consent handshake (§5.2 / §9.2)
-- -----------------------------------------------------------------------------
-- A business CANNOT unilaterally spend a customer's LYMX. It opens an intent;
-- the customer approves on a LYMX-hosted page (password-verify); LYMX deducts
-- and returns the discount. Non-redeemable event types are rejected.
create table if not exists public.business_redeem_intents (
    id                  uuid primary key default gen_random_uuid(),
    business_id         uuid not null references public.businesses(id) on delete cascade,
    event_type          text not null,
    external_ref        text not null,
    recipient_user_id   uuid,
    customer_email      text,
    customer_phone      text,
    max_lymx            integer not null,
    approve_token       text not null default encode(gen_random_bytes(18),'hex'),
    status              text not null default 'pending',   -- pending | approved | denied | expired
    approved_lymx       integer,
    discount_usd_cents  integer,
    issuance_id         uuid references public.lymx_issuances(id),  -- the negative/redemption ledger row
    expires_at          timestamptz not null default (now() + interval '30 minutes'),
    approved_at         timestamptz,
    created_at          timestamptz not null default now(),
    constraint business_redeem_intents_idem_uq unique (business_id, external_ref),
    constraint business_redeem_intents_status_chk
        check (status in ('pending','approved','denied','expired')),
    constraint business_redeem_intents_max_chk check (max_lymx > 0)
);
create index if not exists business_redeem_intents_token_idx on public.business_redeem_intents (approve_token);

-- -----------------------------------------------------------------------------
-- 7. fraud-hold + settlement freeze on the issuance ledger (§9.6 / §11)
-- -----------------------------------------------------------------------------
-- Suspicious issuances must NOT settle until cleared by in-person admin
-- verification. Reuse lymx_issuances.admin_status; add an explicit freeze flag
-- the settlement run honors.
alter table public.lymx_issuances
    add column if not exists settlement_frozen   boolean not null default false,
    add column if not exists frozen_reason        text,
    add column if not exists frozen_at            timestamptz,
    add column if not exists cleared_at           timestamptz,
    add column if not exists cleared_by           uuid;
create index if not exists lymx_issuances_frozen_idx
    on public.lymx_issuances (business_id) where settlement_frozen;

-- =============================================================================
-- 8. Admin RPC — (re)generate a business api_key
-- =============================================================================
create or replace function public.regenerate_business_api_key(p_business_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $regen_api_key$
declare
    v_key text;
begin
    if not public.am_i_admin() then
        raise exception 'Only an admin can rotate a business api key.';
    end if;
    v_key := 'lymx_live_' || encode(gen_random_bytes(24), 'hex');
    update public.businesses
       set api_key = v_key,
           api_key_rotated_at = now(),
           integration_active = true
     where id = p_business_id;
    if not found then
        raise exception 'Business % not found', p_business_id;
    end if;
    return v_key;
end;
$regen_api_key$;

-- =============================================================================
-- 9. RLS + GRANTs
-- =============================================================================
-- EFs run as service_role (bypasses RLS). Policies below are for dashboard
-- reads by the owning business + admins. anon gets nothing.
alter table public.business_event_catalog   enable row level security;
alter table public.business_events           enable row level security;
alter table public.lymx_pending_claims       enable row level security;
alter table public.business_redeem_intents   enable row level security;

-- catalog: owner of the business can read/manage their own; admins all.
drop policy if exists bec_owner_rw on public.business_event_catalog;
create policy bec_owner_rw on public.business_event_catalog
    for all to authenticated
    using (
        public.am_i_admin()
        or business_id in (select id from public.businesses where owner_user_id = auth.uid())
    )
    with check (
        public.am_i_admin()
        or business_id in (select id from public.businesses where owner_user_id = auth.uid())
    );

-- events / claims / intents: owner read-only via dashboard; admins all.
drop policy if exists be_owner_r on public.business_events;
create policy be_owner_r on public.business_events
    for select to authenticated
    using (
        public.am_i_admin()
        or business_id in (select id from public.businesses where owner_user_id = auth.uid())
    );

drop policy if exists bpc_owner_r on public.lymx_pending_claims;
create policy bpc_owner_r on public.lymx_pending_claims
    for select to authenticated
    using (
        public.am_i_admin()
        or business_id in (select id from public.businesses where owner_user_id = auth.uid())
    );

drop policy if exists bri_owner_r on public.business_redeem_intents;
create policy bri_owner_r on public.business_redeem_intents
    for select to authenticated
    using (
        public.am_i_admin()
        or business_id in (select id from public.businesses where owner_user_id = auth.uid())
    );

grant select on public.business_event_catalog, public.business_events,
                public.lymx_pending_claims, public.business_redeem_intents
    to authenticated;
grant insert, update, delete on public.business_event_catalog to authenticated;  -- gated by policy
grant execute on function public.regenerate_business_api_key(uuid) to authenticated;

-- =============================================================================
-- DONE. Next: business-event EF (earn), then redeem-intent + hosted approve.
-- =============================================================================
