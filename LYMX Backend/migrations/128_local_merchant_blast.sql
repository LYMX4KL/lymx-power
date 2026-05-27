-- =============================================================================
-- 128_local_merchant_blast.sql
-- Auto-blast newly-approved local businesses to LYMX users in the same area.
-- 2026-05-27 — Kenny's "When biz approved, blast LYMX users in radius" ask.
--
-- v1 architecture (ZIP-prefix matching, no geocoding):
--   - Customer opt-in flag (default ON, easy to opt out from profile)
--   - SECURITY DEFINER helper that maps a business → its primary location's
--     zip → opt-in customers whose home_zip starts with the same prefix.
--   - Default prefix = 3 digits (~10-15 mile radius in most US metros).
--   - The Edge Function `blast-new-business-to-locals` calls this helper,
--     creates a custom broadcast, and triggers `broadcast-send`.
--
-- Phase 3 (deferred): switch ZIP-prefix to true latitude/longitude radius
-- once businesses table has geocoded coords (business_locations already
-- has latitude/longitude columns from mig 001 line 96-97; we'll fill them
-- on approval via a geocoding worker in a future migration).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Customer opt-in for local-merchant blasts
-- -----------------------------------------------------------------------------
alter table public.customers
    add column if not exists local_merchant_notifications_opt_in boolean
        not null default true;

comment on column public.customers.local_merchant_notifications_opt_in is
    'When a new merchant is approved in the customer''s ZIP area, do they get an email about it? Default true. Customer can turn off from profile.html.';

-- Per-customer radius override (in ZIP digits). 3 = first 3 ZIP digits
-- (~10-15mi metro). 5 = full ZIP (same neighborhood). 0 = no filter (national).
alter table public.customers
    add column if not exists local_merchant_radius_zip_digits int
        not null default 3
        check (local_merchant_radius_zip_digits between 0 and 5);

comment on column public.customers.local_merchant_radius_zip_digits is
    'How many leading ZIP digits must match for a new-merchant alert to fire. 3 = ~10-15mi (default), 5 = exact ZIP, 0 = national.';


-- -----------------------------------------------------------------------------
-- 2. SECURITY DEFINER helper: business → opt-in local customer emails
-- -----------------------------------------------------------------------------
-- Why definer: Edge Functions run as service_role but this function may
-- also be useful for admin "preview audience" UI later. Wrap the auth.users
-- read in a definer to avoid RLS recursion (see
-- feedback_lymx_rls_no_auth_users_subselect.md).

drop function if exists public.fn_local_customers_for_biz(uuid);

create or replace function public.fn_local_customers_for_biz(p_business_id uuid)
returns table (
    email          text,
    display_name   text,
    home_zip       text,
    matched_digits int
)
language plpgsql
security definer
set search_path = public, auth
as $fn_local_customers_for_biz$
declare
    biz_zip text;
begin
    -- Find the biz's PRIMARY location zip. If no primary flagged, take any.
    select coalesce(
        (select zip from public.business_locations
            where business_id = p_business_id and is_primary = true
              and zip is not null and zip <> ''
            limit 1),
        (select zip from public.business_locations
            where business_id = p_business_id
              and zip is not null and zip <> ''
            order by created_at asc
            limit 1)
    ) into biz_zip;

    -- No zip on biz → nothing to blast. Caller handles the empty-set gracefully.
    if biz_zip is null or length(trim(biz_zip)) < 3 then
        return;
    end if;

    -- Strip non-digits and take first 5 (handles "94103-1234" etc.)
    biz_zip := regexp_replace(biz_zip, '[^0-9]', '', 'g');
    if length(biz_zip) < 3 then
        return;
    end if;

    return query
    select
        c.email,
        c.display_name,
        c.home_zip,
        c.local_merchant_radius_zip_digits as matched_digits
    from public.customers c
    where c.archived_at is null
      and c.local_merchant_notifications_opt_in = true
      and c.email is not null
      and c.email <> ''
      and c.home_zip is not null
      and length(regexp_replace(c.home_zip, '[^0-9]', '', 'g')) >= c.local_merchant_radius_zip_digits
      and (
          c.local_merchant_radius_zip_digits = 0
          or substring(regexp_replace(c.home_zip, '[^0-9]', '', 'g') from 1 for c.local_merchant_radius_zip_digits)
              = substring(biz_zip from 1 for c.local_merchant_radius_zip_digits)
      );
end;
$fn_local_customers_for_biz$;

revoke all on function public.fn_local_customers_for_biz(uuid) from public;
grant execute on function public.fn_local_customers_for_biz(uuid) to service_role;
grant execute on function public.fn_local_customers_for_biz(uuid) to authenticated;

comment on function public.fn_local_customers_for_biz(uuid) is
    'Returns the email + display_name of opt-in LYMX customers whose home_zip prefix matches the biz''s primary location zip. Per-customer radius via local_merchant_radius_zip_digits. Service-role + admin-callable.';


-- -----------------------------------------------------------------------------
-- 3. Track which businesses have already been blasted (idempotency)
-- -----------------------------------------------------------------------------
-- Without this, double-clicking Approve or a re-approval would blast users
-- twice. The blast EF checks this column before firing and sets it on success.
alter table public.businesses
    add column if not exists local_blast_sent_at timestamptz;

alter table public.businesses
    add column if not exists local_blast_broadcast_id uuid
        references public.broadcasts(id) on delete set null;

alter table public.businesses
    add column if not exists local_blast_audience_size int;

comment on column public.businesses.local_blast_sent_at is
    'When the auto-blast to local LYMX customers fired (mig 128). Null = never blasted. Used by blast-new-business-to-locals EF for idempotency.';


-- -----------------------------------------------------------------------------
-- 4. Feature-catalog entry for the customer opt-out toggle on profile.html
-- -----------------------------------------------------------------------------
insert into public.feature_catalog (feature_key, label, description, category, default_for_roles, playbook_slug, page_paths)
values (
    'customer_local_alerts',
    'Local merchant alerts',
    'When a new business near you is approved on LYMX, get an email so you can earn from day one.',
    'customer',
    array['customer'],
    null,
    array['/profile.html', '/customer-dashboard.html']
)
on conflict (feature_key) do update
   set label             = excluded.label,
       description       = excluded.description,
       category          = excluded.category,
       default_for_roles = excluded.default_for_roles,
       page_paths        = excluded.page_paths;

-- =============================================================================
-- END mig 128
-- =============================================================================
