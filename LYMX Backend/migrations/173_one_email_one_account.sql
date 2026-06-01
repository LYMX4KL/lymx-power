-- =============================================================================
-- Migration 173 — one email = one account (enforce + clean up the existing dup)
-- =============================================================================
-- Bug (Kenny, 2026-06-01): two partner accounts existed under one email
-- (zhongkennylin@gmail.com) — P-000001 "Kenny Lin" (the real account) and
-- P-000110 "Test Partner", each on a DIFFERENT auth user. Nothing stopped a
-- second profile row from claiming an email already in use.
--
-- Root cause: the partner/customer profile tables had NO uniqueness on email,
-- so the same email could back multiple accounts. (Supabase Auth normally keeps
-- auth.users email unique; the profile layer never mirrored that guarantee.)
--
-- Fix (two parts):
--   1. Clean up the existing duplicate — archive the leftover test partner
--      P-000110 (verified: no downline, no mgc_tree descendants, no commissions,
--      no settlements — safe to archive, non-destructive).
--   2. Enforce going forward — a case-insensitive partial UNIQUE index on the
--      active (non-archived) rows of partners.contact_email and customers.email.
--      Any future attempt to create a second active account for an email now
--      fails at the database, regardless of which code path tries it.
--
-- Note (manual, dashboard): also set Supabase Auth -> Sign In / Providers ->
-- "Allow duplicate emails" = OFF so a second auth.users can't be created for an
-- email in the first place. The orphan auth user behind P-000110
-- (3ee368fc-1f5b-41e4-862d-48f5759b5434) can be deleted in Auth -> Users.
-- =============================================================================

-- 1) Clean up the existing duplicate (archive, don't delete — non-destructive).
update public.partners
   set archived_at = now(),
       archived_by = '1405bb50-2c97-48dd-bfa5-31f32320de9b',  -- Kenny (admin running this)
       verification_notes = coalesce(verification_notes || ' | ', '')
                            || 'Archived 2026-06-01 (mig 173): duplicate account on zhongkennylin@gmail.com; P-000001 is the canonical account.'
 where partner_code = 'P-000110'
   and archived_at is null;

-- 2a) Enforce one ACTIVE partner per email (case-insensitive).
create unique index if not exists uq_partners_contact_email_active
    on public.partners (lower(contact_email))
    where archived_at is null and contact_email is not null;

-- 2b) Enforce one ACTIVE customer per email (case-insensitive).
create unique index if not exists uq_customers_email_active
    on public.customers (lower(email))
    where archived_at is null and email is not null;

-- Sanity: confirm no active duplicates remain and the indexes exist.
do $sanity$
declare
    v_partner_dupes int;
    v_customer_dupes int;
begin
    select count(*) into v_partner_dupes from (
        select lower(contact_email) e
        from public.partners
        where archived_at is null and contact_email is not null
        group by 1 having count(*) > 1
    ) d;
    select count(*) into v_customer_dupes from (
        select lower(email) e
        from public.customers
        where archived_at is null and email is not null
        group by 1 having count(*) > 1
    ) d;
    if v_partner_dupes > 0 then
        raise exception 'Migration 173: % active partner email duplicates remain — resolve before enforcing', v_partner_dupes;
    end if;
    if v_customer_dupes > 0 then
        raise exception 'Migration 173: % active customer email duplicates remain — resolve before enforcing', v_customer_dupes;
    end if;
    if not exists (select 1 from pg_indexes where indexname = 'uq_partners_contact_email_active')
       or not exists (select 1 from pg_indexes where indexname = 'uq_customers_email_active') then
        raise exception 'Migration 173 failed: uniqueness indexes not created';
    end if;
    raise notice 'Migration 173 OK — duplicate archived; one-email-one-account now enforced on partners + customers.';
end $sanity$;
