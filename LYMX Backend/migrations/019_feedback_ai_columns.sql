-- =============================================================================
-- Migration 019 — Feedback widget v2 columns (AI polish, page title, screenshot kind)
-- Created: 2026-05-14
-- =============================================================================
-- Adds the new columns the v2 feedback widget writes:
--   * original_message  — user's pre-AI-polish text (preserved when they hit
--                         "✨ Improve with AI"). Lets us audit what the user
--                         actually typed vs. what the AI rewrote.
--   * ai_summary        — 1-line summary the AI produced. Shown on admin
--                         triage cards alongside the full message.
--   * page_title        — document.title at submit time. Useful when the URL
--                         is opaque (e.g. /portal/some-uuid).
--   * screenshot_kind   — how the screenshot was captured: 'auto' (full page),
--                         'region' (user-cropped), 'upload' (file from disk).
-- =============================================================================

alter table public.feedback
    add column if not exists original_message  text,
    add column if not exists ai_summary        text,
    add column if not exists page_title        text,
    add column if not exists screenshot_kind   text
        check (screenshot_kind is null or screenshot_kind in ('auto','region','upload'));

comment on column public.feedback.original_message is
    'Raw user-typed message before AI Polish replaced it (null if AI was not used).';
comment on column public.feedback.ai_summary is
    '1-line summary from the AI Polish/Categorize endpoint, for triage dashboard.';
comment on column public.feedback.page_title is
    'document.title at submit time. Useful when URL alone is opaque.';
comment on column public.feedback.screenshot_kind is
    'How the screenshot was captured: auto (full-page) | region (user-cropped) | upload (file).';

-- Index for the admin triage view that sorts by ai_summary
create index if not exists idx_feedback_ai_summary
    on public.feedback(ai_summary) where ai_summary is not null;
