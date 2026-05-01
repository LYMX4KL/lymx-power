-- =============================================================================
-- LYMX Power — RLS Policies (Phase 1)
-- Created: 2026-05-01
-- Purpose: Who can read/write what. Pairs with 001_initial_schema.sql.
-- =============================================================================
--
-- HOW RLS WORKS (read me first — Kenny, this is for you):
-- ----------------------------------------------------------------------------
-- Postgres has Row Level Security: every query against a table runs through
-- a policy filter. If the policy says "true" for a row, the user sees it;
-- otherwise the row is invisible (as if it doesn't exist).
--
-- THREE roles to keep in mind:
--   1. anon         — anyone hitting the API without logging in (web visitors)
--   2. authenticated — logged-in users (customers, partners, business owners)
--   3. service_role — our backend code (Edge Functions, scripts). BYPASSES RLS.
--
-- Inside policies, `auth.uid()` returns the logged-in user's UUID, and `null`
-- if not logged in.
--
-- Default after migration 001: RLS is ON, NO policies = no one can read.
-- This file adds the policies that selectively open access.
-- =============================================================================


-- =============================================================================
-- HELPER FUNCTIONS — used inside policies
-- =============================================================================

-- Is the current user the owner of a given business?
create or replace function public.is_business_owner(b_id uuid)
returns boolean language sql security definer stable as $$
    select exists (
        select 1 from public.businesses
        where id = b_id and owner_user_id = auth.uid()
    );
$$;

-- Get the partner_id for the current user (or null)
create or replace function public.current_partner_id()
returns uuid language sql security definer stable as $$
    select id from public.partners where user_id = auth.uid() limit 1;
$$;

-- Get the customer_id for the current user (or null)
create or replace function public.current_customer_id()
returns uuid language sql security definer stable as $$
    select id from public.customers where user_id = auth.uid() limit 1;
$$;


-- =============================================================================
-- ORGANIZATIONS
-- =============================================================================
-- Chain owners see/modify their own organization rows.
create policy "org_owner_full_access" on public.organizations
    for all to authenticated
    using (owner_user_id = auth.uid())
    with check (owner_user_id = auth.uid());


-- =============================================================================
-- BUSINESSES
-- =============================================================================
-- Owner full access.
create policy "biz_owner_full_access" on public.businesses
    for all to authenticated
    using (owner_user_id = auth.uid())
    with check (owner_user_id = auth.uid());

-- PUBLIC read of basic display fields (name, category) so the customer-facing
-- "find a business" feature works without login. We do this via a view in 003,
-- not by opening the businesses table itself.


-- =============================================================================
-- BUSINESS_LOCATIONS
-- =============================================================================
-- Owners of the parent business get full access to their locations.
create policy "biz_loc_owner_full_access" on public.business_locations
    for all to authenticated
    using (public.is_business_owner(business_id))
    with check (public.is_business_owner(business_id));


-- =============================================================================
-- PARTNERS
-- =============================================================================
-- A partner can read & update their own partner row.
create policy "partner_self_read" on public.partners
    for select to authenticated
    using (user_id = auth.uid());

create policy "partner_self_update" on public.partners
    for update to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

-- A partner can read partners in their downline (so they can see their tree).
create policy "partner_downline_read" on public.partners
    for select to authenticated
    using (
        exists (
            select 1 from public.mgc_tree t
            where t.descendant_id = partners.id
              and t.ancestor_id = public.current_partner_id()
        )
    );


-- =============================================================================
-- CUSTOMERS
-- =============================================================================
-- A customer can read & update their own row.
create policy "customer_self_read" on public.customers
    for select to authenticated
    using (user_id = auth.uid());

create policy "customer_self_update" on public.customers
    for update to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

-- A business owner can see customers who have a wallet at their business
-- (needed for "your customers" dashboard view).
create policy "customer_visible_to_biz_owner" on public.customers
    for select to authenticated
    using (
        exists (
            select 1 from public.wallets w
            join public.businesses b on b.id = w.business_id
            where w.customer_id = customers.id
              and b.owner_user_id = auth.uid()
        )
    );


-- =============================================================================
-- WALLETS
-- =============================================================================
-- A customer sees their own wallets.
create policy "wallet_customer_read" on public.wallets
    for select to authenticated
    using (customer_id = public.current_customer_id());

-- A business owner sees all wallets at their business.
create policy "wallet_biz_owner_read" on public.wallets
    for select to authenticated
    using (public.is_business_owner(business_id));

-- Inserts/updates only via service_role (backend logic). No authenticated
-- user should be writing wallet balances directly; that goes through Edge
-- Functions which use service_role and bypass RLS.


-- =============================================================================
-- TRANSACTIONS
-- =============================================================================
-- A customer sees transactions on their wallets.
create policy "tx_customer_read" on public.transactions
    for select to authenticated
    using (
        wallet_id in (
            select id from public.wallets
            where customer_id = public.current_customer_id()
        )
    );

-- A business owner sees transactions at their business.
create policy "tx_biz_owner_read" on public.transactions
    for select to authenticated
    using (public.is_business_owner(business_id));

-- Writes go through service_role (Edge Functions) only. Append-only ledger.


-- =============================================================================
-- MGC_TREE
-- =============================================================================
-- A partner sees rows where they are either ancestor or descendant.
create policy "tree_partner_read" on public.mgc_tree
    for select to authenticated
    using (
        ancestor_id = public.current_partner_id()
        or descendant_id = public.current_partner_id()
    );

-- Writes via service_role only (tree edits are a privileged backend op).


-- =============================================================================
-- BUSINESS_SUBSCRIPTIONS
-- =============================================================================
-- Business owner sees their own subscription.
create policy "subs_biz_owner_read" on public.business_subscriptions
    for select to authenticated
    using (public.is_business_owner(business_id));

-- Writes via service_role only (billing logic).


-- =============================================================================
-- PARTNER_COMMISSIONS
-- =============================================================================
-- Partner sees their own commissions.
create policy "comm_partner_read" on public.partner_commissions
    for select to authenticated
    using (partner_id = public.current_partner_id());

-- Writes via service_role only (computed by settlement job).


-- =============================================================================
-- SETTLEMENTS
-- =============================================================================
-- Partner sees their own settlement batches.
create policy "settle_partner_read" on public.settlements
    for select to authenticated
    using (partner_id = public.current_partner_id());

-- Writes via service_role only (weekly cron job).


-- =============================================================================
-- GRANT permissions on helper functions to authenticated users
-- =============================================================================
grant execute on function public.is_business_owner(uuid) to authenticated;
grant execute on function public.current_partner_id() to authenticated;
grant execute on function public.current_customer_id() to authenticated;


-- =============================================================================
-- END OF MIGRATION 002
-- Next: 003_views.sql — public views for unauthenticated reads (find-a-biz)
-- =============================================================================
