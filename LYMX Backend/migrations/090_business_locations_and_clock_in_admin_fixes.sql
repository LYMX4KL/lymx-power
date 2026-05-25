-- 090_business_locations_and_clock_in_admin_fixes.sql
-- 2026-05-25 — Root-cause fix for the HR Clock-In workflow being unreachable.
--
-- BLOCKER CHAIN this resolves:
--   1. Admin approves a business → trigger flips approval_status only.
--      No `business_locations` row is created. Without a location, no geofence
--      exists, so no staff can clock in even after they're enrolled.
--   2. `business_locations` RLS allowed only the business OWNER full access.
--      Admins (acting on behalf of new owners) got RLS-denied 403s.
--   3. `clock_in_permissions` RLS allowed staff to INSERT their OWN row only.
--      HR/Admin could not grant a permission directly to a staff member.
--      Combined with #1, the entire request→approve loop was unreachable.
--   4. Already-approved businesses (e.g. Melong Merchandise V2, approved this
--      session) had no `business_locations` row — backfill needed.
--
-- After this migration:
--   - Admin can read/insert/update/delete `business_locations` for any business.
--   - Authenticated users can SELECT locations of approved businesses (clock-in
--     anchor pickers, geofence dropdowns, etc.).
--   - Approval auto-creates a default "Main location" row.
--   - Backfill creates a "Main location" for every existing approved business.
--   - HR/Admin can directly grant `clock_in_permissions` (the request-then-
--     approve loop still works for staff who self-submit).
--
-- This migration does NOT add address/lat/lng to the auto-created location —
-- that's owner-side work via biz-profile.html. The placeholder lets the
-- workflow advance; geofence accuracy is set by the owner when they fill in
-- real address + radius.

-- ===========================================================================
-- 1. business_locations: admin-can-do-anything + read for approved biz
-- ===========================================================================

drop policy if exists biz_loc_admin_all on public.business_locations;
create policy biz_loc_admin_all on public.business_locations
    for all to authenticated
    using (public.am_i_admin())
    with check (public.am_i_admin());

-- Allow any authenticated user to read locations of approved, non-archived
-- businesses. Needed so clock-in anchor pickers, employee-self-service pages,
-- and customer-facing "directions" links can list real addresses without
-- requiring the user to be the owner.
drop policy if exists biz_loc_public_read on public.business_locations;
create policy biz_loc_public_read on public.business_locations
    for select to authenticated
    using (
        archived_at is null
        and exists (
            select 1
              from public.businesses b
             where b.id = business_locations.business_id
               and b.approval_status = 'approved'
               and b.archived_at is null
        )
    );

-- (Existing biz_loc_owner_full_access stays — business owners still get
-- INSERT/UPDATE on their own locations through is_business_owner().)

-- ===========================================================================
-- 2. clock_in_permissions: HR/Admin can INSERT directly (not just review)
-- ===========================================================================

-- Drop the staff-only insert policy (it only allowed user_id = auth.uid()).
drop policy if exists cip_staff_insert on public.clock_in_permissions;

-- Replace with a single broader insert policy: either you're inserting your
-- own request (staff self-submit flow), or you're HR/Admin granting on behalf
-- of a staff member.
drop policy if exists cip_admin_or_self_insert on public.clock_in_permissions;
create policy cip_admin_or_self_insert on public.clock_in_permissions
    for insert to authenticated
    with check (
        public.am_i_hr_or_admin()
        OR user_id = auth.uid()
    );

-- ===========================================================================
-- 3. fn_on_business_approval — auto-create default location on approval
-- ===========================================================================

create or replace function public.fn_on_business_approval()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_loc_count integer;
begin
    -- ------------------------------------------------------------------
    -- A) Newly approved
    -- ------------------------------------------------------------------
    if new.approval_status = 'approved'
       and (old.approval_status is null or old.approval_status <> 'approved') then

        -- Original behavior: activate the business_partners bridge row.
        update public.business_partners
           set active = true,
               require_admin_approval = false,
               updated_at = now()
         where slug = new.slug;

        new.approved_at := coalesce(new.approved_at, now());

        -- NEW behavior (2026-05-25): create a default primary location so
        -- downstream geofence logic has something to anchor to. The owner
        -- will fill in real address + lat/lng + radius via biz-profile.html.
        select count(*) into v_loc_count
          from public.business_locations
         where business_id = new.id
           and archived_at is null;

        if v_loc_count = 0 then
            insert into public.business_locations (business_id, name, is_primary)
            values (new.id, 'Main location', true);
        end if;
    end if;

    -- ------------------------------------------------------------------
    -- B) Newly rejected
    -- ------------------------------------------------------------------
    if new.approval_status = 'rejected'
       and (old.approval_status is null or old.approval_status <> 'rejected') then
        update public.business_partners
           set active = false,
               updated_at = now()
         where slug = new.slug;
    end if;

    return new;
end $$;

-- Trigger definition unchanged from migration 035 — keep the original BEFORE
-- UPDATE OF approval_status trigger pointed at this same function name.

-- ===========================================================================
-- 4. Backfill: approved businesses that have no location yet
-- ===========================================================================

insert into public.business_locations (business_id, name, is_primary)
select b.id, 'Main location', true
  from public.businesses b
  left join public.business_locations bl
         on bl.business_id = b.id
        and bl.archived_at is null
 where b.approval_status = 'approved'
   and b.archived_at is null
   and bl.id is null;

-- ===========================================================================
-- 5. Sanity checks
-- ===========================================================================

do $$
declare
    cnt_missing_loc integer;
    cnt_policies integer;
begin
    -- 5a. Every approved business now has at least one non-archived location
    select count(*) into cnt_missing_loc
      from public.businesses b
     where b.approval_status = 'approved'
       and b.archived_at is null
       and not exists (
           select 1
             from public.business_locations bl
            where bl.business_id = b.id
              and bl.archived_at is null
       );
    if cnt_missing_loc <> 0 then
        raise exception 'Migration 090 incomplete: % approved businesses still have no location.', cnt_missing_loc;
    end if;

    -- 5b. The four expected policies exist
    select count(*) into cnt_policies
      from pg_policies
     where schemaname = 'public'
       and (
            (tablename = 'business_locations'   and policyname in ('biz_loc_admin_all', 'biz_loc_public_read'))
         or (tablename = 'clock_in_permissions' and policyname = 'cip_admin_or_self_insert')
       );
    if cnt_policies < 3 then
        raise exception 'Migration 090 incomplete: expected 3 new policies, found %.', cnt_policies;
    end if;
end $$;
