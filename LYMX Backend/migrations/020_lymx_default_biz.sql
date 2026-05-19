-- =============================================================================
-- Migration 020 — Seed default 'lymx' business_partner for naked referral signups
-- Created: 2026-05-14
-- =============================================================================
-- Lets welcome.html?ref=<X> work without an explicit ?biz= param.
--
-- Use case: Partners share invite links like
--   https://getlymx.com/welcome.html?ref=<partner_id>
-- without picking a co-brand Business. We default bizSlug to 'lymx' so the
-- existing flow loads a 'lymx' co-brand and credits the referral bonus.
-- =============================================================================

insert into public.business_partners (
    slug, legal_name, display_name, contact_email,
    primary_color, signup_bonus_from_lymx, signup_bonus_from_biz,
    bonus_cents_per_lymx, max_signups_per_hour, require_admin_approval, active
) values (
    'lymx',
    'LYMX Power',
    'LYMX',
    'hello@getlymx.com',
    '#0a84ff',
    100,   -- LYMX gives 100 to the new signup (the welcome bonus)
    0,     -- No business co-bonus for naked LYMX signups
    1,
    500,   -- Higher velocity cap since this is the default path
    false,
    true
) on conflict (slug) do update set
    signup_bonus_from_lymx = excluded.signup_bonus_from_lymx,
    signup_bonus_from_biz  = excluded.signup_bonus_from_biz,
    active                 = excluded.active,
    display_name           = excluded.display_name;
