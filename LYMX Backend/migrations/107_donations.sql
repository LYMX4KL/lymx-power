-- =============================================================================
-- Migration 107 — Donations (Sprint 2)
-- =============================================================================
-- Implements the customer-side Donate LYMX flow.
--
-- Model:
--   - Customer donates X LYMX to a verified nonprofit.
--   - LYMX wallet decreases by X (NEGATIVE lymx_issuances row, reason='donation').
--   - donations table records the gift, the recipient nonprofit, and the USD
--     value at the clearing-house buy-back rate ($0.008 per LYMX → 100 LYMX = $0.80).
--     Consistent with how LYMX Power buys back redeemed LYMX from businesses
--     (the 20% gap funds platform operations). The donation USD is paid out
--     to the nonprofit's Stripe Connect account in a Sprint 3 monthly batch —
--     until then donations sit `status = pending`.
--
-- Tables:
--   nonprofits            — registry of partner nonprofits (admin-curated)
--   donations             — per-donation ledger (paired with a negative lymx_issuances row)
--
-- RPCs:
--   fn_request_donation(p_nonprofit_id, p_lymx_amount, p_client_request_id)
--                         — atomic donation. Validates balance + nonprofit
--                           status, writes both rows in one transaction.
--   fn_nonprofit_totals(p_nonprofit_id)
--                         — lifetime totals for the public nonprofit profile.
--
-- Constraint changes:
--   lymx_issuances.reason CHECK — adds 'donation'.
--   lymx_issuances.amount_lymx sign CHECK — allows negative for 'donation' (mirror of 'redemption').
--
-- Idempotent. Named dollar-quotes per feedback_supabase_named_dollar_quotes.
-- =============================================================================

set local statement_timeout = 0;

begin;

-- =====================================================================
-- 1. Expand lymx_issuances constraints to admit 'donation'
-- =====================================================================
alter table public.lymx_issuances
    drop constraint if exists lymx_issuances_reason_check;
alter table public.lymx_issuances
    add  constraint lymx_issuances_reason_check
    check (reason in (
        'signup_bonus',
        'transaction',
        'referral',
        'manual',
        'correction',
        'promo',
        'review',
        'redemption',
        'donation'        -- new in Sprint 2: NEGATIVE amount_lymx rows
    ));

alter table public.lymx_issuances
    drop constraint if exists lymx_issuances_amount_lymx_check;
alter table public.lymx_issuances
    add  constraint lymx_issuances_amount_lymx_check
    check (
        (reason in ('redemption','donation') and amount_lymx < 0)
        or (reason not in ('redemption','donation') and amount_lymx > 0)
    );

-- =====================================================================
-- 2. app_config — add the donation payout rate (operator-configurable)
-- =====================================================================
-- Default 0.8 cents per LYMX = $0.008 clearing-house buy-back rate. Kenny's
-- call 2026-05-27: charity gets the same rate as a business buy-back. The
-- 20% gap stays as platform-ops funding (matches the rest of the LYMX
-- economic model). Customer copy should show both the LYMX amount donated
-- and the USD value to the charity so there's no surprise.
alter table public.app_config
    add column if not exists donation_payout_cents_per_lymx numeric(10,4)
        not null default 0.8;

comment on column public.app_config.donation_payout_cents_per_lymx is
  'USD cents the nonprofit ultimately receives per LYMX donated. Default 0.8 = $0.008 (same as the clearing-house buy-back rate per Kenny 2026-05-27). The 20% gap between LYMX face value ($0.01) and donation payout funds platform operations.';

-- =====================================================================
-- 3. nonprofits — registry of partner nonprofits
-- =====================================================================
create table if not exists public.nonprofits (
    id                       uuid primary key default uuid_generate_v4(),
    slug                     text not null unique
                                check (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
    name                     text not null,
    mission_short            text,                              -- 1-2 sentence pitch for the picker
    logo_url                 text,
    ein                      text,                              -- IRS Employer Identification Number (XX-XXXXXXX)
    contact_email            text,

    -- Stripe Connect (charity-side payouts). Stripe Connect is optional at
    -- registry-create time; donations accumulate until the charity onboards.
    stripe_connect_account_id text,

    -- Lifecycle
    status                   text not null default 'pending'
                                check (status in ('pending','verified','disabled')),
    status_message           text,                              -- admin notes on review

    -- Audit
    created_by               uuid references auth.users(id),
    verified_at              timestamptz,
    verified_by              uuid references auth.users(id),
    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now()
);

create unique index if not exists uniq_nonprofits_ein
    on public.nonprofits(ein) where ein is not null;
create index if not exists idx_nonprofits_status
    on public.nonprofits(status, name);

alter table public.nonprofits enable row level security;

-- Verified nonprofits are readable by anyone (anon + authenticated) so the
-- public picker on customer-charity.html and the public profile page work
-- without a session.
drop policy if exists nonprofits_read_verified on public.nonprofits;
create policy nonprofits_read_verified on public.nonprofits
    for select to authenticated, anon
    using (status = 'verified');

-- Admin reads + writes everything
drop policy if exists nonprofits_admin_all on public.nonprofits;
create policy nonprofits_admin_all on public.nonprofits
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

grant select on public.nonprofits to authenticated, anon;

-- updated_at trigger
do $np_updated_at$
begin
    if not exists (
        select 1 from pg_trigger
         where tgname = 'trg_np_updated_at'
           and tgrelid = 'public.nonprofits'::regclass
    ) then
        create trigger trg_np_updated_at before update on public.nonprofits
            for each row execute function public.tg_set_updated_at();
    end if;
end
$np_updated_at$;

comment on table public.nonprofits is
  'Curated registry of partner nonprofits eligible to receive LYMX donations. Only status=verified rows are publicly visible. Admin-managed via admin-nonprofits.html (Sprint 2 Phase B).';

-- =====================================================================
-- 4. donations — per-donation ledger
-- =====================================================================
-- One row per donation event. Paired with a negative lymx_issuances row
-- (reason='donation') so v_my_lymx_balance subtracts naturally.
create table if not exists public.donations (
    id                  uuid primary key default uuid_generate_v4(),
    donor_user_id       uuid not null references auth.users(id) on delete restrict,
    nonprofit_id        uuid not null references public.nonprofits(id) on delete restrict,

    -- Amounts
    lymx_amount         int  not null check (lymx_amount > 0),
    usd_cents           int  not null check (usd_cents > 0),

    -- Linkage to the negative lymx_issuances row (NOT NULL once the issuance
    -- row exists; the RPC inserts both atomically)
    issuance_id         uuid references public.lymx_issuances(id) on delete restrict,

    -- Idempotency — client-provided uuid prevents double-clicks from creating duplicate gifts
    client_request_id   text unique,

    -- Stripe payout (Sprint 3 Phase B). Donations sit pending until the
    -- monthly donations-payout EF (TBD) batches them and pays each charity.
    status              text not null default 'pending'
                          check (status in ('pending','approved','paid','failed','refunded')),
    status_message      text,
    stripe_transfer_id  text,

    -- Receipt
    receipt_token       text not null default substr(replace(gen_random_uuid()::text, '-', ''), 1, 16) unique,

    -- Audit
    created_at          timestamptz not null default now(),
    paid_at             timestamptz,
    updated_at          timestamptz not null default now()
);

create index if not exists idx_donations_donor
    on public.donations(donor_user_id, created_at desc);
create index if not exists idx_donations_nonprofit
    on public.donations(nonprofit_id, created_at desc);
create index if not exists idx_donations_status
    on public.donations(status, created_at desc);

alter table public.donations enable row level security;

-- Donor reads their own donations
drop policy if exists donations_read_self on public.donations;
create policy donations_read_self on public.donations
    for select to authenticated
    using (donor_user_id = auth.uid());

-- Admin reads + writes everything
drop policy if exists donations_admin_all on public.donations;
create policy donations_admin_all on public.donations
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

grant select on public.donations to authenticated;

-- updated_at trigger
do $d_updated_at$
begin
    if not exists (
        select 1 from pg_trigger
         where tgname = 'trg_d_updated_at'
           and tgrelid = 'public.donations'::regclass
    ) then
        create trigger trg_d_updated_at before update on public.donations
            for each row execute function public.tg_set_updated_at();
    end if;
end
$d_updated_at$;

comment on table public.donations is
  'Per-donation ledger. Paired with a negative lymx_issuances row (reason=donation) so wallet balance subtracts naturally. status transitions: pending -> approved -> paid (Sprint 3 Phase B donations-payout EF) or pending -> refunded.';

-- =====================================================================
-- 5. fn_request_donation — atomic donation RPC
-- =====================================================================
create or replace function public.fn_request_donation(
    p_nonprofit_id      uuid,
    p_lymx_amount       int,
    p_client_request_id text default null
) returns public.donations
language plpgsql
security definer
set search_path = public, pg_temp
as $fn_request_donation$
declare
    v_uid          uuid;
    v_nonprofit    public.nonprofits;
    v_balance      int;
    v_existing     public.donations;
    v_issuance_id  uuid;
    v_usd_cents    int;
    v_rate         numeric;
    v_donation     public.donations;
begin
    v_uid := auth.uid();
    if v_uid is null then
        raise exception 'fn_request_donation: must be signed in';
    end if;
    if p_nonprofit_id is null then
        raise exception 'fn_request_donation: nonprofit_id required';
    end if;
    if p_lymx_amount is null or p_lymx_amount <= 0 then
        raise exception 'fn_request_donation: lymx_amount must be positive';
    end if;

    -- Idempotency: if a row already exists with this client_request_id, return it.
    if p_client_request_id is not null then
        select * into v_existing
          from public.donations
         where client_request_id = p_client_request_id
           and donor_user_id = v_uid
         limit 1;
        if found then
            return v_existing;
        end if;
    end if;

    -- Nonprofit must exist + be verified
    select * into v_nonprofit
      from public.nonprofits
     where id = p_nonprofit_id
     limit 1;
    if not found then
        raise exception 'fn_request_donation: nonprofit not found';
    end if;
    if v_nonprofit.status <> 'verified' then
        raise exception 'fn_request_donation: nonprofit % is not accepting donations (status=%)', v_nonprofit.name, v_nonprofit.status;
    end if;

    -- Balance check via v_my_lymx_balance (auth.uid()-filtered)
    select coalesce(available_lymx, 0) into v_balance
      from public.v_my_lymx_balance;
    if v_balance < p_lymx_amount then
        raise exception 'fn_request_donation: insufficient balance (have % LYMX, need %)', v_balance, p_lymx_amount;
    end if;

    -- USD conversion at the operator-configurable donation rate (default 0.8 = $0.008/LYMX)
    select donation_payout_cents_per_lymx into v_rate
      from public.app_config where id = 'singleton';
    if v_rate is null then v_rate := 0.8; end if;
    v_usd_cents := round(p_lymx_amount * v_rate)::int;
    if v_usd_cents <= 0 then
        raise exception 'fn_request_donation: computed usd_cents=0 — donation_payout_cents_per_lymx likely misconfigured';
    end if;

    -- Insert the negative lymx_issuances row first so the FK on donations.issuance_id resolves
    insert into public.lymx_issuances (
        recipient_user_id,
        business_id,
        amount_lymx,
        reason,
        admin_status,
        transaction_method,
        idempotency_key
    ) values (
        v_uid,
        null,                 -- donations have no business_id; they go to LYMX Power's books
        -p_lymx_amount,       -- NEGATIVE per the sign-by-reason constraint
        'donation',
        'auto',
        'app',
        case when p_client_request_id is not null then 'donation:' || p_client_request_id else null end
    )
    returning id into v_issuance_id;

    -- Insert the donation row pointing at the issuance row
    insert into public.donations (
        donor_user_id,
        nonprofit_id,
        lymx_amount,
        usd_cents,
        issuance_id,
        client_request_id,
        status
    ) values (
        v_uid,
        p_nonprofit_id,
        p_lymx_amount,
        v_usd_cents,
        v_issuance_id,
        p_client_request_id,
        'pending'
    )
    returning * into v_donation;

    return v_donation;
end
$fn_request_donation$;

revoke all on function public.fn_request_donation(uuid,int,text) from public;
grant execute on function public.fn_request_donation(uuid,int,text) to authenticated;

comment on function public.fn_request_donation(uuid,int,text) is
  'Atomic donation: validates customer balance + nonprofit verification status, inserts a negative lymx_issuances row + a paired donations row. Idempotent on (donor_user_id, client_request_id). Status starts as pending; Sprint 3 Phase B EF transitions to paid.';

-- =====================================================================
-- 6. fn_nonprofit_totals — lifetime totals for the public profile
-- =====================================================================
create or replace function public.fn_nonprofit_totals(
    p_nonprofit_id uuid
) returns table (
    total_lymx        int,
    total_usd_cents   int,
    donor_count       int,
    last_donation_at  timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $fn_nonprofit_totals$
begin
    return query
    select
        coalesce(sum(lymx_amount), 0)::int        as total_lymx,
        coalesce(sum(usd_cents), 0)::int          as total_usd_cents,
        count(distinct donor_user_id)::int        as donor_count,
        max(created_at)                           as last_donation_at
      from public.donations
     where nonprofit_id = p_nonprofit_id
       and status in ('pending','approved','paid');
end
$fn_nonprofit_totals$;

revoke all on function public.fn_nonprofit_totals(uuid) from public;
grant execute on function public.fn_nonprofit_totals(uuid) to authenticated, anon;

comment on function public.fn_nonprofit_totals(uuid) is
  'Public lifetime totals for a nonprofit profile page. Excludes failed/refunded donations.';

-- =====================================================================
-- 7. Sanity check
-- =====================================================================
do $sanity_107$
declare
    v_np_tab boolean;
    v_d_tab  boolean;
    v_fn_req boolean;
    v_fn_tot boolean;
    v_donation_check_ok boolean;
    v_rate    numeric;
begin
    select exists (select 1 from information_schema.tables
                    where table_schema='public' and table_name='nonprofits') into v_np_tab;
    select exists (select 1 from information_schema.tables
                    where table_schema='public' and table_name='donations') into v_d_tab;
    select exists (select 1 from pg_proc
                    where proname='fn_request_donation' and pronamespace='public'::regnamespace) into v_fn_req;
    select exists (select 1 from pg_proc
                    where proname='fn_nonprofit_totals' and pronamespace='public'::regnamespace) into v_fn_tot;
    select pg_get_constraintdef(oid) like '%donation%' from pg_constraint
     where conname = 'lymx_issuances_reason_check' into v_donation_check_ok;
    select donation_payout_cents_per_lymx into v_rate from public.app_config where id='singleton';

    raise notice 'mig 107: nonprofits=% donations=% fn_request=% fn_totals=% reason_donation_admitted=% donation_rate=%',
        v_np_tab, v_d_tab, v_fn_req, v_fn_tot, v_donation_check_ok, v_rate;

    if not v_np_tab or not v_d_tab or not v_fn_req or not v_fn_tot
       or not v_donation_check_ok or v_rate is null then
        raise exception 'Migration 107 sanity failed';
    end if;
end
$sanity_107$;

commit;

-- =============================================================================
-- End of migration 107
-- =============================================================================
