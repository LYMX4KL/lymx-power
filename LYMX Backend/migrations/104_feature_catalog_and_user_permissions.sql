-- =============================================================================
-- Migration 104 — feature_catalog + user_permissions + has_permission() RPC
-- =============================================================================
-- Implements LYMX's feature-permission infrastructure per ARCHITECTURE-RULES.md
-- Rule 1 ("Every feature is an assignable permission") and Kenny's 2026-05-26
-- directive: "the playbook goes with the feature, not with the role or member".
--
-- Model:
--   feature_catalog        — registry of every feature, with its plain-English
--                            label, category, default-grant rules, and the
--                            playbook that teaches it.
--   user_permissions       — per-user JSONB { feature_key: true|false } overrides.
--                            Explicit grants beat defaults; explicit denials beat
--                            defaults.
--   has_permission(key)    — boolean, true if admin OR explicit-true OR role-default.
--   has_permissions([k1…]) — batch version, returns { key: bool, ... }.
--   list_my_permissions()  — returns full effective map for current user.
--   grant_permission(...)  — admin RPC; writes user_permissions.
--   revoke_permission(...) — admin RPC; same.
--
-- Resolution order inside has_permission:
--   1. signed-out (auth.uid() is null)            → only features with
--                                                    default_for_roles & {anon} qualify
--   2. am_i_admin()                               → TRUE
--   3. explicit user_permissions.perms[key]       → use that value (true OR false)
--   4. role-default check via default_for_roles   → TRUE if any role matches
--   5. else                                       → FALSE
--
-- Role tags valid in default_for_roles:
--   'admin'         — public.am_i_admin() true
--   'staff'         — public.is_staff()  true
--   'partner'       — row in public.partners with this user_id
--   'business_owner'— row in public.businesses with owner_user_id = this user
--   'customer'      — row in public.customers with user_id = this user
--   'authenticated' — any signed-in user
--   'anonymous'     — every visitor (and signed-in)
--
-- Idempotent. Named dollar-quotes per feedback_supabase_named_dollar_quotes.
-- =============================================================================

set local statement_timeout = 0;

-- =====================================================================
-- 1. feature_catalog
-- =====================================================================
create table if not exists public.feature_catalog (
    feature_key       text primary key
                      check (feature_key ~ '^[a-z][a-z0-9_]{2,80}$'),
    label             text not null,
    description       text,
    category          text not null,
    default_for_roles text[] not null default array[]::text[],
    playbook_slug     text,                       -- matches playbooks/INDEX.md slug
    page_paths        text[] not null default array[]::text[],
    is_active         boolean not null default true,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);
create index if not exists idx_feature_catalog_category
    on public.feature_catalog(category) where is_active;
create index if not exists idx_feature_catalog_playbook_slug
    on public.feature_catalog(playbook_slug) where playbook_slug is not null;

alter table public.feature_catalog enable row level security;

drop policy if exists fc_read_all on public.feature_catalog;
create policy fc_read_all on public.feature_catalog
    for select to authenticated, anon
    using (is_active = true);

drop policy if exists fc_write_admin on public.feature_catalog;
create policy fc_write_admin on public.feature_catalog
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

do $fc_updated_at$
begin
    create trigger trg_fc_updated_at before update on public.feature_catalog
        for each row execute function public.tg_set_updated_at();
exception when duplicate_object then null;
end$fc_updated_at$;


-- =====================================================================
-- 2. user_permissions
-- =====================================================================
create table if not exists public.user_permissions (
    user_id    uuid primary key references auth.users(id) on delete cascade,
    perms      jsonb not null default '{}'::jsonb
               check (jsonb_typeof(perms) = 'object'),
    notes      text,
    updated_at timestamptz not null default now(),
    updated_by uuid references auth.users(id) on delete set null
);
create index if not exists idx_user_permissions_perms_gin
    on public.user_permissions using gin (perms);

alter table public.user_permissions enable row level security;

drop policy if exists up_read_self_or_admin on public.user_permissions;
create policy up_read_self_or_admin on public.user_permissions
    for select to authenticated
    using (user_id = auth.uid() or public.am_i_admin());

drop policy if exists up_write_admin on public.user_permissions;
create policy up_write_admin on public.user_permissions
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

do $up_updated_at$
begin
    create trigger trg_up_updated_at before update on public.user_permissions
        for each row execute function public.tg_set_updated_at();
exception when duplicate_object then null;
end$up_updated_at$;


-- =====================================================================
-- 3. role detection helpers (SECURITY DEFINER so they can read across tables)
-- =====================================================================
-- These are PRIVATE helpers used by has_permission(). They check whether the
-- current user has the named role-tag. SECURITY DEFINER lets them read identity
-- tables that may be RLS-restricted from the caller.
create or replace function public._has_role_tag(p_tag text)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $hrt$
declare
    v_uid uuid := auth.uid();
begin
    if p_tag = 'anonymous' then
        return true;
    end if;
    if v_uid is null then
        return false;
    end if;
    if p_tag = 'authenticated' then return true; end if;
    if p_tag = 'admin'   then return public.am_i_admin(); end if;
    if p_tag = 'staff'   then return public.is_staff(); end if;
    if p_tag = 'partner' then
        return exists (select 1 from public.partners where user_id = v_uid);
    end if;
    if p_tag = 'business_owner' then
        return exists (select 1 from public.businesses where owner_user_id = v_uid);
    end if;
    if p_tag = 'customer' then
        return exists (select 1 from public.customers where user_id = v_uid);
    end if;
    return false;
end$hrt$;

grant execute on function public._has_role_tag(text) to authenticated, anon;


-- =====================================================================
-- 4. has_permission(feature_key)
-- =====================================================================
create or replace function public.has_permission(p_feature_key text)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $hp$
declare
    v_uid uuid := auth.uid();
    v_explicit jsonb;
    v_default text[];
    v_active boolean;
    v_tag text;
begin
    -- Feature must exist + be active
    select fc.default_for_roles, fc.is_active
      into v_default, v_active
      from public.feature_catalog fc
     where fc.feature_key = p_feature_key;
    if not found or v_active is not true then
        return false;
    end if;

    -- Admin shortcut beats everything
    if v_uid is not null and public.am_i_admin() then
        return true;
    end if;

    -- Explicit grant beats role-default (true OR false)
    if v_uid is not null then
        select perms -> p_feature_key
          into v_explicit
          from public.user_permissions
         where user_id = v_uid;
        if v_explicit is not null and jsonb_typeof(v_explicit) = 'boolean' then
            return (v_explicit)::text::boolean;
        end if;
    end if;

    -- Role default — any tag match grants
    if v_default is null or array_length(v_default, 1) is null then
        return false;
    end if;
    foreach v_tag in array v_default loop
        if public._has_role_tag(v_tag) then
            return true;
        end if;
    end loop;
    return false;
end$hp$;

grant execute on function public.has_permission(text) to authenticated, anon;


-- =====================================================================
-- 5. has_permissions(feature_keys[]) — batch version
-- =====================================================================
-- Returns jsonb { feature_key: boolean, ... }. Used by playbooks.html for a
-- single round-trip lookup over many features.
create or replace function public.has_permissions(p_feature_keys text[])
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $hps$
declare
    v_out jsonb := '{}'::jsonb;
    v_key text;
begin
    if p_feature_keys is null then return v_out; end if;
    foreach v_key in array p_feature_keys loop
        v_out := v_out || jsonb_build_object(v_key, public.has_permission(v_key));
    end loop;
    return v_out;
end$hps$;

grant execute on function public.has_permissions(text[]) to authenticated, anon;


-- =====================================================================
-- 6. list_my_permissions() — full effective map for current user
-- =====================================================================
-- Returns every active feature_key with its effective boolean for the caller.
-- Used by the sidebar / per-page chip widget to decide what to render without
-- N round-trips.
create or replace function public.list_my_permissions()
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $lmp$
declare
    v_out jsonb := '{}'::jsonb;
    v_rec record;
begin
    for v_rec in
        select feature_key from public.feature_catalog where is_active = true
    loop
        v_out := v_out || jsonb_build_object(v_rec.feature_key,
                                              public.has_permission(v_rec.feature_key));
    end loop;
    return v_out;
end$lmp$;

grant execute on function public.list_my_permissions() to authenticated, anon;


-- =====================================================================
-- 7. grant_permission / revoke_permission (admin RPCs)
-- =====================================================================
-- Admin-only. Sets perms[feature_key] = true (grant) or false (deny).
-- Uses upsert pattern so the user_permissions row is created on first grant.
create or replace function public.grant_permission(
    p_user_id uuid,
    p_feature_key text,
    p_value boolean default true,
    p_notes text default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $grant$
declare
    v_actor uuid := auth.uid();
begin
    if v_actor is null or not public.am_i_admin() then
        raise exception 'Permission denied: grant_permission is admin-only.';
    end if;
    if not exists (select 1 from public.feature_catalog
                    where feature_key = p_feature_key and is_active = true) then
        raise exception 'Unknown or inactive feature_key: %', p_feature_key;
    end if;

    insert into public.user_permissions (user_id, perms, notes, updated_at, updated_by)
    values (p_user_id, jsonb_build_object(p_feature_key, p_value), p_notes, now(), v_actor)
    on conflict (user_id) do update set
        perms = public.user_permissions.perms
              || jsonb_build_object(p_feature_key, p_value),
        notes = coalesce(p_notes, public.user_permissions.notes),
        updated_at = now(),
        updated_by = v_actor;
end$grant$;

grant execute on function public.grant_permission(uuid, text, boolean, text) to authenticated;

create or replace function public.revoke_permission(
    p_user_id uuid,
    p_feature_key text,
    p_notes text default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $rev$
declare
    v_actor uuid := auth.uid();
begin
    if v_actor is null or not public.am_i_admin() then
        raise exception 'Permission denied: revoke_permission is admin-only.';
    end if;
    -- Remove the key entirely so role-default takes over again
    update public.user_permissions
       set perms = perms - p_feature_key,
           notes = coalesce(p_notes, notes),
           updated_at = now(),
           updated_by = v_actor
     where user_id = p_user_id;
end$rev$;

grant execute on function public.revoke_permission(uuid, text, text) to authenticated;


-- =====================================================================
-- 8. Seed feature_catalog with known playbooks
-- =====================================================================
-- One row per existing playbook in playbooks/INDEX.md plus the new
-- admin_manage_permissions feature (the page being built in Sprint 0b).
-- page_paths lets the chip-renderer auto-discover which pages should show
-- the playbook chip; multiple paths are allowed.
insert into public.feature_catalog (feature_key, label, description, category, default_for_roles, playbook_slug, page_paths)
values
    -- The permission management page itself
    ('admin_manage_permissions',
     'Manage feature permissions',
     'Toggle which members can use each feature. The matrix lives at /admin-manage-permissions.html.',
     'Admin',
     array['admin'],
     null,
     array['/admin-manage-permissions.html']),

    -- Existing playbooks
    ('partner_configure_email',
     'Connect @getlymx.com email to Gmail',
     'Walkthrough for partners adding their @getlymx.com alias to their personal Gmail.',
     'Partner',
     array['partner','admin'],
     'partner-email-setup',
     array['/profile.html','/partner-academy.html']),

    ('partner_view_comp_plan',
     'View the partner comp plan',
     'How partner commissions are structured (G1/G2/G3 + founding bonuses).',
     'Partner',
     array['partner','admin'],
     'comp-plan-partner-walkthrough',
     array['/comp-plan.html','/partner-commission-calc.html','/rep-dashboard.html']),

    ('customer_write_review',
     'Write a transaction-verified review',
     'Earn 100 LYMX per receipt-verified review on a business you visited.',
     'Customer',
     array['customer','admin'],
     'customer-onboarding-03-pending-reviews',
     array['/customer-dashboard.html','/my-reviews.html']),

    ('invite_business',
     'Invite a business to LYMX',
     'Create + send an invitation that prefills biz-signup with a verified token.',
     'Business onboarding',
     array['admin','partner'],
     'business-onboarding-01-invite',
     array['/admin-businesses.html','/partner-crm.html','/admin-business-applications.html']),

    ('business_signup_self',
     'Sign up your business',
     'Anyone with an invite token (or open signup) can submit a business application.',
     'Business onboarding',
     array['anonymous'],
     'business-onboarding-02-signup',
     array['/biz-signup.html']),

    ('approve_business_application',
     'Approve a business application',
     'Review + approve / request more info / reject pending business signups.',
     'Business onboarding',
     array['admin'],
     'business-onboarding-03-approval',
     array['/admin-business-applications.html']),

    ('send_business_approval_email',
     'Send business approval email + nightly nudge',
     'Approval email template, the required 20-min call, and the followup cron.',
     'Business onboarding',
     array['admin'],
     'business-onboarding-04-approval-email-and-callback',
     array['/admin-business-applications.html']),

    ('book_onboarding_call',
     'Book the 20-min onboarding call',
     'Schedule + run the Daily.co onboarding call; post-call summary auto-generates.',
     'Business onboarding',
     array['business_owner','admin'],
     'business-onboarding-05-booking-the-call',
     array['/book-onboarding-call.html','/admin-business-applications.html']),

    ('issue_lymx_at_business',
     'Issue LYMX at your business',
     'Per Module 5 unified pipeline; covers QR claims, manual issuance, ledger writes.',
     'Business operations',
     array['business_owner','admin'],
     'business-onboarding-06-issuing-lymx',
     array['/biz-dashboard.html','/biz-profile.html']),

    ('redeem_lymx_at_business',
     'Earn + redeem LYMX as a customer',
     'How a customer claims and uses LYMX after a transaction.',
     'Customer',
     array['customer','anonymous'],
     'business-onboarding-07-customer-redeems',
     array['/customer-dashboard.html','/customer-wallet.html','/welcome.html']),

    ('manage_hr_onboarding',
     'Onboard a new staff member (offer → first day)',
     'Full HR onboarding pipeline: offer letter through first day at the location.',
     'HR',
     array['admin'],
     'hr-onboarding-end-to-end',
     array['/admin-hiring.html','/admin-personnel-records.html','/admin-staff.html']),

    -- Sprint 1 feature seed (so the playbook chip works the moment Reservations ships)
    ('manage_reservations',
     'Manage incoming table reservations',
     'Approve / decline / suggest-time on reservations submitted on your business profile.',
     'Business operations',
     array['business_owner','admin'],
     'business-operations-reservations',
     array['/biz-dashboard.html','/biz-reservations.html']),

    ('reserve_a_table',
     'Reserve a table at a business',
     'Customer-side flow: submit a reservation on a business profile page.',
     'Customer',
     array['anonymous'],
     'business-operations-reservations',
     array['/my-reservations.html'])
on conflict (feature_key) do update set
    label            = excluded.label,
    description      = excluded.description,
    category         = excluded.category,
    default_for_roles= excluded.default_for_roles,
    playbook_slug    = excluded.playbook_slug,
    page_paths       = excluded.page_paths,
    is_active        = true,
    updated_at       = now();


-- =====================================================================
-- 9. Sanity
-- =====================================================================
do $sanity$
declare v_feat int; v_perms int;
begin
    select count(*) into v_feat from public.feature_catalog where is_active = true;
    select count(*) into v_perms from public.user_permissions;
    raise notice 'Migration 104 OK — % active features, % user_permission rows.', v_feat, v_perms;
end$sanity$;

-- =============================================================================
-- END migration 104
-- =============================================================================
