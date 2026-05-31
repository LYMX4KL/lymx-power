-- =============================================================================
-- Migration 152 — partners.bio (editable, shown on the public partner profile)
-- =============================================================================
-- partner-profile.html showed a generic placeholder line because partners had no
-- bio field. Add one; partners edit it on profile.html (partner_self_update RLS
-- already allows a partner to update their own row). Public profile reads it
-- (partner rows are readable by anon for the referral page). Plain text, capped
-- in the UI at 500 chars. Idempotent.
-- =============================================================================
alter table public.partners add column if not exists bio text;
comment on column public.partners.bio is 'Short partner-authored bio shown on their public profile (partner-profile.html).';
do $s$ begin raise notice 'Migration 152 OK - partners.bio added.'; end$s$;
-- END migration 152
