-- =============================================================================
-- Migration 039 — Per-message translations on conversation_messages
-- =============================================================================
-- Adds `translations` jsonb column so each message can cache translations into
-- multiple target locales without re-hitting the API. Shape:
--   { "es": { "body": "...", "subject_line": "...", "translated_at": "..." },
--     "zh-CN": { ... }, ... }
-- =============================================================================

alter table public.conversation_messages
    add column if not exists translations jsonb not null default '{}'::jsonb,
    add column if not exists source_locale text;

create index if not exists idx_conv_messages_has_translations
    on public.conversation_messages((translations <> '{}'::jsonb));

comment on column public.conversation_messages.translations  is 'Cached translations keyed by target locale. See migration 039.';
comment on column public.conversation_messages.source_locale is 'IETF tag of the original message body (auto-detected at send time).';


-- ===== Verify =============================================================
select 'migration 039 applied' as status,
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='conversation_messages'
           and column_name in ('translations','source_locale')) as new_columns_present;
