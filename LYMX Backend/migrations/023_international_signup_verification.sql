-- =============================================================================
-- Migration 023 — International signup + manual verification gate
-- =============================================================================
-- Kenny 2026-05-14: "Rachel can't sign up because she does not have US phone.
-- Allow sign up either with email or phone. They need to be verified before
-- receiving commission or spending lymx at one of our business."
--
-- Adds to customers + partners:
--   - country_code  (ISO 3166-1 alpha-2, default 'US')
--   - verified_at   (timestamptz, null = unverified)
--   - verified_by   (uuid → auth.users)
--   - verification_notes (text)
--
-- Relaxes phone/email constraints (only ONE is required, not both).
--
-- New:
--   - is_user_verified(uuid) RPC — used by settlement + redemption gates
--   - v_pending_verifications view — admin queue
--
-- Compatible with prior migrations. Idempotent.
-- =============================================================================

-- =====================================================================
-- 1. Add columns to partners
-- =====================================================================
alter table public.partners
    add column if not exists country_code         text default 'US',
    add column if not exists verified_at          timestamptz,
    add column if not exists verified_by          uuid references auth.users(id) on delete set null,
    add column if not exists verification_notes   text;

create index if not exists idx_partners_unverified
    on public.partners(created_at desc)
 where verified_at is null;

-- =====================================================================
-- 2. Add columns to customers
-- =====================================================================
alter table public.customers
    add column if not exists country_code         text default 'US',
    add column if not exists verified_at          timestamptz,
    add column if not exists verified_by          uuid references auth.users(id) on delete set null,
    add column if not exists verification_notes   text;

create index if not exists idx_customers_unverified
    on public.customers(created_at desc)
 where verified_at is null;

-- =====================================================================
-- 3. Relax email/phone — at least one required (no longer both)
-- =====================================================================
-- Drop any NOT NULL on phone if it exists (partners.contact_phone, customers.phone)
do $$
begin
    -- partners.contact_phone
    if exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='partners'
                 and column_name='contact_phone' and is_nullable='NO') then
        execute 'alter table public.partners alter column contact_phone drop not null';
    end if;
    -- customers.phone
    if exists (select 1 from information_schema.columns
               where table_schema='public' and table_name='customers'
                 and column_name='phone' and is_nullable='NO') then
        execute 'alter table public.customers alter column phone drop not null';
    end if;
end$$;

-- Add a "at least one contact" check constraint
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'partners_contact_at_least_one') then
        alter table public.partners
            add constraint partners_contact_at_least_one
            check (contact_email is not null or contact_phone is not null);
    end if;
    if not exists (select 1 from pg_constraint where conname = 'customers_contact_at_least_one') then
        alter table public.customers
            add constraint customers_contact_at_least_one
            check (email is not null or phone is not null);
    end if;
end$$;

-- =====================================================================
-- 4. is_user_verified() — used by gates
-- =====================================================================
-- Returns true if the user (in either partners or customers) is verified.
-- Businesses always have their own approval flow, so they're verified by default.
create or replace function public.is_user_verified(p_user_id uuid)
returns boolean
language sql
stable
security definer
as $$
    select coalesce(
        (select verified_at is not null from public.partners  where user_id        = p_user_id limit 1),
        (select verified_at is not null from public.customers where user_id        = p_user_id limit 1),
        (select true                    from public.businesses where owner_user_id = p_user_id limit 1),
        false
    );
$$;

grant execute on function public.is_user_verified(uuid) to authenticated;

-- =====================================================================
-- 5. v_pending_verifications — admin queue
-- =====================================================================
create or replace view public.v_pending_verifications as
select
    'partner'::text       as kind,
    p.id                  as id,
    p.user_id             as user_id,
    coalesce(p.display_name, p.legal_name)  as name,
    p.contact_email       as email,
    p.contact_phone       as phone,
    p.country_code        as country,
    p.sponsor_partner_id  as sponsor,
    p.created_at          as created_at,
    p.verification_notes  as notes
  from public.partners p
 where p.verified_at is null and p.archived_at is null
union all
select
    'customer',
    c.id,
    c.user_id,
    c.display_name,
    c.email,
    c.phone,
    c.country_code,
    null,
    c.created_at,
    c.verification_notes
  from public.customers c
 where c.verified_at is null and c.archived_at is null
 order by created_at desc;

alter view public.v_pending_verifications set (security_invoker = on);
grant select on public.v_pending_verifications to authenticated;

-- =====================================================================
-- 6. RLS — only admin / staff with 'support' role can read the queue
-- =====================================================================
-- v_pending_verifications inherits RLS from partners + customers tables.
-- Make sure partners + customers RLS lets admin read unverified rows.

do $$
begin
    if not exists (
        select 1 from pg_policy where polrelid = 'public.partners'::regclass
          and polname = 'partners_admin_read_unverified'
    ) then
        execute $POL$
            create policy partners_admin_read_unverified on public.partners
                for select to authenticated
                using (auth.uid() = '1405bb50-2c97-48dd-bfa5-31f32320de9b'::uuid)
        $POL$;
    end if;
    if not exists (
        select 1 from pg_policy where polrelid = 'public.customers'::regclass
          and polname = 'customers_admin_read_unverified'
    ) then
        execute $POL$
            create policy customers_admin_read_unverified on public.customers
                for select to authenticated
                using (auth.uid() = '1405bb50-2c97-48dd-bfa5-31f32320de9b'::uuid)
        $POL$;
    end if;
end$$;

-- =====================================================================
-- 7. mark_user_verified() — RPC for admin "Verify" button
-- =====================================================================
create or replace function public.mark_user_verified(
    p_user_id uuid,
    p_notes   text default null
)
returns boolean
language plpgsql
security definer
as $$
declare
    v_caller uuid := auth.uid();
    v_now    timestamptz := now();
    v_partner_hit int;
    v_customer_hit int;
begin
    -- Only admin (or staff with 'support' role if helper exists) can call this.
    if v_caller <> '1405bb50-2c97-48dd-bfa5-31f32320de9b'::uuid then
        raise exception 'Admin only';
    end if;

    update public.partners
       set verified_at = v_now,
           verified_by = v_caller,
           verification_notes = coalesce(p_notes, verification_notes)
     where user_id = p_user_id and verified_at is null;
    get diagnostics v_partner_hit = row_count;

    update public.customers
       set verified_at = v_now,
           verified_by = v_caller,
           verification_notes = coalesce(p_notes, verification_notes)
     where user_id = p_user_id and verified_at is null;
    get diagnostics v_customer_hit = row_count;

    return (v_partner_hit + v_customer_hit) > 0;
end;
$$;

grant execute on function public.mark_user_verified(uuid, text) to authenticated;

-- =====================================================================
-- 8. Verify
-- =====================================================================
select 'migration 023 applied' as status,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='partners'
           and column_name in ('country_code','verified_at','verified_by')) as partner_cols,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='customers'
           and column_name in ('country_code','verified_at','verified_by')) as customer_cols,
       (select count(*) from pg_proc where proname in ('is_user_verified','mark_user_verified')) as new_rpcs,
       (select count(*) from information_schema.views where table_schema='public' and table_name='v_pending_verifications') as new_view;
