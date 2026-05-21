-- Migration 067 â customers + partners + businesses self-insert RLS policies
--
-- Bug #812b1f13 + #20dafa0b (filed 2026-05-20 by Rae): "I'm unable to edit
-- my profile â¦ internal error and the updates are not applied â¦ the email
-- field is also missing."
--
-- Root cause: customers table had SELECT (self) + UPDATE (self) policies
-- but NO INSERT policy. When a user signs up via welcome.html they get an
-- auth row + lymx_issuances signup bonus, but no customers row is created
-- (wallets table is per-business and waits for first transaction). When
-- the user later visits profile.html and clicks Save, the page does an
-- UPSERT â which becomes an INSERT â and RLS blocks it.
--
-- Mirrors the migration 066 fix for team_calendars (#4c53cd0c). Same shape.
--
-- Also adding self-insert for partners + businesses defensively; the signup
-- Edge Functions use service_role and bypass RLS, but if those EFs are ever
-- bypassed (e.g. a self-serve partner upgrade button calls supabase-js
-- directly) the user-side path will work.
--
-- Apply via Supabase SQL editor.

drop policy if exists customers_self_insert on public.customers;
create policy customers_self_insert on public.customers
    for insert to authenticated
    with check (user_id = auth.uid());

drop policy if exists partners_self_insert on public.partners;
create policy partners_self_insert on public.partners
    for insert to authenticated
    with check (user_id = auth.uid());

drop policy if exists businesses_self_insert on public.businesses;
create policy businesses_self_insert on public.businesses
    for insert to authenticated
    with check (owner_user_id = auth.uid());
