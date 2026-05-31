-- =============================================================================
-- Migration 169 — Hero headline A/B tracking (10-day rotation, measure winner)
-- =============================================================================
-- The Home page rotates its hero headline across an inventory every 10 days.
-- To know which headline performs best, we log per-variant events:
--   view   — the headline was shown (one per page load)
--   search — visitor used the hero Search
--   cta    — visitor clicked a conversion link (For Business / Become a Partner /
--            Sign in / a business storefront)
-- Writes go through a SECURITY DEFINER RPC (anon-callable, validates the event),
-- so the table needs no open INSERT policy. Admin reads aggregates via a stats RPC.
-- Idempotent.
-- =============================================================================

create table if not exists public.headline_events (
  id            bigint generated always as identity primary key,
  variant_idx   int  not null,
  variant_label text,
  event         text not null check (event in ('view','search','cta')),
  created_at    timestamptz not null default now()
);
create index if not exists headline_events_variant_idx on public.headline_events(variant_idx);
create index if not exists headline_events_created_idx  on public.headline_events(created_at);

alter table public.headline_events enable row level security;
-- No direct policies: all writes via log_headline_event(), all reads via headline_ab_stats().

create or replace function public.log_headline_event(p_variant int, p_label text, p_event text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_event is null or p_event not in ('view','search','cta') then
    return;  -- ignore junk, fail-safe
  end if;
  insert into public.headline_events (variant_idx, variant_label, event)
  values (greatest(coalesce(p_variant, 0), 0), left(coalesce(p_label, ''), 200), p_event);
end;
$$;
revoke all on function public.log_headline_event(int, text, text) from public;
grant execute on function public.log_headline_event(int, text, text) to anon, authenticated;

create or replace function public.headline_ab_stats()
returns table (
  variant_idx   int,
  variant_label text,
  views         bigint,
  searches      bigint,
  ctas          bigint,
  search_rate   numeric,
  cta_rate      numeric,
  first_seen    timestamptz,
  last_seen     timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    variant_idx,
    max(variant_label) as variant_label,
    count(*) filter (where event = 'view')   as views,
    count(*) filter (where event = 'search') as searches,
    count(*) filter (where event = 'cta')    as ctas,
    round(100.0 * count(*) filter (where event = 'search')
          / nullif(count(*) filter (where event = 'view'), 0), 1) as search_rate,
    round(100.0 * count(*) filter (where event = 'cta')
          / nullif(count(*) filter (where event = 'view'), 0), 1) as cta_rate,
    min(created_at) as first_seen,
    max(created_at) as last_seen
  from public.headline_events
  group by variant_idx
  order by variant_idx;
$$;
revoke all on function public.headline_ab_stats() from public;
grant execute on function public.headline_ab_stats() to authenticated;

notify pgrst, 'reload schema';

do $s$ begin raise notice 'Migration 169 OK - headline A/B tracking ready.'; end$s$;
-- END migration 169
