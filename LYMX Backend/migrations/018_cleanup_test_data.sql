-- =============================================================================
-- Migration 018 — Clean pre-launch test data from production
-- Created: 2026-05-13
-- =============================================================================
-- Removes test rows that polluted the DB during the smoke-test phase.
-- Site is now live and accepting real signups — these test rows must go so
-- everyone is working from one clean platform.
--
-- WHAT THIS DELETES:
--   * 4 fake partners (Smoke Test Partner, Helen testrun, Helen Smoketest x2)
--   * Their downline tree edges, commissions, settlements
--   * All businesses with smoketest contact_email or smoketest display_name
--   * All customers backed by smoketest auth.users
--   * All wallets + transactions for those businesses/customers
--   * All auth.users with smoketest email patterns
--
-- WHAT THIS KEEPS:
--   * Kenny Lin (partner 6c77dcf1-...) — real Partner #1
--   * Dave Bacay (partner 57902e3f-...) — real Partner
--   * InvestPro Realty business_partner row
--   * 647 contacts in contacts table (Kenny's imported address book)
--   * All migrations / RPCs / triggers / policies (only data is cleaned)
--
-- SAFETY:
--   * Wrapped in BEGIN/COMMIT — if any DELETE fails the whole thing rolls back
--   * RAISE NOTICE prints counts before + after so you can see what happened
--   * Hard-coded exclusion for zhongkennylin@gmail.com + davebacaywork@gmail.com
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Identify the fake partner UUIDs (from the audit)
-- -----------------------------------------------------------------------------
create temp table _fake_partner_ids (id uuid primary key) on commit drop;
insert into _fake_partner_ids values
    ('6f8f0525-7a31-4676-ab29-857ec4fad4f8'),  -- Smoke Test Partner (2026-05-07)
    ('a08e78bb-ea7f-4726-8c49-b6d970b5d61e'),  -- Helen testrun (per Kenny: delete)
    ('adde36cd-636e-4ab8-bb6a-350e30c60b60'),  -- Helen Smoketest dup #1
    ('616daef2-6f93-4dad-bd69-c00b59c58f13');  -- Helen Smoketest dup #2

-- -----------------------------------------------------------------------------
-- 2. Identify fake auth.user UUIDs (only ones safe to delete)
-- -----------------------------------------------------------------------------
-- A user_id is safe to delete only if it does NOT back a KEPT partner row.
create temp table _fake_user_ids (id uuid primary key) on commit drop;

-- 2a. user_ids of the fake partners themselves, IF they don't back a kept partner
insert into _fake_user_ids
select p.user_id
from public.partners p
join _fake_partner_ids f on f.id = p.id
where p.user_id is not null
  and p.user_id not in (
      select user_id from public.partners
      where id not in (select id from _fake_partner_ids)
        and user_id is not null
  );

-- 2b. auth.users matching smoketest patterns, with hard exclusions
insert into _fake_user_ids
select u.id
from auth.users u
where (u.email ilike '%@smoketest.dev'
    or u.email ilike 'smoketest-%@example.com'
    or u.email ilike 'helen-smoketest-%@%'
    or u.email ilike 'helen-test-%@%')
  and u.email not in ('zhongkennylin@gmail.com', 'davebacaywork@gmail.com')
  and u.id not in (select id from _fake_user_ids)
  and u.id not in (
      select user_id from public.partners
      where id not in (select id from _fake_partner_ids)
        and user_id is not null
  );

-- -----------------------------------------------------------------------------
-- 3. Show what we're about to delete
-- -----------------------------------------------------------------------------
do $$
declare
    n_partners int; n_users int;
begin
    select count(*) into n_partners from _fake_partner_ids;
    select count(*) into n_users    from _fake_user_ids;
    raise notice '[018] About to delete % fake partners + % fake auth.users', n_partners, n_users;
end $$;

-- -----------------------------------------------------------------------------
-- 4. Clear FK references that point AT the fake partners
-- -----------------------------------------------------------------------------
delete from public.partner_commissions
    where partner_id        in (select id from _fake_partner_ids)
       or source_partner_id in (select id from _fake_partner_ids);

delete from public.settlements
    where partner_id in (select id from _fake_partner_ids);

delete from public.mgc_tree
    where ancestor_id   in (select id from _fake_partner_ids)
       or descendant_id in (select id from _fake_partner_ids);

update public.partners
    set sponsor_partner_id = null
    where sponsor_partner_id in (select id from _fake_partner_ids);

update public.businesses
    set signed_up_by_partner_id = null
    where signed_up_by_partner_id in (select id from _fake_partner_ids);

update public.business_partners
    set sponsoring_partner_id = null
    where sponsoring_partner_id in (select id from _fake_partner_ids);

-- -----------------------------------------------------------------------------
-- 5. Delete the fake partner rows (partner_emails CASCADES)
-- -----------------------------------------------------------------------------
delete from public.partners where id in (select id from _fake_partner_ids);

-- -----------------------------------------------------------------------------
-- 6. Delete fake customers (wallets/transactions first — RESTRICT FK)
-- -----------------------------------------------------------------------------
create temp table _fake_customer_ids (id uuid primary key) on commit drop;
insert into _fake_customer_ids
    select id from public.customers where user_id in (select id from _fake_user_ids);

delete from public.transactions
    where wallet_id in (
        select id from public.wallets where customer_id in (select id from _fake_customer_ids)
    );

delete from public.wallets
    where customer_id in (select id from _fake_customer_ids);

delete from public.customers
    where id in (select id from _fake_customer_ids);

-- -----------------------------------------------------------------------------
-- 7. Delete fake businesses (merchants in the `businesses` table)
-- -----------------------------------------------------------------------------
create temp table _fake_business_ids (id uuid primary key) on commit drop;
insert into _fake_business_ids
    select id from public.businesses
    where owner_user_id in (select id from _fake_user_ids)
       or contact_email ilike '%@smoketest.dev'
       or contact_email ilike 'smoketest-%@example.com'
       or contact_email ilike 'helen-smoketest-%@%'
       or contact_email ilike 'helen-test-%@%'
       or display_name ilike '%smoketest%'
       or display_name ilike '%smoke test%'
       or legal_name  ilike '%smoketest%'
       or legal_name  ilike '%smoke test%';

delete from public.transactions
    where business_id in (select id from _fake_business_ids);

delete from public.wallets
    where business_id in (select id from _fake_business_ids);

delete from public.business_locations
    where business_id in (select id from _fake_business_ids);

delete from public.business_subscriptions
    where business_id in (select id from _fake_business_ids);

delete from public.businesses
    where id in (select id from _fake_business_ids);

-- -----------------------------------------------------------------------------
-- 8. Delete fake auth.users (signup_attributions, lymx_issuances,
--    contacts, partner_invites, referrals all CASCADE from auth.users)
-- -----------------------------------------------------------------------------
delete from auth.users where id in (select id from _fake_user_ids);

-- -----------------------------------------------------------------------------
-- 9. Final counts
-- -----------------------------------------------------------------------------
do $$
declare
    n_partners   int; n_businesses int; n_customers int; n_users int;
    n_wallets    int; n_txns       int;
begin
    select count(*) into n_partners   from public.partners;
    select count(*) into n_businesses from public.businesses;
    select count(*) into n_customers  from public.customers;
    select count(*) into n_users      from auth.users;
    select count(*) into n_wallets    from public.wallets;
    select count(*) into n_txns       from public.transactions;
    raise notice '[018] AFTER CLEANUP: % partners, % businesses, % customers, % auth.users, % wallets, % transactions',
        n_partners, n_businesses, n_customers, n_users, n_wallets, n_txns;
end $$;

commit;

-- =============================================================================
-- END OF MIGRATION 018
-- Next: continue with task #81 (customer ref tracking) + #82 (refer-a-friend widget)
-- =============================================================================
