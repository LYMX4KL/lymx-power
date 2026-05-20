-- =============================================================================
-- Migration 065 — admin read access for feedback-screenshots bucket
-- 2026-05-20
-- =============================================================================
--
-- The `feedback-screenshots` bucket has been silently failing admin reads for
-- weeks. Uploads via the feedback-submit Edge Function (service_role) work
-- fine — the files ARE in storage. But admin JWTs hit "Object not found" when
-- signing URLs because no RLS policy on storage.objects grants them SELECT.
-- Result: every screenshot Rae, Helen, Rachel attached looked "lost".
--
-- Root cause: migration 008 created the private bucket but never added an
-- admin-read policy. Tickets like d7913fb6 ("errors" + screenshot) became
-- unactionable because we couldn't see what the tester was seeing.
--
-- This migration:
--   1. Grants storage.objects SELECT to admins for the feedback-screenshots bucket
--   2. Same for feedback-attachments (the v2 multi-attachment bucket)
--   3. Idempotent — drops and recreates so it can be re-run safely
--
-- Admin detection: hardcoded admin UUID + staff_roles.role in ('admin','tech').
-- =============================================================================

-- 1) Drop any prior policies with these exact names
drop policy if exists "admins read feedback-screenshots"  on storage.objects;
drop policy if exists "admins read feedback-attachments"  on storage.objects;

-- 2) Allow admins to SELECT objects in the feedback-screenshots bucket
create policy "admins read feedback-screenshots"
    on storage.objects
    for select
    to authenticated
    using (
        bucket_id = 'feedback-screenshots'
        and (
            auth.uid() = '1405bb50-2c97-48dd-bfa5-31f32320de9b'::uuid       -- hardcoded admin
            or exists (
                select 1 from public.staff_roles
                where user_id = auth.uid()
                  and role in ('admin', 'tech', 'support')
            )
        )
    );

-- 3) Same policy for the feedback-attachments bucket (v2 multi-file attachments)
create policy "admins read feedback-attachments"
    on storage.objects
    for select
    to authenticated
    using (
        bucket_id = 'feedback-attachments'
        and (
            auth.uid() = '1405bb50-2c97-48dd-bfa5-31f32320de9b'::uuid
            or exists (
                select 1 from public.staff_roles
                where user_id = auth.uid()
                  and role in ('admin', 'tech', 'support')
            )
        )
    );

-- 4) Ensure the bucket itself exists (idempotent — bucket may have been
--    created via Supabase UI rather than migration 008, so make sure).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'feedback-screenshots',
    'feedback-screenshots',
    false,
    10 * 1024 * 1024,
    array['image/png','image/jpeg','image/jpg','image/webp','image/gif']::text[]
)
on conflict (id) do update set
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
