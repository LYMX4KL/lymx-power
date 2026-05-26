-- =============================================================================
-- Migration 013 — Customer LYMX balance helpers
-- =============================================================================
-- The 150-LYMX signup bonus from welcome.html?biz=<slug> needs to land in
-- a balance the customer can see. The existing wallets table is per-business
-- and requires a customers row (with NOT NULL phone) — too much ceremony for
-- the welcome.html signup, which only collects email + password.
--
-- For v1 we compute balance directly from lymx_issuances. The existing
-- per-business wallets table still works for everything else (in-store
-- transactions, redemptions). When a customer eventually transacts at a
-- physical business, the wallet model kicks in. For pre-transaction state
-- (signup bonus only), this view is the source of truth.
-- =============================================================================

-- View: total LYMX balance per auth user (signup bonuses minus redemptions)
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
where li.recipient_user_id = auth.uid()
   -- 2026-05-26: removed the OR Kenny-UUID bypass; migration 091 already
   -- removed it from the live view, here we keep the historical migration
   -- file in sync so re-deploying from scratch yields the correct shape.
group by li.recipient_user_id;

grant select on public.v_my_lymx_balance to authenticated;

-- RPC: get current user's available balance (callable from welcome flow + dashboard)
create or replace function public.get_my_lymx_balance()
returns int
language sql stable
as $$
  select coalesce(sum(amount_lymx), 0)::int
    from public.lymx_issuances
   where recipient_user_id = auth.uid()
     and admin_status in ('auto', 'approved')
$$;

grant execute on function public.get_my_lymx_balance() to authenticated;

-- RPC: credit_customer_wallet — the function business-signup-bonus calls.
-- For v1 this is a no-op confirmation (issuance is the source of truth via
-- the view above). Returns success so the Edge Function doesn't log errors.
-- When per-business wallets become the source of truth later, this RPC will
-- be reimplemented to actually mutate the wallets table.
create or replace function public.credit_customer_wallet(
    p_user_id     uuid,
    p_amount      int,
    p_reason      text default null,
    p_issuance_id uuid default null
) returns json
language plpgsql
security definer
as $$
declare
    new_balance int;
begin
    -- For v1: verify the issuance row exists (the actual credit lives there)
    if p_issuance_id is not null then
        if not exists (
            select 1 from public.lymx_issuances
             where id = p_issuance_id
               and recipient_user_id = p_user_id
               and admin_status in ('auto','approved')
        ) then
            return json_build_object(
                'success', false,
                'error', 'Issuance not found, not approved, or not yours'
            );
        end if;
    end if;

    -- Compute the new balance
    select coalesce(sum(amount_lymx), 0)::int into new_balance
      from public.lymx_issuances
     where recipient_user_id = p_user_id
       and admin_status in ('auto','approved');

    return json_build_object(
        'success', true,
        'user_id', p_user_id,
        'amount_credited', p_amount,
        'new_balance', new_balance,
        'reason', p_reason
    );
end;
$$;

grant execute on function public.credit_customer_wallet(uuid, int, text, uuid) to authenticated, service_role;

-- =============================================================================
-- End of migration 013
-- =============================================================================
