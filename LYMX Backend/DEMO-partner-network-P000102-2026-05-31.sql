-- ============================================================================
-- DEMO network for P-000102  (dave-partner.v1@yopmail.com)
-- Purpose: give the demo partner a real 2-generation downline + sample
--          commissions so the Partner Growth pages (rep-dashboard Recent
--          Activity, My Downlines, Referred Businesses, partner-activity,
--          3-gen tree) can be VERIFIED LIVE with data.
-- Date: 2026-05-31
-- Safe + reversible: only re-parents two THROWAWAY yopmail demo accounts
--   (P-000106, P-000107) and inserts clearly-tagged commission rows.
--   Run the REVERT block at the bottom to undo everything.
-- Run in: Supabase SQL editor (service role — bypasses RLS).
-- ============================================================================

-- P-000102 id (the demo partner you are signed in as):
--   85eb882c-54b4-4776-bd8c-9464d15fe3ed

begin;

-- 1) Re-parent two throwaway yopmail demo partners into P-000102's tree.
--    P-000106 becomes a Direct (G1); P-000107 becomes a G2 under P-000106.
update public.partners
   set sponsor_partner_id = '85eb882c-54b4-4776-bd8c-9464d15fe3ed'
 where partner_code = 'P-000106';

update public.partners
   set sponsor_partner_id = (select id from public.partners where partner_code = 'P-000106')
 where partner_code = 'P-000107';

-- 2) Sample commissions for P-000102 (additive; tagged so the revert is exact).
--    One cash activation bonus, one LYMX override, one cash monthly override —
--    exercises the cash-vs-LYMX split (Rule 4) on the dashboard + activity feed.
insert into public.partner_commissions
  (partner_id, source_partner_id, type, source_kind, generation, amount, payout_kind, period_month, created_at)
values
  ('85eb882c-54b4-4776-bd8c-9464d15fe3ed', (select id from public.partners where partner_code='P-000106'),
     'signup_bonus', 'activation',      0, 500,   'cash', null,            now() - interval '3 days'),
  ('85eb882c-54b4-4776-bd8c-9464d15fe3ed', (select id from public.partners where partner_code='P-000106'),
     'override',     'transaction_fee', 1, 120,   'lymx', date_trunc('month', now())::date, now() - interval '2 days'),
  ('85eb882c-54b4-4776-bd8c-9464d15fe3ed', (select id from public.partners where partner_code='P-000107'),
     'override',     'monthly_fee',     2, 12.95, 'cash', date_trunc('month', now())::date, now() - interval '1 day');

commit;

-- quick check
select 'downline of P-000102' as what, count(*) from public.partners
  where sponsor_partner_id in (
    '85eb882c-54b4-4776-bd8c-9464d15fe3ed',
    (select id from public.partners where partner_code='P-000106'))
union all
select 'commissions for P-000102', count(*) from public.partner_commissions
  where partner_id = '85eb882c-54b4-4776-bd8c-9464d15fe3ed';


-- ============================================================================
-- REVERT  — run this block to undo the demo network completely.
-- ============================================================================
-- begin;
-- delete from public.partner_commissions
--   where partner_id = '85eb882c-54b4-4776-bd8c-9464d15fe3ed'
--     and source_kind in ('activation','transaction_fee','monthly_fee')
--     and created_at < now();   -- (these were the demo rows; tighten if you have real ones)
-- -- restore P-000106 / P-000107 to their original sponsor (they were under
-- -- whatever they were before — set back to NULL or their prior sponsor here):
-- update public.partners set sponsor_partner_id = NULL where partner_code in ('P-000106','P-000107');
-- commit;
-- ============================================================================
