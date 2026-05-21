-- =============================================================================
-- Migration 065 — admin read access for feedback bucket(s)
--
-- 2026-05-20 (v3) — inline `exists (select 1 from public.staff_roles ...)` in storage.objects USING expr
-- 2026-05-21 (v4-v5) — tried search_path / DROP+CREATE — both still failed with "relation public.staff_roles does not exist"
-- 2026-05-21 (v6) — ROOT CAUSE FIX
--
-- Storage policies on storage.objects are compiled against the storage schema
-- context. Even when the SQL editor's session has `search_path = public,
-- storage`, the policy USING expression is RE-PARSED by Postgres at CREATE
-- time in a context where `public.staff_roles` is not visible — possibly
-- because the supabase_storage_admin role (which owns storage.objects) has
-- restricted catalog visibility to public tables.
--
-- The canonical workaround used everywhere in the Supabase docs: wrap the
-- public-schema lookup in a SECURITY DEFINER function in public. Then the
-- storage policy just calls the function. Function body executes at query
-- time with the function OWNER's privileges (postgres), which has full
-- visibility into public.staff_roles. No parse-time cross-schema barrier.
--
-- This same pattern was already used elsewhere in the codebase via
-- public.am_i_admin() (see [[reference-lymx-db-gotchas]]). Adding a sibling
-- helper public.can_read_feedback_storage() for the specific role-set this
-- policy needs (admin/tech/support — am_i_admin only checks 'admin').
-- =============================================================================

-- 1) SECURITY DEFINER helper. Returns true if the calling JWT auth.uid()
--    is Kenny (P-000001 owner) OR has a staff_roles row with role in
--    ('admin','tech','support').
create or replace function public.can_read_feedback_storage()
returns boolean
language plpgsql
security definer
set search_path = public
as $can_read_feedback_storage$
begin
    if auth.uid() = '1405bb50-2c97-48dd-bfa5-31f32320de9b'::uuid then
        return true;
    end if;
    return exists (
        select 1
          from public.staff_roles
         where user_id = auth.uid()
           and role in ('admin','tech','support')
    );
end
$can_read_feedback_storage$;

-- Lock down EXECUTE to authenticated only (anon doesn't need this).
revoke all on function public.can_read_feedback_storage() from public;
grant execute on function public.can_read_feedback_storage() to authenticated, service_role;

-- 2) feedback-screenshots — admin read policy via the helper.
drop policy if exists "admins read feedback-screenshots" on storage.objects;
create policy "admins read feedback-screenshots"
    on storage.objects
    for select
    to authenticated
    using (
        bucket_id = 'feedback-screenshots'
        and public.can_read_feedback_storage()
    );

-- 3) feedback-attachments — same shape.
drop policy if exists "admins read feedback-attachments" on storage.objects;
create policy "admins read feedback-attachments"
    on storage.objects
    for select
    to authenticated
    using (
        bucket_id = 'feedback-attachments'
        and public.can_read_feedback_storage()
    );

-- 4) Ensure the bucket itself exists with the right config.
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
