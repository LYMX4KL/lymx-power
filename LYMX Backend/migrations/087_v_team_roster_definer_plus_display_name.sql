-- =============================================================================
-- Migration 087 — v_team_roster: drop invoker mode + add display_name
-- =============================================================================
-- Two bugs Helen ran into on /admin-timesheets.html (ticket #cc6b5fb8):
--   (1) The page reads /rest/v1/v_team_roster to map user_id -> email so it
--       can show employee names next to each clock event. But v_team_roster
--       was created with `security_invoker = on`, which means the SELECT
--       runs as the authenticated caller. authenticated cannot SELECT
--       auth.users in RLS context (same root cause as the event_rsvps fix
--       in migration 086), so Helen got an empty roster — the page silently
--       fell back to a 8-char UUID slice rendered as "Staff#…".
--   (2) Even if she had read the view successfully, it only exposes `email`,
--       not the person's actual display name. So the column would still
--       show inboxes instead of "Helen Chen".
--
-- Fix:
--   - Recreate the view WITHOUT security_invoker. Default view semantics
--     (definer) mean the view runs as the postgres role that owns it →
--     has full access to auth.users and the staff_* tables.
--   - Gate the row set with `where public.am_i_admin()` so non-admin
--     authenticated users still see nothing. That keeps the view from
--     becoming a sideways data leak.
--   - LEFT JOIN public.staff_profiles to expose the canonical `title`
--     (e.g. "Helen Chen", "Dave Spencer") as `display_name`. Fall back
--     to job_title / email-local-part so the column is never blank.
-- =============================================================================

drop view if exists public.v_team_roster cascade;

create or replace view public.v_team_roster as
select
    u.id                                                              as user_id,
    u.email,
    -- Prefer the HR-canonical title, then the role's job_title, then the
    -- email-local-part. Never null.
    coalesce(
        nullif(trim(sp.title), ''),
        nullif(trim(sr.job_title), ''),
        split_part(u.email, '@', 1)
    )                                                                 as display_name,
    coalesce(sr.job_title, sr.role)                                   as job_title,
    sr.role,
    sr.is_cfo,
    sr.is_hr,
    sr.employment_type,
    sr.hire_date,
    sr.remote_allowed,
    sr.geofence_radius_m,
    (sr.home_office_lat is not null)                                  as has_anchor,
    (
        select max(event_at) from public.clock_events ce
         where ce.user_id = u.id and ce.event_type = 'in'
    )                                                                 as last_clock_in
  from auth.users u
  join public.staff_roles sr     on sr.user_id = u.id
  left join public.staff_profiles sp on sp.user_id = u.id
 where public.am_i_admin()        -- only admins see the full roster
 order by sr.role, u.email;

-- IMPORTANT: do NOT set security_invoker = on. The point of this migration
-- is to run the view as definer (postgres), which can read auth.users.
-- We protect access via the am_i_admin() filter inside the view.
grant select on public.v_team_roster to authenticated;
