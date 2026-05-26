-- =============================================================================
-- Migration 014 — Platform-wide promotional configuration
-- =============================================================================
-- Lets Kenny change promo amounts (e.g., new-business signup bonus = 10,000 LYMX)
-- via SQL without redeploying Edge Functions. Used by business-signup endpoint
-- to look up the current new-business welcome bonus.
-- =============================================================================

create table if not exists public.platform_promos (
    id              uuid primary key default uuid_generate_v4(),
    promo_key       text not null unique,
    description     text,
    amount_lymx     int not null check (amount_lymx >= 0),
    active          boolean not null default true,
    starts_at       timestamptz,
    ends_at         timestamptz,
    created_by      uuid references auth.users(id),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists idx_platform_promos_active on public.platform_promos(promo_key) where active = true;

-- updated_at trigger (reuses helper from migration 012)
drop trigger if exists platform_promos_updated_at on public.platform_promos;
create trigger platform_promos_updated_at before update on public.platform_promos
    for each row execute function public.set_b2b_updated_at();

-- RLS — admin all, all read
alter table public.platform_promos enable row level security;

drop policy if exists promos_admin_all on public.platform_promos;
create policy promos_admin_all on public.platform_promos for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

drop policy if exists promos_public_read on public.platform_promos;
create policy promos_public_read on public.platform_promos for select to authenticated, anon
    using (active = true);

grant select on public.platform_promos to anon, authenticated;
grant insert, update on public.platform_promos to authenticated;

-- RPC to fetch active promo amount
create or replace function public.get_active_promo_amount(p_key text)
returns int
language sql stable
as $$
  select coalesce(amount_lymx, 0)
    from public.platform_promos
   where promo_key = p_key
     and active = true
     and (starts_at is null or starts_at <= now())
     and (ends_at   is null or ends_at   >= now())
   order by created_at desc
   limit 1
$$;

grant execute on function public.get_active_promo_amount(text) to authenticated, anon, service_role;

-- Seed initial promos
insert into public.platform_promos (promo_key, description, amount_lymx, active)
values
  ('new_business_signup_bonus', 'Welcome bonus for new Businesses joining LYMX', 10000, true),
  ('new_partner_signup_bonus',  'Welcome bonus for new Partners joining LYMX',     500, true),
  ('referral_bonus',            'LYMX awarded when a customer refers a friend who signs up', 50, true)
on conflict (promo_key) do nothing;

-- Verify
select promo_key, amount_lymx, active from public.platform_promos order by promo_key;

-- =============================================================================
-- End of migration 014
-- =============================================================================
