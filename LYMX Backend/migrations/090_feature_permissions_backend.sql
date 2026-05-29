-- 090_feature_permissions_backend.sql
-- =============================================================================
-- Purpose: build the MISSING backend for the feature-permission system.
--
-- State before this migration (discovered 2026-05-29):
--   * Frontend admin-manage-permissions.html is fully built and live. It lets
--     an admin pick any member (customer / partner / staff / business owner)
--     and set each feature to Grant / Default / Deny.
--   * Tables public.feature_catalog (28 rows, seeded 2026-05-27) and
--     public.user_permissions already exist in the live DB — but they were
--     created OUT OF BAND (no migration in the repo). This file captures them
--     idempotently so the repo is once again the source of truth.
--   * The RPCs the UI calls — grant_permission, revoke_permission — and the
--     server-side gate has_feature() were NEVER created. So the toggles can't
--     save and nothing actually gates by capability. THIS is the root cause of
--     the Cluster A "staff sees admin links but every page bounces them" flood.
--
-- What this migration adds (root-cause, no band-aid, no hardcoded UUIDs):
--   1. feature_catalog + user_permissions   (CREATE TABLE IF NOT EXISTS — safe)
--   2. RLS: everyone reads feature_catalog; users read their own
--      user_permissions; admins read/write everyone's.
--   3. grant_permission(p_user_id, p_feature_key, p_value)  — admin-gated
--   4. revoke_permission(p_user_id, p_feature_key)          — admin-gated
--   5. has_feature(p_feature_key)  — server-side effective-permission gate:
--        admin -> true; explicit user override -> that; else role defaults.
--   6. admin_set_staff_role(p_user_id, p_role)              — admin-gated
--   7. admin_resolve_user_by_email(p_email)                 — admin-gated
--      (replaces the manual user_id paste prompt band-aid in admin-staff.html)
--
-- Apply in the Supabase SQL editor, then run the verification block at the end.
-- =============================================================================

set search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- 1. Tables (idempotent — matches the live out-of-band schema)
-- ---------------------------------------------------------------------------
create table if not exists public.feature_catalog (
    feature_key       text primary key,
    label             text not null,
    description       text,
    category          text,
    default_for_roles text[] not null default '{}',
    playbook_slug     text,
    page_paths        text[] not null default '{}',
    is_active         boolean not null default true,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

create table if not exists public.user_permissions (
    user_id     uuid primary key references auth.users(id) on delete cascade,
    perms       jsonb not null default '{}'::jsonb,
    updated_at  timestamptz not null default now(),
    updated_by  uuid references auth.users(id) on delete set null
);

alter table public.feature_catalog  enable row level security;
alter table public.user_permissions enable row level security;

-- ---------------------------------------------------------------------------
-- 2. RLS policies
-- ---------------------------------------------------------------------------
-- feature_catalog: any authenticated user may READ (the gate + UI need it);
-- only admins may write.
drop policy if exists feature_catalog_read_all on public.feature_catalog;
create policy feature_catalog_read_all
    on public.feature_catalog for select
    to authenticated, anon
    using (true);

drop policy if exists feature_catalog_admin_write on public.feature_catalog;
create policy feature_catalog_admin_write
    on public.feature_catalog for all
    to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- user_permissions: a user can read their OWN row; admins read/write everyone.
drop policy if exists user_permissions_read_own on public.user_permissions;
create policy user_permissions_read_own
    on public.user_permissions for select
    to authenticated
    using (user_id = auth.uid() or public.am_i_admin());

drop policy if exists user_permissions_admin_write on public.user_permissions;
create policy user_permissions_admin_write
    on public.user_permissions for all
    to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- ---------------------------------------------------------------------------
-- 3. grant_permission — admin sets an explicit Grant (true) or Deny (false)
-- ---------------------------------------------------------------------------
create or replace function public.grant_permission(
    p_user_id     uuid,
    p_feature_key text,
    p_value       boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $grant_permission$
begin
    if not public.am_i_admin() then
        raise exception 'Only admins can change permissions.'
            using errcode = '42501';
    end if;
    if not exists (select 1 from public.feature_catalog where feature_key = p_feature_key) then
        raise exception 'Unknown feature_key: %', p_feature_key;
    end if;

    insert into public.user_permissions (user_id, perms, updated_at, updated_by)
    values (p_user_id, jsonb_build_object(p_feature_key, p_value), now(), auth.uid())
    on conflict (user_id) do update
        set perms      = public.user_permissions.perms || jsonb_build_object(p_feature_key, p_value),
            updated_at = now(),
            updated_by = auth.uid();
end;
$grant_permission$;

-- ---------------------------------------------------------------------------
-- 4. revoke_permission — admin clears the override (back to role default)
-- ---------------------------------------------------------------------------
create or replace function public.revoke_permission(
    p_user_id     uuid,
    p_feature_key text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $revoke_permission$
begin
    if not public.am_i_admin() then
        raise exception 'Only admins can change permissions.'
            using errcode = '42501';
    end if;

    update public.user_permissions
       set perms      = public.user_permissions.perms - p_feature_key,
           updated_at = now(),
           updated_by = auth.uid()
     where user_id = p_user_id;
end;
$revoke_permission$;

-- ---------------------------------------------------------------------------
-- 5. has_feature — the SERVER-SIDE effective gate for the CURRENT user.
--    Resolution order:
--      a) admins get everything
--      b) explicit override in user_permissions wins (grant=true / deny=false)
--      c) otherwise: feature_catalog.default_for_roles vs the caller's roles
--         (anonymous / authenticated / admin / staff / partner /
--          business_owner / customer)
-- ---------------------------------------------------------------------------
create or replace function public.has_feature(p_feature_key text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $has_feature$
declare
    v_uid       uuid := auth.uid();
    v_defaults  text[];
    v_override  jsonb;
    v_is_staff  boolean;
    v_is_admin  boolean;
    v_is_partner boolean;
    v_is_bizown boolean;
    v_is_cust   boolean;
begin
    -- Feature must exist + be active, else deny (fail closed).
    select default_for_roles into v_defaults
      from public.feature_catalog
     where feature_key = p_feature_key and is_active = true;
    if not found then
        return false;
    end if;

    -- Anonymous-allowed features are open to everyone (incl. logged-out).
    if v_defaults @> array['anonymous'] then
        return true;
    end if;

    if v_uid is null then
        return false;
    end if;

    -- (a) admins get everything
    if public.am_i_admin() then
        return true;
    end if;

    -- (b) explicit per-user override wins
    select perms into v_override from public.user_permissions where user_id = v_uid;
    if v_override is not null and v_override ? p_feature_key then
        return coalesce((v_override ->> p_feature_key)::boolean, false);
    end if;

    -- (c) role defaults
    if v_defaults @> array['authenticated'] then
        return true;
    end if;

    v_is_staff   := exists (select 1 from public.staff_roles where user_id = v_uid);
    v_is_partner := exists (select 1 from public.partners    where user_id = v_uid);
    v_is_bizown  := exists (select 1 from public.businesses  where owner_user_id = v_uid);
    v_is_cust    := exists (select 1 from public.customers   where user_id = v_uid);

    if v_defaults @> array['staff']          and v_is_staff   then return true; end if;
    if v_defaults @> array['partner']        and v_is_partner then return true; end if;
    if v_defaults @> array['business_owner'] and v_is_bizown  then return true; end if;
    if v_defaults @> array['customer']       and v_is_cust    then return true; end if;

    return false;
end;
$has_feature$;

-- ---------------------------------------------------------------------------
-- 6. admin_set_staff_role — assign / change / remove a staff member's role.
--    p_role NULL or '' removes the staff_roles row (revoke staff access).
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_staff_role(
    p_user_id uuid,
    p_role    text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $admin_set_staff_role$
begin
    if not public.am_i_admin() then
        raise exception 'Only admins can assign staff roles.'
            using errcode = '42501';
    end if;

    if p_role is null or btrim(p_role) = '' then
        delete from public.staff_roles where user_id = p_user_id;
        return;
    end if;

    if p_role not in ('admin','manager','staff','support','tech','accounting','hr','marketing') then
        raise exception 'Invalid role: %. Allowed: admin, manager, staff, support, tech, accounting, hr, marketing', p_role;
    end if;

    insert into public.staff_roles (user_id, role)
    values (p_user_id, p_role)
    on conflict (user_id) do update set role = excluded.role;
end;
$admin_set_staff_role$;

-- ---------------------------------------------------------------------------
-- 7. admin_resolve_user_by_email — look up an auth user by email so admins can
--    add staff WITHOUT pasting a raw UUID (replaces the admin-staff.html band-aid).
-- ---------------------------------------------------------------------------
create or replace function public.admin_resolve_user_by_email(p_email text)
returns table (user_id uuid, email text)
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $admin_resolve_user_by_email$
begin
    if not public.am_i_admin() then
        raise exception 'Only admins can resolve users by email.'
            using errcode = '42501';
    end if;

    return query
    select u.id, u.email::text
      from auth.users u
     where lower(u.email) = lower(btrim(p_email))
     limit 1;
end;
$admin_resolve_user_by_email$;

-- ---------------------------------------------------------------------------
-- 8. my_features — bulk list of feature_keys the CURRENT user effectively has.
--    Lets the sidebar / pages filter capabilities in ONE call instead of N.
-- ---------------------------------------------------------------------------
create or replace function public.my_features()
returns text[]
language sql
security definer
set search_path = public, pg_temp
stable
as $my_features$
    select coalesce(array_agg(fc.feature_key), '{}')
      from public.feature_catalog fc
     where fc.is_active = true
       and public.has_feature(fc.feature_key);
$my_features$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
grant execute on function public.grant_permission(uuid, text, boolean) to authenticated;
grant execute on function public.revoke_permission(uuid, text)         to authenticated;
grant execute on function public.has_feature(text)                     to authenticated, anon;
grant execute on function public.admin_set_staff_role(uuid, text)      to authenticated;
grant execute on function public.admin_resolve_user_by_email(text)     to authenticated;
grant execute on function public.my_features()                         to authenticated, anon;

-- ---------------------------------------------------------------------------
-- VERIFICATION (run after applying; all should succeed)
-- ---------------------------------------------------------------------------
-- select count(*) as features from public.feature_catalog;          -- expect 28
-- select public.has_feature('admin_manage_permissions');            -- true for admin
-- select proname from pg_proc
--   where proname in ('grant_permission','revoke_permission','has_feature',
--                     'admin_set_staff_role','admin_resolve_user_by_email');  -- 5 rows
