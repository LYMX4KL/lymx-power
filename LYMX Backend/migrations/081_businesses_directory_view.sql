-- =============================================================================
-- Migration 081 - businesses directory view (root-cause for #627c3f4e)
-- =============================================================================
-- The Issue
-- ---------
-- my-conversations.html New Message form queries `public.businesses` directly
-- to populate the "search a business" picker. But businesses table RLS only
-- grants SELECT to:
--   - the owner (biz_owner_full_access, 002_rls_policies.sql)
--   - admins (businesses_admin_read, 035_biz_approval_and_bridge.sql)
-- A partner like Dave gets zero rows back from any business search even though
-- approved businesses exist. The 002 comment promised a "public view in 003"
-- but it was never created.
--
-- The Fix
-- -------
-- Create a SECURITY INVOKER view `public.v_businesses_directory` that exposes
-- ONLY the columns safe for the contact-picker workflow (no owner ids, no
-- internal flags, no tax info). Backed by a SECURITY DEFINER function so we
-- can choose what to show without leaking RLS-protected columns.
--
-- Currently exposes ALL non-archived businesses — once admin approval is the
-- enforced gating, switch the WHERE clause to verified_at IS NOT NULL.
-- =============================================================================

set search_path = public, pg_temp;

-- Drop any prior version (idempotent re-run safety)
drop view if exists public.v_businesses_directory cascade;

-- SECURITY DEFINER function returns the safe columns, bypassing RLS once.
create or replace function public.fn_businesses_directory()
returns table (
    id            uuid,
    display_name  text,
    legal_name    text,
    slug          text,
    business_kind text,
    verified_at   timestamptz,
    created_at    timestamptz
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
    select
        b.id,
        b.display_name,
        b.legal_name,
        b.slug,
        b.business_kind,
        b.verified_at,
        b.created_at
    from public.businesses b
    where b.archived_at is null
$$;

comment on function public.fn_businesses_directory() is
  'SECURITY DEFINER read of basic discoverable business fields. Backs v_businesses_directory. Exposes only safe columns; no owner_user_id, no tax, no internal flags.';

-- View wraps the function so the front-end can use familiar PostgREST patterns
-- (ilike filters, or-clauses, select shaping).
create view public.v_businesses_directory as
    select * from public.fn_businesses_directory();

comment on view public.v_businesses_directory is
  'Public contact-picker view of businesses. Use this from front-end "search a business" workflows (new-message form, referral picker). Filters out archived; exposes only safe columns. Queryable by anon + authenticated.';

-- Grant read access; the view itself doesn't enforce RLS but the function
-- bounds what's visible (column subset + archived filter).
grant select on public.v_businesses_directory to anon, authenticated;
grant execute on function public.fn_businesses_directory() to anon, authenticated, service_role;

-- Sanity output
do $check$
declare
    v_count integer;
begin
    select count(*) into v_count from public.v_businesses_directory;
    raise notice 'v_businesses_directory exposes % discoverable businesses', v_count;
end;
$check$;
