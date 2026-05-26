-- =============================================================================
-- Migration 012 — Business partners + signup attribution + LYMX issuances + billing
-- =============================================================================
-- Lets external businesses (like InvestPro Realty) plug into LYMX:
--   1. Register as a business_partner (gets API key + bonus config)
--   2. Send their customers to https://getlymx.com/welcome.html?biz=<slug>
--   3. New signups auto-credit LYMX (LYMX's portion + business's portion)
--   4. Business gets billed for their portion
--
-- Fraud prevention is baked into every issuance:
--   * Hard block: no issuance to a wallet linked to the business's owner/staff
--   * Hard block: no duplicate issuance for the same (business, customer, reason)
--   * Velocity limit: per-business cap on issuances per hour
--   * Pattern flagging: high-value or repeated-to-same-wallet issuances flagged
--     for admin review (don't auto-block — Kenny reviews)
--   * Idempotency: every issuance has a unique key the caller provides
-- =============================================================================

-- =====================================================================
-- 1. business_partners — registered businesses
-- =====================================================================
create table if not exists public.business_partners (
    id              uuid primary key default uuid_generate_v4(),
    slug            text not null unique check (slug ~ '^[a-z0-9-]{2,40}$'),
    legal_name      text not null,
    display_name    text not null,
    contact_email   text not null,

    -- Branding
    logo_url        text,
    primary_color   text default '#0a84ff',

    -- Bonus configuration
    signup_bonus_from_lymx   int not null default 100,   -- LYMX's contribution (CAC)
    signup_bonus_from_biz    int not null default 50,    -- Business's contribution (billed)
    bonus_cents_per_lymx     int not null default 1,     -- Rate at which business is billed ($0.01/LYMX default)

    -- Anti-fraud
    blocked_email_domains    text[],                     -- e.g. business's own staff domain
    owner_user_ids           uuid[],                     -- Hard-block list — these users cannot receive bonuses
    max_signups_per_hour     int not null default 100,   -- Velocity cap
    require_admin_approval   boolean not null default false,

    -- API auth
    api_key                  text not null default encode(gen_random_bytes(32), 'hex'),
    api_key_rotated_at       timestamptz,

    -- Status
    active                   boolean not null default true,
    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now(),

    -- Who admins this business on the LYMX side
    sponsoring_partner_id    uuid                        -- the LYMX Partner who brought them on
);

create index if not exists idx_business_partners_slug   on public.business_partners(slug);
create index if not exists idx_business_partners_active on public.business_partners(active);

-- =====================================================================
-- 2. signup_attributions — who signed up via which business invite
-- =====================================================================
create table if not exists public.signup_attributions (
    id              uuid primary key default uuid_generate_v4(),
    user_id         uuid not null references auth.users(id) on delete cascade,
    business_id     uuid references public.business_partners(id) on delete set null,
    business_slug   text,                                -- captured at signup for audit
    landing_url     text,
    ip_address      inet,
    user_agent      text,
    signup_token    text,                                -- if per-recipient invite tokens were used
    created_at      timestamptz not null default now(),
    unique (user_id)                                     -- one attribution per user
);

create index if not exists idx_signup_attributions_biz  on public.signup_attributions(business_id);
create index if not exists idx_signup_attributions_when on public.signup_attributions(created_at desc);

-- =====================================================================
-- 3. lymx_issuances — every LYMX issued, with verification + audit
-- =====================================================================
create table if not exists public.lymx_issuances (
    id                  uuid primary key default uuid_generate_v4(),

    -- Who
    recipient_user_id   uuid not null references auth.users(id) on delete cascade,
    business_id         uuid references public.business_partners(id) on delete set null,
    issuing_user_id     uuid references auth.users(id) on delete set null,

    -- What
    amount_lymx         int not null check (amount_lymx > 0),
    reason              text not null check (reason in ('signup_bonus','transaction','referral','manual','correction','promo')),

    -- Billing split (in cents)
    lymx_cost_cents     int not null default 0,          -- LYMX's CAC contribution
    business_cost_cents int not null default 0,          -- Business's billed amount

    -- Transaction verification
    transaction_id      text,                            -- external txn ID (Stripe / Buildium / Square)
    transaction_amount_cents int,                        -- $ amount of underlying transaction
    transaction_method  text check (transaction_method in ('webhook','admin','signup','manual') or transaction_method is null),
    verified            boolean not null default false,

    -- Idempotency
    idempotency_key     text,                            -- caller-provided; unique per business

    -- Fraud flags (set by triggers / batch jobs)
    fraud_score         int not null default 0,
    fraud_flags         text[],                          -- e.g. ['self_issuance_blocked','high_value','rapid_repeat']
    admin_status        text not null default 'auto' check (admin_status in ('auto','pending_review','approved','rejected')),
    admin_notes         text,

    -- Metadata
    ip_address          inet,
    user_agent          text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),

    -- Idempotency: same business cannot issue twice for the same key
    unique (business_id, idempotency_key)
);

create index if not exists idx_issuances_recipient on public.lymx_issuances(recipient_user_id, created_at desc);
create index if not exists idx_issuances_business  on public.lymx_issuances(business_id, created_at desc);
create index if not exists idx_issuances_pending   on public.lymx_issuances(admin_status) where admin_status = 'pending_review';
create index if not exists idx_issuances_fraud     on public.lymx_issuances(fraud_score desc) where fraud_score > 0;

-- =====================================================================
-- 4. business_billing — invoice line items per business
-- =====================================================================
create table if not exists public.business_billing (
    id                  uuid primary key default uuid_generate_v4(),
    business_id         uuid not null references public.business_partners(id) on delete cascade,
    issuance_id         uuid references public.lymx_issuances(id) on delete set null,

    line_item           text not null,                   -- e.g. "Signup bonus — alice@example.com"
    amount_cents        int not null,                    -- positive = business owes LYMX

    period_start        date,
    period_end          date,
    invoice_status      text not null default 'unbilled' check (invoice_status in ('unbilled','invoiced','paid','disputed','waived')),
    invoiced_at         timestamptz,
    paid_at             timestamptz,
    invoice_id          text,                            -- external invoice reference

    created_at          timestamptz not null default now()
);

create index if not exists idx_billing_business      on public.business_billing(business_id, created_at desc);
create index if not exists idx_billing_unbilled      on public.business_billing(business_id) where invoice_status = 'unbilled';

-- =====================================================================
-- 5. updated_at trigger (shared across new tables)
-- =====================================================================
create or replace function public.set_b2b_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists business_partners_updated_at on public.business_partners;
create trigger business_partners_updated_at before update on public.business_partners
    for each row execute function public.set_b2b_updated_at();

drop trigger if exists lymx_issuances_updated_at on public.lymx_issuances;
create trigger lymx_issuances_updated_at before update on public.lymx_issuances
    for each row execute function public.set_b2b_updated_at();

-- =====================================================================
-- 6. Fraud-detection trigger — runs BEFORE every issuance insert
-- =====================================================================
create or replace function public.guard_lymx_issuance()
returns trigger language plpgsql as $$
declare
    biz record;
    recent_count int;
    flags text[] := '{}';
    score int := 0;
begin
    -- Look up business config
    if new.business_id is null then
        return new; -- manual issuances by admin bypass guards
    end if;
    select * into biz from public.business_partners where id = new.business_id;
    if not found then
        raise exception 'Unknown business_id %', new.business_id;
    end if;
    if not biz.active then
        raise exception 'Business % is inactive', biz.slug;
    end if;

    -- HARD BLOCK 1: recipient cannot be a business owner
    if biz.owner_user_ids is not null and new.recipient_user_id = any(biz.owner_user_ids) then
        raise exception 'FRAUD BLOCK: Cannot issue LYMX to a business owner (% to %)', biz.slug, new.recipient_user_id;
    end if;

    -- HARD BLOCK 2: recipient email cannot be in business's blocked domain list
    if biz.blocked_email_domains is not null then
        declare
            recipient_email text;
            recipient_domain text;
        begin
            select email into recipient_email from auth.users where id = new.recipient_user_id;
            if recipient_email is not null then
                recipient_domain := lower(split_part(recipient_email, '@', 2));
                if recipient_domain = any(biz.blocked_email_domains) then
                    raise exception 'FRAUD BLOCK: Recipient email domain % is on % blocklist', recipient_domain, biz.slug;
                end if;
            end if;
        end;
    end if;

    -- HARD BLOCK 3: velocity limit — too many issuances from this business this hour
    select count(*) into recent_count
      from public.lymx_issuances
     where business_id = new.business_id
       and created_at > now() - interval '1 hour';
    if recent_count >= biz.max_signups_per_hour then
        raise exception 'FRAUD BLOCK: % exceeded velocity limit (% per hour)', biz.slug, biz.max_signups_per_hour;
    end if;

    -- SOFT FLAG: high-value issuance
    if new.amount_lymx >= 500 then
        flags := array_append(flags, 'high_value');
        score := score + 30;
    end if;

    -- SOFT FLAG: repeat issuance to same wallet
    if exists (
      select 1 from public.lymx_issuances
       where recipient_user_id = new.recipient_user_id
         and business_id = new.business_id
         and reason = new.reason
         and created_at > now() - interval '7 days'
    ) then
        flags := array_append(flags, 'rapid_repeat');
        score := score + 20;
    end if;

    -- SOFT FLAG: off-hours issuance (between midnight and 6 AM Pacific = 7-13 UTC)
    if extract(hour from now() at time zone 'America/Los_Angeles') < 6 then
        flags := array_append(flags, 'off_hours');
        score := score + 10;
    end if;

    -- Auto-route to admin review if score is high enough, OR business requires it
    if biz.require_admin_approval or score >= 40 then
        new.admin_status := 'pending_review';
    end if;

    new.fraud_flags := flags;
    new.fraud_score := score;
    return new;
end;
$$;

drop trigger if exists guard_lymx_issuance on public.lymx_issuances;
create trigger guard_lymx_issuance
    before insert on public.lymx_issuances
    for each row execute function public.guard_lymx_issuance();

-- =====================================================================
-- 7. After-insert: auto-create billing rows for the business's portion
-- =====================================================================
create or replace function public.auto_bill_business_for_issuance()
returns trigger language plpgsql as $$
begin
    if new.business_id is not null and new.business_cost_cents > 0 and new.admin_status in ('auto','approved') then
        insert into public.business_billing (business_id, issuance_id, line_item, amount_cents)
        values (
            new.business_id,
            new.id,
            'LYMX issuance — ' || new.reason || ' to user ' || substring(new.recipient_user_id::text, 1, 8),
            new.business_cost_cents
        );
    end if;
    return new;
end;
$$;

drop trigger if exists auto_bill_business on public.lymx_issuances;
create trigger auto_bill_business
    after insert on public.lymx_issuances
    for each row execute function public.auto_bill_business_for_issuance();

-- =====================================================================
-- 8. RLS
-- =====================================================================
alter table public.business_partners    enable row level security;
alter table public.signup_attributions  enable row level security;
alter table public.lymx_issuances       enable row level security;
alter table public.business_billing     enable row level security;

-- Admin sees all
drop policy if exists b2b_admin_all on public.business_partners;
create policy b2b_admin_all on public.business_partners
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- Authenticated users can read public business_partners info (for the landing page)
drop policy if exists business_partners_public_read on public.business_partners;
create policy business_partners_public_read on public.business_partners
    for select to authenticated, anon
    using (active = true);

-- Issuances: admin all, recipient can see their own
drop policy if exists issuances_admin_all on public.lymx_issuances;
create policy issuances_admin_all on public.lymx_issuances
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

drop policy if exists issuances_recipient_read on public.lymx_issuances;
create policy issuances_recipient_read on public.lymx_issuances
    for select to authenticated
    using (recipient_user_id = auth.uid());

-- Attributions: admin all, user can see their own
drop policy if exists attributions_admin_all on public.signup_attributions;
create policy attributions_admin_all on public.signup_attributions
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

drop policy if exists attributions_self_read on public.signup_attributions;
create policy attributions_self_read on public.signup_attributions
    for select to authenticated
    using (user_id = auth.uid());

-- Billing: admin only
drop policy if exists billing_admin_all on public.business_billing;
create policy billing_admin_all on public.business_billing
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- =====================================================================
-- 9. Helper view — issuance summary per business
-- =====================================================================
create or replace view public.v_business_summary as
select
    bp.id,
    bp.slug,
    bp.display_name,
    bp.active,
    (select count(*) from public.signup_attributions sa where sa.business_id = bp.id) as total_signups,
    (select count(*) from public.lymx_issuances li where li.business_id = bp.id and li.admin_status in ('auto','approved')) as total_issuances,
    coalesce((select sum(amount_lymx) from public.lymx_issuances li where li.business_id = bp.id and li.admin_status in ('auto','approved')), 0) as total_lymx_issued,
    coalesce((select sum(business_cost_cents) from public.lymx_issuances li where li.business_id = bp.id and li.admin_status in ('auto','approved')), 0) as total_owed_cents,
    coalesce((select sum(amount_cents) from public.business_billing bb where bb.business_id = bp.id and bb.invoice_status = 'unbilled'), 0) as unbilled_cents,
    (select count(*) from public.lymx_issuances li where li.business_id = bp.id and li.admin_status = 'pending_review') as pending_review_count
from public.business_partners bp;

grant select on public.v_business_summary to authenticated;

-- =====================================================================
-- 10. Grants
-- =====================================================================
grant select on public.business_partners to anon, authenticated;
grant select, insert, update on public.business_partners   to authenticated;
grant select, insert        on public.signup_attributions  to authenticated;
grant select, insert, update on public.lymx_issuances      to authenticated;
grant select, insert, update on public.business_billing    to authenticated;

-- =============================================================================
-- End of migration 012
-- =============================================================================
