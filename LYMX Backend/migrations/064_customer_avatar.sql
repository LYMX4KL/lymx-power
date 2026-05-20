-- =============================================================================
-- Migration 064 — customer + partner avatar_url + Storage bucket policy
-- 2026-05-20
-- =============================================================================
--
-- Adds `avatar_url` (text) to `customers` and (idempotently) to `partners`,
-- creates the `avatars` public Storage bucket, and installs RLS policies so
-- each authenticated user can upload / replace / delete ONLY their own file
-- under a path of the form  <user_id>/<anything>.
--
-- Display rule: avatar_url points to the public URL of the uploaded object.
-- Reads are public (so reviews, partner cards, and the nav chip can show the
-- photo without auth), writes are user-scoped.
--
-- Fixes a461daa8 (Rae — Profile photo upload feature).
--
-- Idempotent. Safe to re-run.
-- =============================================================================

-- 1) Schema columns -----------------------------------------------------------
alter table public.customers
    add column if not exists avatar_url text;

alter table public.partners
    add column if not exists avatar_url text;

comment on column public.customers.avatar_url is
  'Public URL of user-uploaded avatar in the `avatars` storage bucket. Null = use initials fallback.';
comment on column public.partners.avatar_url is
  'Public URL of user-uploaded avatar in the `avatars` storage bucket. Null = use initials fallback.';

-- 2) Storage bucket (idempotent insert) --------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'avatars',
    'avatars',
    true,                                                -- public reads
    5 * 1024 * 1024,                                     -- 5 MB per file
    array['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']::text[]
)
on conflict (id) do update set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- 3) RLS policies on storage.objects for the avatars bucket -------------------
-- Drop-then-create so re-running the migration overwrites stale versions.

drop policy if exists "avatars public read"            on storage.objects;
drop policy if exists "avatars own write insert"       on storage.objects;
drop policy if exists "avatars own write update"       on storage.objects;
drop policy if exists "avatars own write delete"       on storage.objects;

-- Public reads (anyone, including anon)
create policy "avatars public read"
    on storage.objects
    for select
    using (bucket_id = 'avatars');

-- Only the owner (path prefix = their user id) can insert
create policy "avatars own write insert"
    on storage.objects
    for insert
    to authenticated
    with check (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

-- Only the owner can update their own object
create policy "avatars own write update"
    on storage.objects
    for update
    to authenticated
    using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

-- Only the owner can delete their own object
create policy "avatars own write delete"
    on storage.objects
    for delete
    to authenticated
    using (
        bucket_id = 'avatars'
        and (storage.foldername(name))[1] = auth.uid()::text
    );
