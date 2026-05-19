-- =============================================================================
-- Migration 017 — Dual emails + referral attribution
-- =============================================================================
-- 1. Adds secondary email columns to partner_emails (so each partner has BOTH
--    @getlymx.com AND @lymxpower.com)
-- 2. Creates referrals table to track who invited whom (so we can credit both
--    inviter and invitee with 100 LYMX on every signup)
-- 3. Updates platform_promos: referral_bonus 50 → 100, adds inviter_bonus = 100
-- =============================================================================

-- =====================================================================
-- 1. Extend partner_emails for dual-domain provisioning
-- =====================================================================
-- Note: existing partner_emails (from migration 005) already has columns for
-- the primary @getlymx.com email. We add a parallel set for @lymxpower.com.
alter table public.partner_emails
    add column if not exists secondary_local_part         text,
    add column if not exists secondary_full_email         text,
    add column if not exists secondary_cloudflare_route_id text,
    add column if not exists secondary_status             text default 'pending'
        check (secondary_status in ('pending','provisioning','active','suspended','failed')),
    add column if not exists secondary_synced_at          timestamptz,
    add column if not exists secondary_last_error         text,
    add column if not exists secondary_provisioned_at     timestamptz;

create index if not exists idx_partner_emails_secondary on public.partner_emails(secondary_full_email);


-- =====================================================================
-- 2. referrals table — inviter ↔ invitee linkage
-- =====================================================================
create table if not exists public.referrals (
    id              uuid primary key default uuid_generate_v4(),

    -- The link
    inviter_user_id     uuid not null references auth.users(id) on delete cascade,
    invitee_user_id     uuid not null references auth.users(id) on delete cascade,

    -- Source of the referral
    invite_method       text check (invite_method in ('link','email','contact_book','direct','partner_link') or invite_method is null),
    invite_template     text check (invite_template in ('partner','customer','business') or invite_template is null),
    landing_url         text,

    -- Bonus tracking
    inviter_bonus_amount  int default 100,
    invitee_bonus_amount  int default 100,
    inviter_issuance_id   uuid references public.lymx_issuances(id) on delete set null,
    invitee_issuance_id   uuid references public.lymx_issuances(id) on delete set null,

    -- Status
    status              text not null default 'credited'
        check (status in ('pending','credited','blocked','reversed')),
    blocked_reason      text,

    -- Metadata
    ip_address          inet,
    user_agent          text,

    created_at          timestamptz not null default now(),

    -- One referral per invitee — once you're attributed to someone, you can't be re-attributed
    unique (invitee_user_id)
);

create index if not exists idx_referrals_inviter   on public.referrals(inviter_user_id, created_at desc);
create index if not exists idx_referrals_invitee   on public.referrals(invitee_user_id);
create index if not exists idx_referrals_status    on public.referrals(status);

-- RLS
alter table public.referrals enable row level security;

-- Admin sees all
drop policy if exists referrals_admin_all on public.referrals;
create policy referrals_admin_all on public.referrals for all to authenticated
    using (public.am_i_admin()) with check (public.am_i_admin());

-- Inviter sees their own referrals (their downline)
drop policy if exists referrals_inviter_read on public.referrals;
create policy referrals_inviter_read on public.referrals for select to authenticated
    using (inviter_user_id = auth.uid());

-- Invitee can see their own attribution (where they came from)
drop policy if exists referrals_invitee_read on public.referrals;
create policy referrals_invitee_read on public.referrals for select to authenticated
    using (invitee_user_id = auth.uid());

grant select, insert, update on public.referrals to authenticated;


-- =====================================================================
-- 3. Helper RPC: credit_referral_pair — issues 100 LYMX to both sides
-- =====================================================================
create or replace function public.credit_referral_pair(
    p_inviter_id        uuid,
    p_invitee_id        uuid,
    p_invite_method     text default 'link',
    p_invite_template   text default null,
    p_landing_url       text default null,
    p_user_agent        text default null,
    p_ip_address        inet default null
) returns json
language plpgsql
security definer
as $$
declare
    inviter_amount int := 100;
    invitee_amount int := 100;
    inviter_issuance uuid;
    invitee_issuance uuid;
    existing_ref uuid;
    inviter_email text;
    invitee_email text;
begin
    -- No self-referral
    if p_inviter_id = p_invitee_id then
        return json_build_object('success', false, 'error', 'Self-referral blocked');
    end if;

    -- Check if invitee was already referred
    select id into existing_ref from public.referrals where invitee_user_id = p_invitee_id;
    if existing_ref is not null then
        return json_build_object('success', false, 'error', 'Already credited', 'referral_id', existing_ref);
    end if;

    -- Get email domains to check for self-referral via same domain
    select email into inviter_email from auth.users where id = p_inviter_id;
    select email into invitee_email from auth.users where id = p_invitee_id;
    if inviter_email is not null and invitee_email is not null
       and lower(split_part(inviter_email, '@', 2)) = lower(split_part(invitee_email, '@', 2))
       and lower(split_part(inviter_email, '@', 2)) not in ('gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com') then
        -- Same custom domain — likely same person/company. Flag for review.
        insert into public.referrals (inviter_user_id, invitee_user_id, invite_method, invite_template,
                                       landing_url, user_agent, ip_address,
                                       inviter_bonus_amount, invitee_bonus_amount,
                                       status, blocked_reason)
        values (p_inviter_id, p_invitee_id, p_invite_method, p_invite_template,
                p_landing_url, p_user_agent, p_ip_address, 0, 0,
                'blocked', 'Same custom email domain — likely self-referral')
        returning id into existing_ref;
        return json_build_object('success', false, 'error', 'Same-domain self-referral blocked', 'referral_id', existing_ref);
    end if;

    -- Look up current amounts from platform_promos (operator-configurable)
    select amount_lymx into inviter_amount from public.platform_promos
     where promo_key = 'inviter_bonus' and active = true limit 1;
    if inviter_amount is null then inviter_amount := 100; end if;

    select amount_lymx into invitee_amount from public.platform_promos
     where promo_key = 'referral_bonus' and active = true limit 1;
    if invitee_amount is null then invitee_amount := 100; end if;

    -- Issue LYMX to invitee
    insert into public.lymx_issuances (
        recipient_user_id, business_id, amount_lymx, reason,
        lymx_cost_cents, business_cost_cents, transaction_method, verified,
        idempotency_key, user_agent
    ) values (
        p_invitee_id, null, invitee_amount, 'referral',
        invitee_amount, 0, 'signup', true,
        'referral_invitee_' || p_invitee_id::text, p_user_agent
    ) returning id into invitee_issuance;

    -- Issue LYMX to inviter
    insert into public.lymx_issuances (
        recipient_user_id, business_id, amount_lymx, reason,
        lymx_cost_cents, business_cost_cents, transaction_method, verified,
        idempotency_key, user_agent
    ) values (
        p_inviter_id, null, inviter_amount, 'referral',
        inviter_amount, 0, 'signup', true,
        'referral_inviter_' || p_invitee_id::text, p_user_agent
    ) returning id into inviter_issuance;

    -- Record the referral
    insert into public.referrals (
        inviter_user_id, invitee_user_id, invite_method, invite_template,
        landing_url, user_agent, ip_address,
        inviter_bonus_amount, invitee_bonus_amount,
        inviter_issuance_id, invitee_issuance_id,
        status
    ) values (
        p_inviter_id, p_invitee_id, p_invite_method, p_invite_template,
        p_landing_url, p_user_agent, p_ip_address,
        inviter_amount, invitee_amount,
        inviter_issuance, invitee_issuance,
        'credited'
    ) returning id into existing_ref;

    return json_build_object(
        'success', true,
        'referral_id', existing_ref,
        'inviter_amount', inviter_amount,
        'invitee_amount', invitee_amount,
        'inviter_issuance_id', inviter_issuance,
        'invitee_issuance_id', invitee_issuance
    );
end;
$$;

grant execute on function public.credit_referral_pair(uuid, uuid, text, text, text, text, inet) to authenticated, service_role, anon;


-- =====================================================================
-- 4. Update platform_promos: referral_bonus 50 → 100, add inviter_bonus
-- =====================================================================
update public.platform_promos
   set amount_lymx = 100,
       description = 'LYMX awarded to NEW USER (invitee) when they sign up via an invite link'
 where promo_key = 'referral_bonus';

insert into public.platform_promos (promo_key, description, amount_lymx, active)
values ('inviter_bonus',
        'LYMX awarded to INVITER when their invitee signs up',
        100, true)
on conflict (promo_key) do update set amount_lymx = excluded.amount_lymx, active = true;


-- =====================================================================
-- 5. View: my referrals (who I invited, who invited me)
-- =====================================================================
create or replace view public.v_my_referrals as
select
    r.id,
    case when r.inviter_user_id = auth.uid() then 'sent' else 'received' end as direction,
    r.inviter_user_id,
    r.invitee_user_id,
    r.invite_method,
    r.invite_template,
    r.inviter_bonus_amount,
    r.invitee_bonus_amount,
    r.status,
    r.created_at,
    -- Snapshot the OTHER side's email (the one I'm not)
    case when r.inviter_user_id = auth.uid()
         then (select email from auth.users where id = r.invitee_user_id)
         else (select email from auth.users where id = r.inviter_user_id)
    end as other_party_email
from public.referrals r
where r.inviter_user_id = auth.uid()
   or r.invitee_user_id = auth.uid()
   or auth.uid() = '1405bb50-2c97-48dd-bfa5-31f32320de9b'::uuid;

grant select on public.v_my_referrals to authenticated;


-- =====================================================================
-- 6. Verify
-- =====================================================================
select 'partner_emails secondary cols added' as check,
       (select count(*) from information_schema.columns
         where table_name = 'partner_emails' and column_name like 'secondary_%')::int as cnt
union all
select 'referrals table', (select count(*) from information_schema.columns where table_name='referrals')::int
union all
select 'credit_referral_pair RPC', (select count(*) from information_schema.routines where routine_name='credit_referral_pair')::int
union all
select 'inviter_bonus promo', (select coalesce(amount_lymx,0)::int from public.platform_promos where promo_key='inviter_bonus')
union all
select 'referral_bonus updated to 100', (select coalesce(amount_lymx,0)::int from public.platform_promos where promo_key='referral_bonus');

-- =============================================================================
-- End of migration 017
-- =============================================================================
