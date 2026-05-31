-- =============================================================================
-- Migration 163 — pull-source config + InvestPro activation
-- =============================================================================
-- Stores, per integrated business, the read-only feed we PULL from (their
-- endpoint + token + high-water cursor). The token is write-only via a
-- SECURITY DEFINER admin RPC and readable ONLY by the service-role connector
-- EF (no anon/authenticated SELECT grant) so it never leaks through REST.
-- Also creates + activates InvestPro's LYMX business record (pull model).
-- =============================================================================

-- 1. per-business pull source
create table if not exists public.business_integration_source (
    business_id    uuid primary key references public.businesses(id) on delete cascade,
    source_url     text not null,
    auth_header    text not null default 'Authorization',
    auth_scheme    text not null default 'Bearer',      -- prefix for the token value
    auth_token     text,                                 -- read-only token from the business
    since_cursor   timestamptz not null default '1970-01-01T00:00:00Z',
    last_pulled_at timestamptz,
    active         boolean not null default true,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now()
);
alter table public.business_integration_source enable row level security;
-- No authenticated grant on purpose: the token must never be SELECT-able over
-- REST. The connector EF reads it with the service-role key (bypasses RLS).

-- 2. admin-only setter (token enters here, never returned)
create or replace function public.set_business_integration_source(
    p_business_id uuid, p_url text, p_token text, p_auth_header text default 'Authorization'
) returns text
language plpgsql security definer set search_path = public, pg_temp
as $bis$
begin
    if not public.am_i_admin() then raise exception 'admin only'; end if;
    insert into public.business_integration_source (business_id, source_url, auth_token, auth_header, updated_at)
    values (p_business_id, p_url, p_token, coalesce(p_auth_header,'Authorization'), now())
    on conflict (business_id) do update
        set source_url = excluded.source_url,
            auth_token = excluded.auth_token,
            auth_header = excluded.auth_header,
            active = true,
            updated_at = now();
    return 'ok';
end;
$bis$;
grant execute on function public.set_business_integration_source(uuid,text,text,text) to authenticated;

-- 3. create + activate InvestPro's LYMX business record (pull model, identity-match required)
do $ip$
declare
    v_owner uuid;
    v_id    uuid;
begin
    select user_id into v_owner from public.staff_roles where role = 'admin' order by granted_at nulls last limit 1;

    select id into v_id from public.businesses where slug = 'investpro' limit 1;
    if v_id is null then
        insert into public.businesses (
            legal_name, display_name, slug, category, contact_email, owner_user_id,
            business_kind, approval_status, approved_at, intake_completed_at,
            identity_match_mode, integration_active, api_key, demo_only
        ) values (
            'InvestPro Realty', 'InvestPro Realty', 'investpro', 'real_estate',
            'partners@investprorealty.net', v_owner,
            'storefront', 'approved', now(), now(),
            'required', true, 'lymx_live_' || encode(gen_random_bytes(24),'hex'), false
        ) returning id into v_id;
    else
        update public.businesses
           set integration_active = true,
               identity_match_mode = 'required',
               intake_completed_at = coalesce(intake_completed_at, now()),
               approval_status = 'approved',
               api_key = coalesce(api_key, 'lymx_live_' || encode(gen_random_bytes(24),'hex'))
         where id = v_id;
    end if;

    -- suppress the auto integration-invite email for InvestPro (they already built the endpoint)
    insert into public.business_integration_invite_log (business_id, sent_to, status)
    values (v_id, null, 'skipped_pre_integrated')
    on conflict (business_id) do nothing;
end
$ip$;

notify pgrst, 'reload schema';
