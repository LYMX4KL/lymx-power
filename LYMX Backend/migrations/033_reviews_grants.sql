-- Migration 033: GRANT SELECT/INSERT on reviews + saved_businesses
-- ---------------------------------------------------------------------------
-- Found during end-to-end test 2026-05-16: anonymous biz-page visitors got
-- "permission denied for table reviews" even though the RLS policy allowed
-- public read. Reason: PostgREST / Supabase auth roles need both a GRANT
-- on the table AND an RLS policy that passes. Without the GRANT, the
-- request is rejected before RLS even runs.
--
-- This migration adds the missing GRANTs. Already-applied inline 2026-05-16
-- but saved here for repo history / re-runs.
-- ---------------------------------------------------------------------------

GRANT SELECT                          ON public.reviews          TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE  ON public.reviews          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE  ON public.saved_businesses TO authenticated;

SELECT 'migration 033 applied' AS status,
       has_table_privilege('anon', 'public.reviews', 'SELECT')   AS anon_can_select_reviews,
       has_table_privilege('authenticated', 'public.reviews', 'INSERT') AS auth_can_insert_reviews;
