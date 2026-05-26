-- 091_v_my_lymx_balance_remove_hardcoded_admin_uuid.sql
-- 2026-05-25 — Root-cause fix: customer-dashboard.html shows "0 LYMX BALANCE"
-- for Kenny even though he has 600 LYMX in issuances.
--
-- The view v_my_lymx_balance (created in migration 013) had a hardcoded admin
-- bypass:
--
--   where li.recipient_user_id = auth.uid()
--      or auth.uid() = '1405bb50-2c97-48dd-bfa5-31f32320de9b'::uuid  -- Kenny
--
-- When Kenny queried the view, the OR clause matched EVERY row in the table
-- (24 rows across all users). The customer-dashboard reads it via .maybeSingle()
-- which expects 0 or 1 rows — 24 rows means it returns null silently, and the
-- dashboard renders "0 LYMX" + "Sign up via a LYMX business invite for a welcome
-- bonus" placeholder copy. Kenny saw the bug on his own dashboard for weeks.
--
-- This is exactly the "special-case the tester's UUID" band-aid Kenny's
-- architecture rules forbid (ARCHITECTURE-RULES.md Rule 0). The view is called
-- v_MY_lymx_balance — it should ONLY return the current user's balance, never
-- anyone else's.
--
-- Fix: drop the hardcoded UUID. Admin tools that need cross-user balance
-- visibility should query lymx_issuances directly (admin role has full read
-- access via leads_admin_all pattern) or use a separate admin-scoped view.

create or replace view public.v_my_lymx_balance as
select
    li.recipient_user_id                as user_id,
    coalesce(sum(li.amount_lymx) filter (where li.reason in ('signup_bonus','transaction','referral','manual','promo','correction')), 0)::int as bonus_lymx,
    coalesce(sum(li.amount_lymx) filter (where li.admin_status = 'pending_review'), 0)::int as pending_lymx,
    coalesce(sum(li.amount_lymx) filter (where li.admin_status in ('auto','approved')), 0)::int as available_lymx,
    count(*) filter (where li.reason = 'signup_bonus')::int as signup_bonus_count,
    min(li.created_at)                  as first_issued_at,
    max(li.created_at)                  as last_issued_at
from public.lymx_issuances li
where li.recipient_user_id = auth.uid()  -- single-user only; admin bypass removed
group by li.recipient_user_id;

grant select on public.v_my_lymx_balance to authenticated;

-- Sanity check: confirm the new view definition no longer references the
-- hardcoded admin UUID. (pg_views.definition surfaces the resolved view SQL.)
do $check$
declare
    def text;
begin
    select view_definition into def
      from information_schema.views
     where table_schema = 'public' and table_name = 'v_my_lymx_balance';
    if def is null then
        raise exception 'Migration 091 incomplete: v_my_lymx_balance not found after re-create';
    end if;
    if position('1405bb50-2c97-48dd-bfa5-31f32320de9b' in def) > 0 then
        raise exception 'Migration 091 incomplete: hardcoded admin UUID still in view definition';
    end if;
end $check$;
