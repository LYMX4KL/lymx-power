-- Migration 131: public partner directory (RLS + GRANT for anon)
-- 2026-05-28
--
-- Background:
-- Tickets #1f900a54 (Dave) "registered Partner not displayed in Partners
-- Directory" and #2632ad1d + #cf3523ac (Rae) "every directory card opens
-- Kenny's profile". Frontend fix shipped in commit 2941eb7: partners.html
-- now reads from public.partners, partner-profile.html accepts ?p=<code> and
-- renders that partner. But the live page hangs on "Partner directory is
-- loading…" because anon callers get 401 from /rest/v1/partners — the table
-- has no SELECT policy for anon and no GRANT.
--
-- Fix: add a row-level policy that lets anon (and authenticated) read
-- non-archived partners, and grant SELECT to anon at the table level so
-- PostgREST hands the request to the policy in the first place. Same
-- pattern migration 030 used for public.reviews and migration 033 used to
-- close the table-grant gap on the same row.
--
-- Side benefit: the per-partner-profile dynamic loader (also in commit
-- 2941eb7) now resolves a ?p=<code> link for any partner_code that exists
-- in the table; the previous behaviour was the "Example partner profile"
-- banner staying visible regardless of the URL.
--
-- What we expose to anon: partner_code, display_name, legal_name,
-- contact_email, country_code, is_founding_25, founding_25_rank,
-- avatar_url, archived_at, sponsor_partner_id (for the tree page).
-- We deliberately KEEP the table-level grant simple (full row SELECT) so
-- the existing partner-tree.html / partner-leaderboard.html anon-readable
-- queries keep working. Sensitive columns (Stripe IDs, tax IDs, internal
-- notes) are kept on a sibling table public.partners_private (added in a
-- prior migration) and are NOT in public.partners.

-- 1. Grant table-level SELECT to anon.
GRANT SELECT ON public.partners TO anon;

-- 2. Public-read policy for the directory + per-partner profile.
--    Filters out archived rows so deactivated partners disappear from the
--    public surface immediately when an admin sets archived_at.
DROP POLICY IF EXISTS partners_public_directory ON public.partners;
CREATE POLICY partners_public_directory
    ON public.partners
    FOR SELECT
    TO anon, authenticated
    USING (archived_at IS NULL);

-- 3. Same pattern for public.businesses so the per-partner profile can
--    list the businesses each partner signed up. The businesses table
--    already has a SECURITY DEFINER RPC (fn_biz_public_meta) for the
--    per-business pages, but listing-by-partner is a different shape and
--    deserves the simpler policy + grant path. Filters on archived_at
--    and approval_status='approved' so unapproved/draft businesses never
--    leak.
GRANT SELECT ON public.businesses TO anon;

DROP POLICY IF EXISTS businesses_public_directory ON public.businesses;
CREATE POLICY businesses_public_directory
    ON public.businesses
    FOR SELECT
    TO anon, authenticated
    USING (archived_at IS NULL AND approval_status = 'approved');

-- 4. Re-emit a comment on the columns we expect anon to actually use, so
--    a future schema audit can spot accidental new sensitive-column adds.
COMMENT ON COLUMN public.partners.contact_email IS
    'Public via partners_public_directory policy — partners opt-in to being
     contactable when they sign up. Keep this column free of private alt-emails.';

-- ----- Smoke test (run as anon manually after deploy) ----------------------
--   SET ROLE anon;
--   SELECT count(*) FROM public.partners WHERE archived_at IS NULL;
--   SELECT count(*) FROM public.businesses WHERE archived_at IS NULL AND approval_status = 'approved';
--   RESET ROLE;
