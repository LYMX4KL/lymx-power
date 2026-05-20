-- =============================================================================
-- Migration 065 — admin read access for feedback-screenshots bucket
-- 2026-05-20 (v3 — flat single-line EXECUTE, no nested dollar-quotes)
-- =============================================================================
--
-- Restores admin read access to the feedback-screenshots bucket. Uploads via
-- service_role (feedback-submit EF) work fine; admin JWTs were silently
-- failing on sign-URL because no SELECT policy on storage.objects existed
-- for these buckets. Every screenshot Rae/Helen/Rachel attached looked lost
-- because of this gap.
--
-- v3 rewrites with:
--   * No DROP POLICY (avoids ownership conflicts on storage.objects)
--   * IF NOT EXISTS check via pg_policies before each CREATE
--   * Single-line EXECUTE strings (no nested $sql$ ... $sql$ pairs)
--   * Each DO block named with a unique tag per the named-dollar-quote rule
--
-- Idempotent.
-- =============================================================================

-- 1) feedback-screenshots — create SELECT policy for admins if missing.
do $migration_065_screenshots$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'storage'
          and tablename  = 'objects'
          and policyname = 'admins read feedback-screenshots'
    ) then
        execute 'create policy "admins read feedback-screenshots" on storage.objects for select to authenticated using (bucket_id = ''feedback-screenshots'' and (auth.uid() = ''1405bb50-2c97-48dd-bfa5-31f32320de9b''::uuid or exists (select 1 from public.staff_roles where user_id = auth.uid() and role in (''admin'',''tech'',''support''))))';
        raise notice 'Created policy "admins read feedback-screenshots".';
    else
        raise notice 'Policy "admins read feedback-screenshots" already exists — skipping.';
    end if;
exception when insufficient_privilege then
    raise notice 'Insufficient privilege to add storage.objects policy via SQL. Use the Supabase dashboard Storage > Policies UI instead.';
end $migration_065_screenshots$;

-- 2) feedback-attachments — same shape.
do $migration_065_attachments$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'storage'
          and tablename  = 'objects'
          and policyname = 'admins read feedback-attachments'
    ) then
        execute 'create policy "admins read feedback-attachments" on storage.objects for select to authenticated using (bucket_id = ''feedback-attachments'' and (auth.uid() = ''1405bb50-2c97-48dd-bfa5-31f32320de9b''::uuid or exists (select 1 from public.staff_roles where user_id = auth.uid() and role in (''admin'',''tech'',''support''))))';
        raise notice 'Created policy "admins read feedback-attachments".';
    else
        raise notice 'Policy "admins read feedback-attachments" already exists — skipping.';
    end if;
exception when insufficient_privilege then
    raise notice 'Insufficient privilege to add storage.objects policy via SQL. Use the Supabase dashboard Storage > Policies UI instead.';
end $migration_065_attachments$;

-- 3) Ensure the bucket itself exists with the right config.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'feedback-screenshots',
    'feedback-screenshots',
    false,
    10 * 1024 * 1024,
    array['image/png','image/jpeg','image/jpg','image/webp','image/gif']::text[]
)
on conflict (id) do update set
    file_size_limit    = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
