-- =============================================================================
-- Migration 168 — HARD RULE: LYMX is non-transferable. No transfer / gift /
--                 donate / purchase. Issued & redeemed ONLY by the platform.
-- =============================================================================
-- Kenny, 2026-05-31. Canonical LYMX monetary model (see how-lymx-works.html +
-- disclaimer.html + ARCHITECTURE-RULES Rule 9):
--
--   * Only a participating BUSINESS acquires LYMX from the platform, at 80% of
--     face value, ONLY at the moment of a real customer transaction.
--   * Only a participating BUSINESS sells LYMX back to the platform, at the same
--     80%, ONLY from a customer redemption.
--   * LYMX is issued and redeemed ONLY by the LYMX platform.
--   * There is NO trading, gifting, purchasing, or peer-to-peer transfer of LYMX
--     by anyone, ever. LYMX is non-transferable between accounts (anti-fraud/AML).
--
-- This migration makes that rule STRUCTURAL at the database layer, so it holds
-- even against a SERVICE-ROLE writer (the deleted `transfer` edge function used
-- the service-role key and bypassed RLS — a CHECK constraint does not bypass).
--
-- Safe to apply: prod has 0 rows in public.transactions and 0 lymx_issuances
-- rows with reason='donation' (verified 2026-05-31), so tightening the
-- constraints cannot orphan existing data.
-- Idempotent.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Forbid customer-to-customer transfer rows on the transactions ledger.
--    transaction_type is an ENUM (transfer_in / transfer_out still defined for
--    historical compatibility) — we block them with a CHECK, which applies to
--    every writer including service-role.
-- -----------------------------------------------------------------------------
alter table public.transactions
    drop constraint if exists transactions_no_lymx_transfer;
alter table public.transactions
    add  constraint transactions_no_lymx_transfer
    check (type not in ('transfer_out','transfer_in'));

-- -----------------------------------------------------------------------------
-- 2. Remove 'donation' from the issuance ledger. Donating wallet LYMX (which
--    paid the nonprofit the USD equivalent) is a transfer + cash conversion and
--    is no longer permitted. Re-state the reason + amount-sign CHECKs without it.
--    (Mirror of migrations 107/160, minus 'donation'.)
-- -----------------------------------------------------------------------------
alter table public.lymx_issuances drop constraint if exists lymx_issuances_reason_check;
alter table public.lymx_issuances add constraint lymx_issuances_reason_check
    check (reason in (
        'signup_bonus','transaction','referral','manual','correction',
        'promo','review','redemption',
        'business_event'
    ));

alter table public.lymx_issuances drop constraint if exists lymx_issuances_amount_lymx_check;
alter table public.lymx_issuances add constraint lymx_issuances_amount_lymx_check
    check (
        (reason = 'redemption' and amount_lymx < 0)
        or (reason <> 'redemption' and amount_lymx > 0)
    );

-- -----------------------------------------------------------------------------
-- 3. Neutralize the donation RPC. Same signature (so PostgREST stays happy),
--    but it now refuses — donations are retired. Revoke execute as well.
-- -----------------------------------------------------------------------------
create or replace function public.fn_request_donation(
    p_nonprofit_id      uuid,
    p_lymx_amount       int,
    p_client_request_id text default null
) returns public.donations
language plpgsql
security definer
set search_path = public, pg_temp
as $fn_request_donation$
begin
    raise exception 'LYMX donations are retired. LYMX is non-transferable and is issued/redeemed only by the LYMX platform (see how-lymx-works).'
        using errcode = 'check_violation';
end;
$fn_request_donation$;

revoke all on function public.fn_request_donation(uuid, int, text) from public;
revoke execute on function public.fn_request_donation(uuid, int, text) from authenticated;

notify pgrst, 'reload schema';

do $s$ begin raise notice 'Migration 168 OK - LYMX transfer/gift/donate hard rule enforced.'; end$s$;
-- END migration 168
