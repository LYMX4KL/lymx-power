-- =============================================================================
-- Migration 134 — Canonical identity: propagate the hired person's full name
--                 into auth.users.raw_user_meta_data->>'full_name'
-- =============================================================================
-- ARCHITECTURE-RULES Rule 1a: hiring is the single source of truth; identity
-- propagates everywhere. The whole codebase already reads names from
-- auth.users.raw_user_meta_data->>'full_name' (mig 060 admin_list_user_emails,
-- v_team_roster, conversations, personnel records, etc.), but the HIRING flow
-- never wrote it — so staff showed as email/uid (the admin-manage-permissions
-- "2d32a692" bug, and blank names elsewhere).
--
-- This migration:
--   (1) On offer-accept, writes the hired name from job_applications into the
--       canonical metadata field (so future hires propagate automatically).
--   (2) Backfills existing users missing a real name, sourcing from
--       hiring (job_applications by email) -> partners.legal_name/display_name
--       -> customers.display_name.
--
-- NON-DESTRUCTIVE: only sets full_name when it is currently blank OR equals the
-- email (i.e., never a real name yet). Re-runnable / idempotent.
--
-- auth.users updates run as the migration owner (postgres) and inside a
-- SECURITY DEFINER trigger owned by postgres — both have rights on auth.users.
-- =============================================================================

-- ---------- (1) On-hire propagation -----------------------------------------
create or replace function public.tg_offer_accepted_sync_name()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $sync$
declare
  v_uid  uuid;
  v_name text;
begin
  if NEW.status = 'accepted' and (OLD.status is distinct from 'accepted') then
    select ja.applicant_profile_id,
           btrim(coalesce(ja.first_name,'') || ' ' || coalesce(ja.last_name,''))
      into v_uid, v_name
      from public.job_applications ja
     where ja.id = NEW.application_id;

    v_uid := coalesce(NEW.applicant_profile_id, v_uid);

    if v_uid is not null and v_name is not null and btrim(v_name) <> '' then
      update auth.users u
         set raw_user_meta_data = coalesce(u.raw_user_meta_data, '{}'::jsonb)
                                  || jsonb_build_object('full_name', v_name)
       where u.id = v_uid
         and coalesce(u.raw_user_meta_data->>'full_name','') in ('', u.email);
    end if;
  end if;
  return NEW;
end$sync$;

drop trigger if exists trg_offer_accepted_sync_name on public.offers;
create trigger trg_offer_accepted_sync_name
  after update on public.offers
  for each row execute function public.tg_offer_accepted_sync_name();

-- ---------- (2) Backfill existing users -------------------------------------
do $backfill$
declare
  r      record;
  v_name text;
begin
  for r in select u.id, u.email, coalesce(u.raw_user_meta_data->>'full_name','') as cur
             from auth.users u loop
    -- already has a real name? skip
    if r.cur <> '' and r.cur <> r.email then
      continue;
    end if;

    v_name := null;

    -- a) hiring application (by email, most recent)
    select btrim(coalesce(ja.first_name,'') || ' ' || coalesce(ja.last_name,''))
      into v_name
      from public.job_applications ja
     where lower(ja.email) = lower(r.email)
       and btrim(coalesce(ja.first_name,'') || coalesce(ja.last_name,'')) <> ''
     order by ja.submitted_at desc
     limit 1;

    -- b) partners legal/display name
    if v_name is null or btrim(v_name) = '' then
      select coalesce(nullif(btrim(p.legal_name),''), nullif(btrim(p.display_name),''))
        into v_name
        from public.partners p
       where p.user_id = r.id
         and coalesce(nullif(btrim(p.legal_name),''), nullif(btrim(p.display_name),'')) is not null
       limit 1;
    end if;

    -- c) customers display name
    if v_name is null or btrim(v_name) = '' then
      select nullif(btrim(c.display_name),'')
        into v_name
        from public.customers c
       where c.user_id = r.id
       limit 1;
    end if;

    if v_name is not null and btrim(v_name) <> '' then
      update auth.users u
         set raw_user_meta_data = coalesce(u.raw_user_meta_data, '{}'::jsonb)
                                  || jsonb_build_object('full_name', v_name)
       where u.id = r.id;
    end if;
  end loop;
end$backfill$;

-- ---------- Sanity ----------------------------------------------------------
do $sanity$
declare v_named int; v_total int;
begin
  select count(*) into v_total from auth.users;
  select count(*) into v_named from auth.users
   where coalesce(raw_user_meta_data->>'full_name','') not in ('', email);
  raise notice 'Migration 134 OK - % of % users now have a real full_name.', v_named, v_total;
end$sanity$;
-- =============================================================================
-- END migration 134
-- =============================================================================
