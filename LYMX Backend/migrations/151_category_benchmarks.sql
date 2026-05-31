-- =============================================================================
-- Migration 151 — category_benchmarks: tunable per-category LYMX economics
-- =============================================================================
-- The income projector (Rule 5) models production by business category, where
-- each type has its own LYMX issued/redeemed volume. Those defaults were
-- hardcoded estimates in the page. This makes them a single, admin-tunable
-- source so they can be calibrated to real market data without a redeploy.
-- Anon-readable (the projector is public-friendly); admin-writable. The page
-- keeps its built-in estimates as a fallback for any category not in the table.
-- =============================================================================

set local statement_timeout = 0;
begin;

create table if not exists public.category_benchmarks (
    key            text primary key,
    icon           text,
    name           text not null,
    sub            text,
    lymx_issued    int  not null default 0,   -- avg LYMX issued / business / month
    lymx_redeemed  int  not null default 0,   -- avg LYMX redeemed / business / month
    sort_order     int  not null default 0,
    active         boolean not null default true,
    updated_at     timestamptz not null default now()
);
alter table public.category_benchmarks enable row level security;

drop policy if exists catbm_read_all on public.category_benchmarks;
create policy catbm_read_all on public.category_benchmarks
    for select to anon, authenticated using (true);

drop policy if exists catbm_write_admin on public.category_benchmarks;
create policy catbm_write_admin on public.category_benchmarks
    for all to authenticated using (public.am_i_admin()) with check (public.am_i_admin());

-- seed (idempotent) — current projector estimates; tune as real data lands
insert into public.category_benchmarks (key, icon, name, sub, lymx_issued, lymx_redeemed, sort_order) values
  ('cafe',        '☕', 'Café / Coffee',           'high frequency, low ticket', 30000, 24000, 1),
  ('drinks',      '🧋', 'Drinks / Boba / Juice',   'high frequency',             22000, 18000, 2),
  ('fastfood',    '🍔', 'Fast food / QSR',         'high frequency',             28000, 22000, 3),
  ('fullservice', '🍽️', 'Full-service restaurant', 'higher ticket',              18000, 14000, 4),
  ('bar',         '🍸', 'Bar / Nightlife',         'evenings',                   15000, 11000, 5),
  ('retail',      '🛒', 'Retail / Shop',           'mid ticket',                 12000,  9000, 6),
  ('salon',       '💈', 'Salon / Beauty / Spa',    'appointments',                9000,  7000, 7),
  ('fitness',     '🏋️', 'Fitness / Gym / Studio',  'membership',                  8000,  6000, 8)
on conflict (key) do nothing;

-- anon-readable accessor for the projector
create or replace function public.current_category_benchmarks()
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $cb$
  select coalesce(jsonb_agg(to_jsonb(c) order by c.sort_order), '[]'::jsonb)
    from public.category_benchmarks c where c.active;
$cb$;
grant execute on function public.current_category_benchmarks() to anon, authenticated;

commit;
do $s$ begin raise notice 'Migration 151 OK - category_benchmarks seeded + readable.'; end$s$;
-- END migration 151
