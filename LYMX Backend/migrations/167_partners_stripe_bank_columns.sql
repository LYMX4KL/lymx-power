-- 167_partners_stripe_bank_columns.sql
-- 2026-05-31 #a7fdf779 #0facf146 — partner-bank-update.html selects Stripe/bank
-- columns from public.partners that were never added, so the query errored
-- (42703 column does not exist), data came back null, and the page wrongly showed
-- "No Partner profile — not registered" AND returned early, leaving the
-- "Update via Stripe" button unwired (dead). Root cause = column drift; the
-- partner payout feature was wired in the UI before its columns existed.
-- Add the columns the page (and Stripe Connect payout flow) expect.
alter table public.partners
  add column if not exists stripe_connect_account_id text,
  add column if not exists payout_method            text,   -- 'stripe' | 'ach' | null
  add column if not exists bank_last4                text,
  add column if not exists bank_name                 text;

comment on column public.partners.stripe_connect_account_id is 'Stripe Connect acct id for ACH payouts (null until onboarded).';
