-- =============================================================================
-- Migration 160 — allow reason='business_event' on the issuance ledger
-- =============================================================================
-- The Business Integration API earn endpoint (business-event EF) credits LYMX
-- through public.lymx_issuances. The ledger's reason CHECK (migs 098/107) did
-- not include a value for these inbound business earn events, so the insert
-- failed with lymx_issuances_reason_check. We use ONE fixed reason
-- ('business_event'); the specific catalog event_type is recorded in
-- public.business_events (linked by issuance_id), keeping the ledger's reason
-- domain closed/enumerable. Earn rows are positive, so the amount-sign CHECK
-- (positive for non-redemption/donation reasons) already covers them.
-- =============================================================================
alter table public.lymx_issuances drop constraint if exists lymx_issuances_reason_check;
alter table public.lymx_issuances add constraint lymx_issuances_reason_check
    check (reason in (
        'signup_bonus','transaction','referral','manual','correction',
        'promo','review','redemption','donation',
        'business_event'   -- new: inbound earn from the Business Integration API
    ));

-- Refresh PostgREST's schema cache so the regenerate_business_api_key() RPC
-- added in migration 159 becomes callable over REST immediately.
notify pgrst, 'reload schema';
