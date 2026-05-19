-- =============================================================================
-- Migration 008 — Feedback inbox (Send Feedback button + admin Tech Support)
-- =============================================================================
-- Adds the feedback table, RLS policies, and a storage bucket for screenshots.
-- Modeled after InvestPro's Tech Support pattern.
--
-- Anyone (anonymous OR authenticated) can submit feedback. Admins can read +
-- update everything. For v1, "admin" is hard-coded to Kenny's user_id; later
-- we can move to a user_metadata.is_admin flag.
-- =============================================================================

create table if not exists public.feedback (
    id              uuid primary key default uuid_generate_v4(),

    -- Who submitted (nullable for anonymous)
    user_id         uuid references auth.users(id) on delete set null,
    user_role       text,                  -- 'customer' | 'business' | 'partner' | 'anonymous'
    user_email      text,                  -- copied at submit time so we can reply

    -- What they said
    type            text not null check (type in ('bug','suggestion','question','general')),
    priority        text not null default 'normal' check (priority in ('urgent','high','normal','low')),
    subject         text,
    message         text not null check (char_length(message) >= 10),

    -- Where they were
    page_url        text not null,
    cluster         text,                  -- auto-categorized server-side from page_url
    user_agent      text,
    viewport        text,                  -- e.g. '1920x1080'

    -- Optional screenshot (Supabase Storage path)
    screenshot_path text,

    -- Triage state
    status          text not null default 'new' check (status in ('new','in_progress','resolved','wontfix')),
    resolved_at     timestamptz,
    resolved_by     uuid references auth.users(id),
    admin_notes     text,

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists idx_feedback_status_priority on public.feedback(status, priority, created_at desc);
create index if not exists idx_feedback_cluster        on public.feedback(cluster);
create index if not exists idx_feedback_user           on public.feedback(user_id);

-- ----- updated_at trigger ----------------------------------------------------
create or replace function public.set_feedback_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists feedback_updated_at on public.feedback;
create trigger feedback_updated_at
    before update on public.feedback
    for each row execute function public.set_feedback_updated_at();

-- ----- RLS -------------------------------------------------------------------
alter table public.feedback enable row level security;

-- Anyone authenticated can submit
drop policy if exists feedback_insert_authenticated on public.feedback;
create policy feedback_insert_authenticated on public.feedback
    for insert to authenticated
    with check (user_id is null or user_id = auth.uid());

-- Anonymous via the anon key can also submit (no user_id)
drop policy if exists feedback_insert_anon on public.feedback;
create policy feedback_insert_anon on public.feedback
    for insert to anon
    with check (user_id is null);

-- Submitter can read their own feedback
drop policy if exists feedback_select_own on public.feedback;
create policy feedback_select_own on public.feedback
    for select to authenticated
    using (user_id = auth.uid());

-- Admin (hard-coded to Kenny for v1) can read + update everything
drop policy if exists feedback_admin_all on public.feedback;
create policy feedback_admin_all on public.feedback
    for all to authenticated
    using (auth.uid() = '1405bb50-2c97-48dd-bfa5-31f32320de9b'::uuid)
    with check (auth.uid() = '1405bb50-2c97-48dd-bfa5-31f32320de9b'::uuid);

-- ----- Storage bucket for screenshots ----------------------------------------
-- Note: bucket creation in Supabase is normally done via the Storage UI or the
-- supabase-js admin API. The SQL approach below works in newer versions but
-- may error on older ones — if so, just create a 'feedback-screenshots' bucket
-- manually via Supabase dashboard → Storage → New bucket (private).
do $$ begin
  insert into storage.buckets (id, name, public)
  values ('feedback-screenshots', 'feedback-screenshots', false)
  on conflict (id) do nothing;
exception when others then
  raise notice 'Skipped storage bucket creation (do it via UI if needed): %', sqlerrm;
end $$;

-- ----- Grants ----------------------------------------------------------------
grant insert on public.feedback to authenticated, anon;
grant select on public.feedback to authenticated;
grant update on public.feedback to authenticated;
