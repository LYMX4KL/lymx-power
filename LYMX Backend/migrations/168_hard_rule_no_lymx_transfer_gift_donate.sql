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
-- Enforced STRUCTURALLY at the DB layer, so it holds even against a SERVICE-ROLE
-- writer (the deleted `transfer` edge function used the service-role key and
-- bypassed RLS — a CHECK constraint does not bypass).
--
-- ROOT-CAUSE NOTE (v3, 2026-05-31): the gift/donate/transfer features are RETIRED.
-- Their only on-platform footprint is leftover test data from before launch:
-- a test donation (lymx_issuances reason='donation' + a donations row) and
-- (defensively) any transfer rows. We REVERSE + REMOVE that test data so the
-- ledgers conform, then add every constraint as VALID (fully enforced) — not
-- NOT VALID, and without grandfathering 'donation' in the CHECK. Balances stay
-- correct: lymx_issuances balances are computed from the ledger (deleting the
-- donation row restores the balance), and transfer effects on wallets.balance
-- are reversed explicitly before the rows are removed. The whole migration runs
-- in one transaction — if anything is unexpected it rolls back cleanly.
-- Idempotent.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Reverse + remove retired DONATION test data.
--    Donation balances are computed from the lymx_issuances ledger
--    (v_my_lymx_balance sums the rows), so removing the negative donation row
--    restores the donor's balance automatically. Delete the child donations
--    rows first (they FK the issuance), then the issuance rows.
-- -----------------------------------------------------------------------------
delete from public.donations;
delete from public.lymx_issuances where reason = 'donation';

-- -----------------------------------------------------------------------------
-- 2. Reverse + remove any TRANSFER rows on the transactions ledger.
--    The transfer EF updated wallets.balance directly, so undo those balance
--    effects before deleting the rows. (Pre-launch there should be none; these
--    statements are exact no-ops when there are zero transfer rows.)
-- -----------------------------------------------------------------------------
update public.wallets w
   set balance = w.balance + t.lymx_amount
  from public.transactions t
 where t.wallet_id = w.id and t.type = 'transfer_out';

update public.wallets w
   set balance = w.balance - t.lymx_amount
  from public.transactions t
 where t.wallet_id = w.id and t.type = 'transfer_in';

delete from public.transactions where type in ('transfer_out','transfer_in');

-- -----------------------------------------------------------------------------
-- 3. Now the ledgers conform — add the constraints VALID (fully enforced).
--    A CHECK applies to every writer, service-role included.
-- -----------------------------------------------------------------------------
alter table public.transactions
    drop constraint if exists transactions_no_lymx_transfer;
alter table public.transactions
    add  constraint transactions_no_lymx_transfer
    check (type not in ('transfer_out','transfer_in'));

alter table public.lymx_issuances drop constraint if exists lymx_issuances_reason_check;
alter table public.lymx_issuances add constraint lymx_issuances_reason_check
    check (reason in (
        'signup_bonus','transaction','referral','manual','correction',
        'promo','review','redemption','business_event'
    ));

alter table public.lymx_issuances drop constraint if exists lymx_issuances_amount_lymx_check;
alter table public.lymx_issuances add constraint lymx_issuances_amount_lymx_check
    check (
        (reason = 'redemption' and amount_lymx < 0)
        or (reason <> 'redemption' and amount_lymx > 0)
    );

-- -----------------------------------------------------------------------------
-- 4. Block the donation WRITE PATH. The donate flow went through this SECURITY
--    DEFINER RPC (the deleted donation-create EF called it). Same signature so
--    PostgREST stays happy; it now refuses, and EXECUTE is revoked.
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

commit;

notify pgrst, 'reload schema';

do $s$ begin raise notice 'Migration 168 OK - LYMX transfer/gift/donate hard rule enforced (validated).'; end$s$;
-- END migration 168
