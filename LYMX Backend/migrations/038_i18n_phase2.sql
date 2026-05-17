-- =============================================================================
-- Migration 038 — i18n Phase 2: locale storage + translation cache
-- =============================================================================
-- Adds per-user language preference (customers + businesses + partners) and a
-- server-side translation cache so we never re-translate the same string.
--
-- Supported locales (must match lymx-i18n.js SUPPORTED):
--   en, es, zh-CN, zh-TW, ko, ja
-- =============================================================================

-- ===== 1. preferred_locale columns =========================================
alter table public.customers   add column if not exists preferred_locale text;
alter table public.businesses  add column if not exists preferred_locale text;
alter table public.partners    add column if not exists preferred_locale text;

create index if not exists idx_customers_locale  on public.customers(preferred_locale)  where preferred_locale is not null;
create index if not exists idx_businesses_locale on public.businesses(preferred_locale) where preferred_locale is not null;
create index if not exists idx_partners_locale   on public.partners(preferred_locale)   where preferred_locale is not null;

comment on column public.customers.preferred_locale  is 'IETF tag (en, es, zh-CN, zh-TW, ko, ja). NULL = infer from browser.';
comment on column public.businesses.preferred_locale is 'IETF tag for owner-facing email/SMS. NULL = inherit from owner_user_id customer record.';
comment on column public.partners.preferred_locale   is 'IETF tag for partner-facing email/SMS.';


-- ===== 2. translation_cache table ==========================================
-- A content-addressed cache so the same text+target_locale tuple is only
-- translated ONCE (across all senders/users). Massive cost saver.
create table if not exists public.translation_cache (
    id              uuid primary key default uuid_generate_v4(),
    text_hash       text not null,                         -- sha256 of source text
    source_locale   text not null,                         -- 'en', 'auto', etc.
    target_locale   text not null,                         -- 'es', 'zh-CN', etc.
    source_text     text not null,
    translated_text text not null,
    provider        text not null,                         -- 'deepl' | 'google' | 'claude-haiku'
    char_count      int  not null,                         -- for cost accounting
    created_at      timestamptz not null default now(),
    last_used_at    timestamptz not null default now(),
    use_count       int  not null default 1,
    unique (text_hash, source_locale, target_locale)
);

create index if not exists idx_translation_cache_hash on public.translation_cache(text_hash);
create index if not exists idx_translation_cache_lookup on public.translation_cache(text_hash, source_locale, target_locale);

-- Anyone authenticated can SELECT translations (no secrets in here, just human text).
alter table public.translation_cache enable row level security;
drop policy if exists translation_cache_read on public.translation_cache;
create policy translation_cache_read on public.translation_cache
    for select to authenticated using (true);

-- Inserts only via service role (the translate-text Edge Function).
grant select on public.translation_cache to authenticated;


-- ===== 3. fn_resolve_recipient_locale ======================================
-- Helper used by every sender Edge Function to pick the right locale for a
-- given user. Lookup chain: customers → businesses → partners → 'en' default.
create or replace function public.fn_resolve_recipient_locale(p_user_id uuid)
returns text
language sql
stable
security definer
as $$
    select coalesce(
        (select preferred_locale from public.customers   where user_id      = p_user_id and preferred_locale is not null limit 1),
        (select preferred_locale from public.businesses  where owner_user_id = p_user_id and preferred_locale is not null limit 1),
        (select preferred_locale from public.partners    where user_id      = p_user_id and preferred_locale is not null limit 1),
        'en'
    );
$$;
grant execute on function public.fn_resolve_recipient_locale(uuid) to authenticated;


-- ===== 4. Verify ===========================================================
select 'migration 038 applied' as status,
       (select count(*) from information_schema.columns
         where table_schema='public' and column_name='preferred_locale'
           and table_name in ('customers','businesses','partners')) as locale_columns_present,
       (select count(*) from information_schema.tables
         where table_schema='public' and table_name='translation_cache') as cache_table_present,
       (select count(*) from pg_proc where proname='fn_resolve_recipient_locale') as helper_fn_present;
